import { io, type ManagerOptions, type SocketOptions, type Socket } from 'socket.io-client';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { roomBytes, type SocketRoomClientEvents, type SocketRoomServerEvents } from './protocol';

export type SocketRoomStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'destroyed';
export interface SocketRoomOptions {
  /** Optional external resources. Only resources created by this provider are destroyed. */
  document?: Y.Doc;
  awareness?: Awareness;
  socketOptions?: Partial<ManagerOptions & SocketOptions>;
  /** Timeout of a synchronization attempt; transient timeouts retry. Default 10000 ms. */
  syncTimeout?: number;
  autoConnect?: boolean;
  onError?: (error: Error) => void;
}
export interface SocketRoomProvider {
  readonly roomId: string;
  readonly document: Y.Doc;
  readonly awareness: Awareness;
  readonly socket: Socket<SocketRoomServerEvents, SocketRoomClientEvents>;
  /** First successful room synchronization, not merely an open connection. */
  readonly whenSynced: Promise<void>;
  readonly status: SocketRoomStatus;
  readonly error: Error | null;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

/** Creates a dedicated Socket.IO connection. Call in an effect and destroy on leaving the room. */
export function connectSocketRoom(
  url: string,
  roomId: string,
  options: SocketRoomOptions = {},
): SocketRoomProvider {
  if (!roomId || roomId.length > 256) throw new Error('roomId must contain 1–256 characters');
  const document = options.document ?? options.awareness?.doc ?? new Y.Doc();
  if (document.isDestroyed) throw new Error('Cannot connect a destroyed document');
  if (options.awareness && options.awareness.doc !== document)
    throw new Error('Awareness must belong to the same document');
  const timeout = options.syncTimeout ?? 10000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('syncTimeout must be positive');
  const awareness = options.awareness ?? new Awareness(document);
  const ownDocument = !options.document && !options.awareness;
  const ownAwareness = !options.awareness;
  const socket: Socket<SocketRoomServerEvents, SocketRoomClientEvents> = io(url, {
    ...options.socketOptions,
    autoConnect: false,
  });
  const remote = {};
  const listeners = new Set<() => void>();
  let status: SocketRoomStatus = 'disconnected';
  let error: Error | null = null;
  let destroyed = false;
  let joined = false;
  let suspended: Record<string, unknown> | null = null;
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const whenSynced = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // An effect can be discarded before React has subscribed to this promise.
  void whenSynced.catch(() => undefined);
  const notify = (next: SocketRoomStatus, problem: Error | null = null) => {
    status = next;
    error = problem;
    for (const listener of listeners) listener();
  };
  const report = (value: unknown, terminal = false) => {
    if (destroyed) return;
    const problem = value instanceof Error ? value : new Error(String(value));
    notify(terminal ? 'error' : 'connecting', problem);
    if (terminal) {
      joined = false;
      reject(problem);
      socket.disconnect();
    }
    options.onError?.(problem);
  };
  const forgetPeers = () =>
    removeAwarenessStates(
      awareness,
      [...awareness.getStates().keys()].filter((id) => id !== document.clientID),
      remote,
    );
  const sendDocument = (update: Uint8Array, origin: unknown) => {
    if (joined && socket.connected && origin !== remote) socket.emit('apeiro:update', update);
  };
  const sendAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (
      joined &&
      socket.connected &&
      origin !== remote &&
      [...added, ...updated, ...removed].includes(document.clientID)
    ) {
      socket.emit('apeiro:awareness', encodeAwarenessUpdate(awareness, [document.clientID]));
    }
  };
  const receiveDocument = (update: unknown) => {
    if (destroyed) return;
    try {
      Y.applyUpdate(document, roomBytes(update), remote);
    } catch (problem) {
      report(problem, true);
    }
  };
  const receiveAwareness = (update: unknown) => {
    if (destroyed) return;
    try {
      applyAwarenessUpdate(awareness, roomBytes(update), remote);
    } catch (problem) {
      report(problem, true);
    }
  };
  const synchronize = () => {
    if (destroyed || !socket.connected) return;
    clearTimeout(retry);
    joined = false;
    const attempt = ++generation;
    notify('connecting');
    socket.timeout(timeout).emit(
      'apeiro:sync',
      {
        roomId,
        clientId: document.clientID,
        update: Y.encodeStateAsUpdate(document),
      },
      (problem, snapshot) => {
        if (destroyed || attempt !== generation || !socket.connected) return;
        if (problem) {
          report(problem);
          retry = setTimeout(synchronize, Math.min(timeout, 1000));
          return;
        }
        if (!snapshot?.ok) {
          report(new Error(snapshot?.error ?? 'Invalid room snapshot'), true);
          return;
        }
        try {
          Y.applyUpdate(document, roomBytes(snapshot.update), remote);
          // Existing remote reservations get priority over this client's expired claims.
          // Local observers may adjust their state while the server snapshot is applied.
          const local = suspended ?? awareness.getLocalState();
          if (local !== null) awareness.setLocalState(null);
          applyAwarenessUpdate(awareness, roomBytes(snapshot.awareness), remote);
          if (local !== null) awareness.setLocalState({ ...local, ...awareness.getLocalState() });
          suspended = null;
          joined = true;
          // Include edits made offline or while the initial snapshot was in flight.
          socket.emit('apeiro:update', Y.encodeStateAsUpdate(document));
          const state = awareness.getLocalState();
          if (state !== null) awareness.setLocalState(state); // Fresh clock after a disconnect.
          else
            socket.emit('apeiro:awareness', encodeAwarenessUpdate(awareness, [document.clientID]));
          notify('connected');
          resolve();
        } catch (failure) {
          report(failure, true);
        }
      },
    );
  };
  const disconnected = () => {
    joined = false;
    generation++;
    clearTimeout(retry);
    suspended = awareness.getLocalState() ?? suspended;
    awareness.setLocalState(null);
    forgetPeers();
    if (!destroyed && status !== 'error') notify('disconnected');
  };
  const connectionError = (problem: Error) => report(problem, !socket.active);
  const serverError = (message: string) => report(new Error(message), true);
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    joined = false;
    generation++;
    clearTimeout(retry);
    document.off('update', sendDocument);
    document.off('destroy', destroy);
    awareness.off('update', sendAwareness);
    socket.removeAllListeners();
    socket.disconnect();
    forgetPeers();
    if (ownAwareness) awareness.destroy();
    if (ownDocument && !document.isDestroyed) document.destroy();
    reject(new Error('Socket room destroyed before synchronization'));
    notify('destroyed');
    listeners.clear();
  };
  document.on('update', sendDocument);
  document.on('destroy', destroy);
  awareness.on('update', sendAwareness);
  socket.on('connect', synchronize);
  socket.on('disconnect', disconnected);
  socket.on('connect_error', connectionError);
  socket.on('apeiro:update', receiveDocument);
  socket.on('apeiro:awareness', receiveAwareness);
  socket.on('apeiro:error', serverError);
  const provider: SocketRoomProvider = {
    roomId,
    document,
    awareness,
    socket,
    whenSynced,
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy,
  };
  if (options.autoConnect !== false) {
    notify('connecting');
    socket.connect();
  }
  return provider;
}
