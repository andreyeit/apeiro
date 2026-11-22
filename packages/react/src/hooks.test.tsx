// @vitest-environment happy-dom
import type { Box, ShapeElement } from '@apeiro/core';
import { BoardEditor } from '@apeiro/editor';
import { act, Component, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import {
  Board,
  BoardProvider,
  useBoard,
  useBoardState,
  useBoardTheme,
  useClipboard,
  useElement,
  useFloating,
  useHistory,
  useSelectedElements,
  useTextEditing,
  useTool,
  useZoomPercent,
  type BoardOptions,
  type ClipboardState,
} from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rectangle = (id: string, x = 0): ShapeElement => ({
  id,
  type: 'rect',
  x,
  y: 0,
  width: 10,
  height: 10,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
});

let container: HTMLDivElement;
let root: Root;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // React logs the errors the tests provoke.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const render = async (node: ReactNode) => {
  await act(async () => root.render(node));
};

/** Catches what its children throw while rendering. */
class Catch extends Component<{ children: ReactNode; onError: (error: unknown) => void }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Renders `node` and returns the message of what it throws. */
const renderError = async (node: ReactNode): Promise<string> => {
  let thrown: unknown;
  await act(async () => root.render(<Catch onError={(caught) => (thrown = caught)}>{node}</Catch>));
  return String(thrown);
};

/** The board of a provider, for the test to drive. */
function Grab({ into }: { into: { board?: BoardEditor } }) {
  into.board = useBoard();
  return null;
}

async function provide(children: ReactNode, config: BoardOptions = {}) {
  const handle: { board?: BoardEditor } = {};
  await render(
    <BoardProvider config={config}>
      <Grab into={handle} />
      {children}
    </BoardProvider>,
  );
  return handle.board!;
}

describe('components', () => {
  test('a hook outside a board says where it belongs', async () => {
    function Lonely() {
      useTool();
      return null;
    }
    expect(await renderError(<Lonely />)).toMatch(/must be used inside <Board> or <BoardProvider>/);
  });

  test('a renderer that cannot start: one onError, the error fallback, no children', async () => {
    const onError = vi.fn();
    await render(
      <Board
        config={{ onError }}
        fallback={<span id="fallback" />}
        errorFallback={(failure) => <span id="failed">{String(failure).slice(0, 20)}</span>}
      >
        <span id="toolbar" />
      </Board>,
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(container.querySelector('#failed')).not.toBeNull();
    expect(container.querySelector('#fallback')).toBeNull();
    expect(container.querySelector('#toolbar')).toBeNull();
  });

  test('onReady of the config gets the board once it runs', async () => {
    const editor = new BoardEditor();
    vi.spyOn(editor, 'mount').mockResolvedValue();
    vi.spyOn(BoardEditor.prototype, 'isMounted', 'get').mockReturnValue(true);
    const onReady = vi.fn();
    await render(
      <BoardProvider editor={editor} config={{ onReady }}>
        <Board />
      </BoardProvider>,
    );
    expect(onReady).toHaveBeenCalledWith(editor);
    editor.destroy();
  });

  test('inline config: callbacks stay current, creation options warn, theme and readOnly apply', async () => {
    const seen: string[] = [];
    let setLabel!: (label: string) => void;
    const handle: { board?: BoardEditor } = {};
    function App({ options }: { options: BoardOptions }) {
      const [label, set] = useState('first');
      setLabel = set;
      return (
        <BoardProvider
          config={{
            ...options,
            initialElements: [rectangle('a')],
            onChange: () => seen.push(label),
          }}
        >
          <Grab into={handle} />
        </BoardProvider>
      );
    }
    await render(<App options={{ grid: 'dots', theme: 'light' }} />);
    await act(async () => setLabel('second'));
    await act(async () => handle.board!.elements.update(['a'], { x: 5 }));
    expect(seen).toEqual(['second']);
    expect(warn).not.toHaveBeenCalled();
    await render(<App options={{ grid: 'lines', theme: 'dark', readOnly: true }} />);
    expect(handle.board!.theme).toBe('dark');
    expect(handle.board!.readOnly).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/`grid` option changed/);
  });

  test('`editor` is passed for the whole lifetime or never', async () => {
    expect(await renderError(<BoardProvider />)).toBe('undefined');
    expect(await renderError(<BoardProvider editor={new BoardEditor()} />)).toMatch(
      /whole lifetime/,
    );
  });
});

describe('the board object', () => {
  test('useBoard is the editor: stable, with commands that work detached', async () => {
    const boards = new Set<BoardEditor>();
    let rerender!: () => void;
    function Read() {
      const [, set] = useState(0);
      rerender = () => set((count) => count + 1);
      boards.add(useBoard());
      return null;
    }
    const board = await provide(<Read />);
    await act(async () => rerender());
    expect(boards).toEqual(new Set([board]));
    const { create } = board.elements;
    const { undo } = board.history;
    const id = create('rect')!;
    undo();
    expect(board.scene.has(id)).toBe(false);
  });

  test("theme is the config's: useBoardTheme reads the resolved one", async () => {
    let theme = '';
    function Read() {
      theme = useBoardTheme();
      return null;
    }
    await provide(<Read />, { theme: 'dark' });
    expect(theme).toBe('dark');
  });
});

describe('state hooks', () => {
  const elements = Array.from({ length: 50 }, (_, index) => rectangle(`e${index}`, index * 20));

  test('re-render only for what they read', async () => {
    const renders: Record<string, number> = {};
    const counter = (name: string, use: () => unknown) =>
      function Counter() {
        use();
        renders[name] = (renders[name] ?? 0) + 1;
        return null;
      };
    const components = [
      counter('size', () => useBoardState((board) => board.scene.size)),
      counter('stickies', () =>
        useBoardState((board) =>
          board.elements.getAll().filter((element) => element.type === 'sticky'),
        ),
      ),
      counter('zoom', () => useZoomPercent()),
      counter('selected', () => useSelectedElements()),
      counter('other', () => useElement('e1')),
      counter('moving', () => useElement('e0')),
      counter('history', () => useHistory()),
    ];
    const board = await provide(
      components.map((Component, index) => <Component key={index} />),
      { initialElements: elements },
    );
    await act(async () => board.selection.set(['e1']));
    for (const key of Object.keys(renders)) renders[key] = 0;
    for (let step = 1; step <= 10; step++)
      await act(async () => board.elements.update(['e0'], { x: step }));
    expect(renders).toEqual({
      size: 0,
      stickies: 0,
      zoom: 0,
      selected: 0,
      other: 0,
      moving: 10,
      history: 1,
    });
  });

  test('selectors follow the groups: tool defaults, history, camera', async () => {
    let read = { pen: 0, canUndo: false, zoom: 0 };
    function Read() {
      read = useBoardState((board) => ({
        pen: board.tools.getDefaults('pen').stroke,
        canUndo: board.history.canUndo,
        zoom: board.camera.zoom,
      }));
      return null;
    }
    const board = await provide(<Read />);
    await act(async () => board.tools.setDefaults('pen', { stroke: 0xff0000ff }));
    expect(read.pen).toBe(0xff0000ff);
    await act(async () => void board.elements.create('rect'));
    expect(read.canUndo).toBe(true);
    await act(async () => board.setReadOnly(true));
    expect(read.canUndo).toBe(false);
    await act(async () => board.camera.set({ zoom: 0.5 }));
    expect(read.zoom).toBe(0.5);
  });

  test('a selector reading a board from a closure warns once; one reading nothing does not', async () => {
    const id: string | null = null;
    function Closure() {
      const board = useBoard();
      useBoardState(() => board.selection.ids.length);
      return null;
    }
    function Nothing() {
      useBoardState((board) => (id ? board.scene.get(id) : undefined));
      return null;
    }
    const board = await provide(
      <>
        <Closure />
        <Nothing />
      </>,
      { initialElements: elements },
    );
    await act(async () => board.selection.set(['e1']));
    await act(async () => board.selection.set(['e1', 'e2']));
    await act(async () => board.elements.update(['e3'], { x: 1 }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/from its argument/);
  });

  test('useHistory and useClipboard: state only, the same object until it changes', async () => {
    const histories = new Set<object>();
    let clipboard: ClipboardState | null = null;
    function Read() {
      histories.add(useHistory());
      clipboard = useClipboard();
      return null;
    }
    const board = await provide(<Read />, { initialElements: [rectangle('a')] });
    await act(async () => board.camera.set({ x: 5 }));
    expect(histories.size).toBe(1);
    expect(clipboard).toEqual({ canCopy: false, canCut: false, canPaste: true, hasCopy: false });
    await act(async () => board.selection.set(['a']));
    await act(async () => void board.clipboard.copy());
    expect(clipboard).toEqual({ canCopy: true, canCut: true, canPaste: true, hasCopy: true });
  });

  test('useTextEditing is null while no text is edited', async () => {
    let editing: unknown = 'unset';
    function Read() {
      editing = useTextEditing();
      return null;
    }
    await provide(<Read />);
    expect(editing).toBeNull();
  });
});

describe('useFloating', () => {
  beforeEach(() => {
    // happy-dom has no layout: sizes come from data attributes.
    const size = (name: string) => ({
      configurable: true,
      get(this: HTMLElement) {
        return Number(this.dataset[name] ?? 0);
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', size('width'));
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', size('height'));
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', size('width'));
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', size('height'));
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) {
        return this.parentElement;
      },
    });
  });
  afterEach(() => {
    for (const property of [
      'offsetWidth',
      'offsetHeight',
      'clientWidth',
      'clientHeight',
      'offsetParent',
    ])
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
  });

  const place = async (anchor: Box | null) => {
    function Toolbar() {
      const floating = useFloating(anchor);
      return (
        <div
          id="toolbar"
          ref={floating.ref}
          style={floating.style}
          data-width="100"
          data-height="40"
        />
      );
    }
    await render(
      <div data-width="500" data-height="300">
        <Toolbar />
      </div>,
    );
    const element = container.querySelector<HTMLElement>('#toolbar')!;
    return { left: element.style.left, top: element.style.top, display: element.style.display };
  };

  test('centered above the anchor, below without room, inside the board', async () => {
    expect(await place({ minX: 200, minY: 100, maxX: 300, maxY: 150 })).toMatchObject({
      left: '200px',
      top: '48px',
    });
    expect(await place({ minX: 0, minY: 20, maxX: 40, maxY: 60 })).toMatchObject({
      left: '8px',
      top: '72px',
    });
    expect(await place(null)).toMatchObject({ display: 'none' });
  });
});
