import type { BoardElement } from '@apeiro/core';
import type { BoardCollaboration, BoardCollaborationConnection } from '@apeiro/editor';
import type { PresenceAwareness, PresenceUser } from '../yjs/presence';
import { configKey } from '../collaboration/key';

/** Structural Y.Doc contract: importing React types does not require installing Yjs. */
export interface CollaborationDocument {
  readonly clientID: number;
  readonly isDestroyed: boolean;
  getMap(name?: string): unknown;
  transact(callback: () => void, origin?: unknown): unknown;
  destroy(): void;
}

export type CollaborationStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'destroyed';
interface CollaborationSettings {
  name?: string;
  user?: PresenceUser;
  showPresence?: boolean;
  initialElements?: readonly BoardElement[];
  onError?: (error: unknown) => void;
}

export interface SocketCollaborationOptions extends CollaborationSettings {
  url: string;
  roomId: string;
  document?: CollaborationDocument;
  awareness?: PresenceAwareness & { readonly doc: CollaborationDocument };
  /** Socket.IO client configuration (auth, path, transports, reconnection, etc.). */
  socketOptions?: object;
  syncTimeout?: number;
  onStatusChange?: (status: CollaborationStatus, error: Error | null) => void;
}

/** Use an existing Yjs document/provider without creating a network connection. */
export interface DocumentCollaborationOptions extends CollaborationSettings {
  document: CollaborationDocument;
  awareness?: PresenceAwareness;
  whenSynced?: PromiseLike<unknown>;
}

export type CollaborationOptions = SocketCollaborationOptions | DocumentCollaborationOptions;

interface Session {
  options: CollaborationOptions;
  apply(): void;
}
const sessions = new WeakMap<BoardCollaborationConnection, Session>();

/** Normalize plain options without opening connections or importing optional dependencies. */
export function collaborationAdapter(
  options: CollaborationOptions | BoardCollaboration | undefined,
): BoardCollaboration | undefined {
  if (!options) return undefined;
  if ('connect' in options) return options;
  const socket = 'url' in options;
  return {
    key: [
      collaborationAdapter,
      socket,
      options.document,
      options.awareness,
      options.name ?? 'apeiro',
      ...(socket
        ? [
            options.url,
            options.roomId,
            options.syncTimeout ?? 10000,
            ...configKey(options.socketOptions ?? {}),
          ]
        : [options.whenSynced]),
    ],
    connect(board, onError) {
      let live = options;
      let active = true;
      let inner: BoardCollaborationConnection | undefined;
      let factory: ((settings: CollaborationOptions) => BoardCollaboration) | undefined;
      const connection: BoardCollaborationConnection = {
        ready: (async () => {
          try {
            if (socket) {
              const module = await import('../socket.io');
              factory = (settings) =>
                module.socketIO(settings as Parameters<typeof module.socketIO>[0]);
            } else {
              const module = await import('../yjs');
              factory = (settings) => module.yjs(settings as Parameters<typeof module.yjs>[0]);
            }
          } catch (error) {
            if (active) live.onError?.(error);
            throw error;
          }
          if (!active) return;
          inner = factory(live).connect(board, onError);
          await inner.ready;
        })(),
        destroy() {
          if (!active) return;
          active = false;
          offDestroy();
          inner?.destroy();
          sessions.delete(connection);
        },
      };
      const offDestroy = board.on('destroy', connection.destroy);
      void Promise.resolve(connection.ready).catch(() => undefined);
      sessions.set(connection, {
        get options() {
          return live;
        },
        set options(next) {
          live = next;
        },
        apply() {
          if (inner && factory) factory(live).update?.(inner);
        },
      });
      return connection;
    },
    update(connection) {
      const session = sessions.get(connection);
      if (!session) return;
      session.options = options;
      session.apply();
    },
  };
}
