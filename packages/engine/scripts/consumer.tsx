// Compiled against a copy of the built package, without workspace aliases.
import { BoardEditor, Scene, rgba, type BoardElement } from 'apeiro';
import {
  Board,
  BoardProvider,
  boardOptions,
  useEditor,
  useElement,
  useBoard,
  useBoardState,
  useHistory,
  type BoardApi,
  type BoardProps,
  type BoardOptions,
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
editor.load([element]);

const config = boardOptions({
  initialElements: [element],
  onChange(elements, changes) {
    localStorage.setItem('board-example', JSON.stringify({ elements, changes }));
  },
});
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

export function StandaloneBoard(props: BoardProps) {
  return <Board {...props} config={darkConfig} onReady={(e) => e.zoomTo('fit')} />;
}

function Toolbar() {
  const board: BoardApi = useBoard();
  const { canUndo } = useHistory();
  void board.exportImage({ scale: 1 });
  board.elements.remove(['example']);
  const tool = useBoardState((state) => state.tool);
  board.tools.getDefaults('rect');
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
  const board = useEditor();
  const element = useElement('example');
  return (
    <span>
      {element?.id} ({board.scene.size})
    </span>
  );
}
