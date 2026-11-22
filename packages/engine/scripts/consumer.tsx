// Compiled against a copy of the built package, without workspace aliases.
import { BoardEditor, Scene, rgba, type BoardElement } from 'apeiro';
import {
  bindYjs,
  type YjsOptions,
  type YjsBinding,
  type YjsCollaborationOptions,
} from 'apeiro/yjs';
import * as Y from 'yjs';
import { socketIO, type SocketIOOptions } from 'apeiro/socket.io';
import { attachSocketRooms, type SocketRoomsServer } from 'apeiro/socket.io/server';
import type { Server } from 'socket.io';

export function socketConsumer(io: Server) {
  const server: SocketRoomsServer = attachSocketRooms(io, { authorize: () => true });
  const options = {
    url: 'http://localhost:3001',
    roomId: 'example',
    document: new Y.Doc(),
    user: { name: 'Alice', color: '#2563eb' },
    socketOptions: { auth: { token: 'example' } },
  } satisfies SocketIOOptions;
  const collaboration = socketIO(options);
  server.destroy();
  return collaboration;
}

export function collaborationConsumer(board: BoardEditor) {
  const sharedDocument = new Y.Doc();
  const options = { document: sharedDocument } satisfies YjsOptions;
  const binding: YjsBinding = bindYjs(board, options);
  binding.setUser({ name: 'Alice', color: '#2563eb' });
  binding.destroy();
  sharedDocument.destroy();
}
import {
  Board,
  BoardProvider,
  useBoard,
  useBoardState,
  useElement,
  useFloating,
  useHistory,
  useTextEditing,
  type BoardOptions,
  type BoardProps,
} from 'apeiro/react';

const element: BoardElement = {
  id: 'example',
  type: 'rect',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  z: 0,
  fill: rgba(255, 255, 255),
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
};
const editor = new BoardEditor({ scene: new Scene() });
editor.elements.load([element]);

const config = {
  camera: { zoomStep: 1.1, wheelZoomSensitivity: 0.5, minZoom: 0.1, maxZoom: 8 },
  initialElements: [element],
  onChange(elements, changes) {
    localStorage.setItem('board-example', JSON.stringify({ elements, changes }));
  },
} satisfies BoardOptions;
const darkConfig: BoardOptions = { ...config, theme: 'dark', readOnly: true };

export function OwnedBoard() {
  return (
    <BoardProvider editor={editor} config={config}>
      <Board style={{ height: 400 }}>
        <Status />
      </Board>
    </BoardProvider>
  );
}

export function ComposedBoard() {
  return (
    <BoardProvider config={{ initialElements: [element], theme: 'system' }}>
      <Toolbar />
      <Board style={{ height: 400 }} fallback="Loading…" />
    </BoardProvider>
  );
}

export function CollaborativeBoard(options: YjsCollaborationOptions) {
  return (
    <Board
      collaboration={options}
      fallback="Syncing…"
      errorFallback={String}
      style={{ height: 400 }}
    >
      <Toolbar />
    </Board>
  );
}

export function SocketBoard(options: SocketIOOptions) {
  return <Board config={{ grid: 'dots' }} collaboration={options} style={{ height: 400 }} />;
}

export function StandaloneBoard(props: BoardProps) {
  return (
    <Board
      {...props}
      config={{ ...darkConfig, onReady: (board) => board.camera.zoomTo('fit') }}
      errorFallback={(error) => String(error)}
    />
  );
}

function Toolbar() {
  const board: BoardEditor = useBoard();
  const { canUndo } = useHistory();
  const editing = useTextEditing();
  const floating = useFloating(editing?.bounds);
  void floating.style;
  void board.exportImage({ scale: 1 });
  board.elements.remove(['example']);
  const tool = useBoardState((state) => state.tools.current);
  const fill: number = board.tools.getDefaults('rect').fill;
  void fill;
  return (
    <button
      disabled={!canUndo}
      aria-pressed={tool === 'rect'}
      onClick={() => {
        board.tools.setDefaults('rect', { fill: rgba(255, 0, 0) });
        board.tools.activate('rect', { repeat: true });
      }}
    >
      Rectangle
    </button>
  );
}

function Status() {
  const board = useBoard();
  const element = useElement('example');
  return (
    <span>
      {element?.id} ({board.scene.size})
    </span>
  );
}
