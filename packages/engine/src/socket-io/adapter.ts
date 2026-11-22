import { configKey } from '../collaboration/key';
import type { BoardCollaboration, BoardCollaborationConnection } from '@apeiro/editor';
import { yjs, type YjsCollaborationOptions } from '../yjs/adapter';
import { connectSocketRoom, type SocketRoomOptions, type SocketRoomStatus } from './provider';

export interface SocketIOOptions
  extends
    Omit<YjsCollaborationOptions, 'document' | 'awareness' | 'whenSynced'>,
    Omit<SocketRoomOptions, 'autoConnect' | 'onError'> {
  url: string;
  roomId: string;
  /** Connection UI is optional; no resource management is needed in the application. */
  onStatusChange?: (status: SocketRoomStatus, error: Error | null) => void;
}

interface Session {
  options: SocketIOOptions;
  adapter: BoardCollaboration;
  binding: BoardCollaborationConnection;
  provider: ReturnType<typeof connectSocketRoom>;
}
const sessions = new WeakMap<BoardCollaborationConnection, Session>();

/** Declarative, lifecycle-owned Socket.IO collaboration. Safe to create inline in React. */
export function socketIO(options: SocketIOOptions): BoardCollaboration {
  const bindingOptions = (
    provider: Session['provider'],
    live: SocketIOOptions,
  ): YjsCollaborationOptions => ({
    ...live,
    document: provider.document,
    awareness: provider.awareness,
    whenSynced: provider.whenSynced,
  });
  return {
    key: [
      socketIO,
      options.url,
      options.roomId,
      options.document,
      options.awareness,
      options.name ?? 'apeiro',
      options.syncTimeout ?? 10000,
      ...configKey(options.socketOptions ?? {}),
    ],
    connect(board, reportError) {
      let live = options;
      let synced = false;
      const provider = connectSocketRoom(options.url, options.roomId, {
        ...options,
        autoConnect: false,
        onError: (error) => {
          // Initial terminal failures travel through ready/errorFallback exactly once.
          if (!synced && provider.status === 'error') return;
          (live.onError ?? reportError)(error);
        },
      });
      let binding: BoardCollaborationConnection;
      const adapter = yjs(bindingOptions(provider, options));
      try {
        binding = adapter.connect(board, reportError);
      } catch (error) {
        provider.destroy();
        throw error;
      }
      const unsubscribe = provider.subscribe(() =>
        live.onStatusChange?.(provider.status, provider.error),
      );
      let active = true;
      const connection: BoardCollaborationConnection = {
        ready: Promise.resolve(binding.ready).then(
          () => {
            synced = true;
          },
          (error: unknown) => {
            if (active) live.onError?.(error);
            throw error;
          },
        ),
        destroy() {
          if (!active) return;
          active = false;
          unsubscribe();
          offDestroy();
          binding.destroy();
          provider.destroy();
          sessions.delete(connection);
        },
      };
      const offDestroy = board.on('destroy', connection.destroy);
      // A connection can be discarded before its owner subscribes to initial sync.
      void Promise.resolve(connection.ready).catch(() => undefined);
      sessions.set(connection, {
        get options() {
          return live;
        },
        set options(next) {
          live = next;
        },
        adapter,
        binding,
        provider,
      });
      try {
        live.onStatusChange?.('connecting', null);
        provider.socket.connect();
      } catch (error) {
        connection.destroy();
        throw error;
      }
      return connection;
    },
    update(connection) {
      const session = sessions.get(connection);
      if (!session) return;
      session.options = options;
      session.adapter = yjs(bindingOptions(session.provider, options));
      session.adapter.update?.(session.binding);
    },
  };
}
