import console from 'node:console';
import process from 'node:process';
import { Server } from 'socket.io';
import { attachSocketRooms } from 'apeiro/socket.io/server';

const port = Number(process.env.APEIRO_SOCKET_PORT ?? 3001);
const io = new Server(port);
const rooms = attachSocketRooms(io);
console.log(`Apeiro collaboration server listening on http://localhost:${port}`);

function shutdown() {
  rooms.destroy();
  void io.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
