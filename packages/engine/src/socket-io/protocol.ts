/** Binary values accepted by Socket.IO in browsers and Node. */
export type SocketRoomBinary = Uint8Array | ArrayBuffer;
export interface SocketRoomSync {
  roomId: string;
  clientId: number;
  update: SocketRoomBinary;
}
export type SocketRoomSnapshot =
  | { ok: true; update: SocketRoomBinary; awareness: SocketRoomBinary }
  | { ok: false; error: string };
export interface SocketRoomClientEvents {
  'apeiro:sync': (request: SocketRoomSync, reply: (snapshot: SocketRoomSnapshot) => void) => void;
  'apeiro:update': (update: SocketRoomBinary) => void;
  'apeiro:awareness': (update: SocketRoomBinary) => void;
}
export interface SocketRoomServerEvents {
  'apeiro:update': (update: SocketRoomBinary) => void;
  'apeiro:awareness': (update: SocketRoomBinary) => void;
  'apeiro:error': (message: string) => void;
}
export function roomBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('Expected a binary Yjs update');
}
