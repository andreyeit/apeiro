/** Optional Socket.IO collaboration: pass socketIO(config) to BoardProvider. */
export { socketIO, type SocketIOOptions } from './socket-io/adapter';
export type { SocketRoomStatus as SocketIOStatus } from './socket-io/provider';
export type {
  SocketRoomBinary,
  SocketRoomClientEvents,
  SocketRoomServerEvents,
  SocketRoomSync,
  SocketRoomSnapshot,
} from './socket-io/protocol';
