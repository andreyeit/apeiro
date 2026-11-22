import type { Server, Socket } from 'socket.io';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import { roomBytes, type SocketRoomSync, type SocketRoomSnapshot } from './protocol';

export interface SocketRoomsOptions {
  /** Called before the socket is allowed to read or modify this room. */
  authorize?: (socket: Socket, roomId: string) => boolean | Promise<boolean>;
  /** Restore a persisted Yjs snapshot before admitting any clients. */
  load?: (roomId: string) => Uint8Array | undefined | Promise<Uint8Array | undefined>;
  /** Persist incremental updates. Persistence is application-owned. */
  onUpdate?: (roomId: string, update: Uint8Array) => void | Promise<void>;
  onError?: (error: unknown) => void;
}
export interface SocketRoomsServer {
  getDocument(roomId: string): Y.Doc | undefined;
  /** Removes this adapter's handlers and documents; leaves the Socket.IO server running. */
  destroy(): void;
}
interface Room {
  document: Y.Doc;
  awareness: Awareness;
  owners: Map<number, string>;
}
const channel = (roomId: string) => `apeiro:${roomId}`;

/** Attach the protocol used by socketIO() to an existing Socket.IO server. */
export function attachSocketRooms(io: Server, options: SocketRoomsOptions = {}): SocketRoomsServer {
  const rooms = new Map<string, Room>();
  const loading = new Map<string, Promise<Room>>();
  const connections = new Set<() => void>();
  let destroyed = false;
  const report = (error: unknown) => (options.onError ?? console.error)(error);
  const roomFor = (roomId: string): Promise<Room> => {
    const existing = rooms.get(roomId);
    if (existing) return Promise.resolve(existing);
    let pending = loading.get(roomId);
    if (!pending) {
      pending = (async () => {
        const snapshot = await options.load?.(roomId);
        if (destroyed) throw new Error('Socket rooms server was destroyed');
        const document = new Y.Doc();
        try {
          if (snapshot) Y.applyUpdate(document, snapshot);
        } catch (error) {
          document.destroy();
          throw error;
        }
        const awareness = new Awareness(document);
        awareness.setLocalState(null);
        const room: Room = { document, awareness, owners: new Map() };
        document.on('update', (update: Uint8Array, origin: unknown) => {
          const target =
            origin &&
            typeof origin === 'object' &&
            'to' in origin &&
            typeof origin.to === 'function'
              ? (origin as Socket).to(channel(roomId))
              : io.to(channel(roomId));
          target.emit('apeiro:update', update);
          try {
            Promise.resolve(options.onUpdate?.(roomId, update)).catch(report);
          } catch (error) {
            report(error);
          }
        });
        awareness.on(
          'update',
          ({
            added,
            updated,
            removed,
          }: {
            added: number[];
            updated: number[];
            removed: number[];
          }) => {
            io.to(channel(roomId)).emit(
              'apeiro:awareness',
              encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]),
            );
          },
        );
        rooms.set(roomId, room);
        return room;
      })().finally(() => loading.delete(roomId));
      loading.set(roomId, pending);
    }
    return pending;
  };
  const connected = (socket: Socket) => {
    let room: Room | undefined;
    let roomId: string | undefined;
    let clientId: number | undefined;
    let closed = false;
    const sync = async (request: SocketRoomSync, reply: (snapshot: SocketRoomSnapshot) => void) => {
      if (typeof reply !== 'function' || closed || destroyed) return;
      try {
        if (
          !request ||
          typeof request.roomId !== 'string' ||
          !request.roomId ||
          request.roomId.length > 256 ||
          !Number.isInteger(request.clientId) ||
          request.clientId < 0 ||
          request.clientId > 0xffffffff
        )
          throw new Error('Invalid room synchronization request');
        if (roomId !== undefined && (roomId !== request.roomId || clientId !== request.clientId))
          throw new Error('Use a dedicated socket for each room and document');
        roomId = request.roomId;
        clientId = request.clientId;
        if (options.authorize && !(await options.authorize(socket, request.roomId)))
          throw new Error('Room access denied');
        const target = await roomFor(request.roomId);
        if (closed || destroyed || !socket.connected) return;
        const owner = target.owners.get(request.clientId);
        if (owner && owner !== socket.id)
          throw new Error('This document client is already connected');
        await socket.join(channel(request.roomId));
        if (closed || destroyed || !socket.connected) return;
        // A second sync can finish its join while this one is awaiting the adapter.
        const joinedOwner = target.owners.get(request.clientId);
        if (joinedOwner && joinedOwner !== socket.id) {
          await socket.leave(channel(request.roomId));
          throw new Error('This document client is already connected');
        }
        room = target;
        roomId = request.roomId;
        clientId = request.clientId;
        target.owners.set(clientId, socket.id);
        Y.applyUpdate(target.document, roomBytes(request.update), socket);
        reply({
          ok: true,
          update: Y.encodeStateAsUpdate(target.document),
          awareness: encodeAwarenessUpdate(target.awareness, [
            ...target.awareness.getStates().keys(),
          ]),
        });
      } catch (error) {
        if (!closed && !destroyed)
          reply({
            ok: false,
            error: error instanceof Error ? error.message : 'Room synchronization failed',
          });
      }
    };
    const update = (data: unknown) => {
      if (!room || closed || destroyed) return;
      try {
        Y.applyUpdate(room.document, roomBytes(data), socket);
      } catch (error) {
        socket.emit('apeiro:error', 'Invalid document update');
        report(error);
      }
    };
    const presence = (data: unknown) => {
      if (!room || clientId === undefined || closed || destroyed) return;
      try {
        const bytes = roomBytes(data);
        const decoder = decoding.createDecoder(bytes);
        if (decoding.readVarUint(decoder) !== 1 || decoding.readVarUint(decoder) !== clientId)
          throw new Error('Awareness must describe this socket client');
        decoding.readVarUint(decoder);
        const state: unknown = JSON.parse(decoding.readVarString(decoder));
        if (
          decoding.hasContent(decoder) ||
          (state !== null && (typeof state !== 'object' || Array.isArray(state)))
        )
          throw new Error('Invalid awareness state');
        applyAwarenessUpdate(room.awareness, bytes, socket);
      } catch (error) {
        socket.emit('apeiro:error', 'Invalid awareness update');
        report(error);
      }
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      socket.off('apeiro:sync', sync);
      socket.off('apeiro:update', update);
      socket.off('apeiro:awareness', presence);
      socket.off('disconnect', cleanup);
      if (room && clientId !== undefined && room.owners.get(clientId) === socket.id) {
        room.owners.delete(clientId);
        removeAwarenessStates(room.awareness, [clientId], socket);
      }
      if (roomId) void socket.leave(channel(roomId));
      connections.delete(cleanup);
    };
    connections.add(cleanup);
    socket.on('apeiro:sync', sync);
    socket.on('apeiro:update', update);
    socket.on('apeiro:awareness', presence);
    socket.on('disconnect', cleanup);
  };
  io.on('connection', connected);
  return {
    getDocument: (roomId) => rooms.get(roomId)?.document,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      io.off('connection', connected);
      for (const cleanup of [...connections]) cleanup();
      for (const room of rooms.values()) {
        room.awareness.destroy();
        room.document.destroy();
      }
      rooms.clear();
    },
  };
}
