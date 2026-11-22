import type { BoardElement } from '@apeiro/core';
import type { BoardEditor, Tool } from '@apeiro/editor';
import {
  Board,
  BoardProvider,
  useBoard,
  useEditor,
  useHistory,
  useTool,
  useZoom,
  type BoardTheme,
} from '@apeiro/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TextToolbar } from './TextToolbar';

type Backend = 'auto' | 'webgpu' | 'webgl';

const STORAGE_KEY = 'apeiro-playground';
const params = new URLSearchParams(location.search);

function loadSaved(): BoardElement[] | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? (JSON.parse(saved) as unknown[]).map(renameOldFields) : null;
  } catch {
    return null;
  }
}

/**
 * Boards saved before fields were written out in full: `w`/`h` (on elements and on an
 * image's `crop`) are now `width`/`height`, and `media.src` is `media.source`.
 */
function renameOldFields(raw: unknown): BoardElement {
  type Fields = Record<string, unknown>;
  const renameSize = (fields: Fields): Fields => {
    if (!('w' in fields) || 'width' in fields) return fields;
    const { w: width, h: height, ...rest } = fields;
    return { ...rest, width, height };
  };
  const element = renameSize(raw as Fields);
  const crop = element.crop as Fields | undefined;
  if (crop) element.crop = renameSize(crop);
  const media = element.media as Fields | undefined;
  if (media && 'src' in media && !('source' in media)) {
    const { src: source, ...rest } = media;
    element.media = { ...rest, source };
  }
  return element as unknown as BoardElement;
}

/** Saves the board a moment after it stops changing. */
function useSave(): (elements: BoardElement[]) => void {
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback((elements: BoardElement[]) => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(elements));
      } catch {
        // storage full or blocked: the board still works
      }
    }, 300);
  }, []);
}

export function App() {
  const [theme, setTheme] = useState<BoardTheme>(
    (params.get('theme') as BoardTheme | null) ?? 'light',
  );
  const [backend, setBackend] = useState<Backend>(
    (params.get('renderer') as Backend | null) ?? 'auto',
  );
  const initialElements = useMemo(() => loadSaved() ?? [], []);
  const save = useSave();

  useEffect(() => {
    params.set('theme', theme);
    params.set('renderer', backend);
    history.replaceState(null, '', `?${params}`);
  }, [theme, backend]);

  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <div className={dark ? 'app dark' : 'app'}>
      {/* The renderer backend is a creation option: a new key makes a new board. */}
      <BoardProvider key={backend} config={{ backend, theme, initialElements, onChange: save }}>
        <Board
          className="board"
          fallback={<div className="fallback">Загрузка…</div>}
          onReady={(editor) => {
            (window as unknown as { __board: BoardEditor }).__board = editor;
            if (initialElements.length === 0 && editor.getElements().length === 0) demo(editor);
          }}
        >
          <TextToolbar />
        </Board>
        <Tools />
        <Panel theme={theme} setTheme={setTheme} backend={backend} setBackend={setBackend} />
      </BoardProvider>
    </div>
  );
}

function demo(editor: BoardEditor): void {
  const center = editor.viewCenter();
  editor.place('sticky', { x: center.x - 260, y: center.y - 130 });
  editor.place('rect', { x: center.x, y: center.y - 130 });
  editor.place('ellipse', { x: center.x + 260, y: center.y - 130 });
  editor.place('polygon', { x: center.x, y: center.y + 130 });
  editor.stopEditing();
  editor.clearSelection();
}

const TOOLS: Array<[Tool, string]> = [
  ['select', 'Выбор'],
  ['hand', 'Рука'],
  ['sticky', 'Стикер'],
  ['rect', 'Прямоугольник'],
  ['ellipse', 'Эллипс'],
  ['polygon', 'Многоугольник'],
  ['connector', 'Связь'],
  ['text', 'Текст'],
  ['pen', 'Перо'],
  ['eraser', 'Ластик'],
];

function Tools() {
  const [tool, setTool] = useTool();
  const { canUndo, canRedo, undo, redo } = useHistory();
  return (
    <div className="bar tools">
      {TOOLS.map(([id, label]) => (
        <button key={id} className={tool === id ? 'active' : ''} onClick={() => setTool(id)}>
          {label}
        </button>
      ))}
      <span className="sep" />
      <button disabled={!canUndo} onClick={undo} title="Отменить (Ctrl+Z)">
        ↶
      </button>
      <button disabled={!canRedo} onClick={redo} title="Повторить (Ctrl+Shift+Z)">
        ↷
      </button>
    </div>
  );
}

interface PanelProps {
  theme: BoardTheme;
  setTheme: (theme: BoardTheme) => void;
  backend: Backend;
  setBackend: (backend: Backend) => void;
}

function Panel({ theme, setTheme, backend, setBackend }: PanelProps) {
  const editor = useEditor();
  const board = useBoard();
  const { percent } = useZoom();
  return (
    <div className="bar panel">
      <select value={theme} onChange={(event) => setTheme(event.target.value as BoardTheme)}>
        <option value="light">Светлая</option>
        <option value="dark">Тёмная</option>
        <option value="system">Системная</option>
      </select>
      <select value={backend} onChange={(event) => setBackend(event.target.value as Backend)}>
        <option value="auto">auto</option>
        <option value="webgpu">WebGPU</option>
        <option value="webgl">WebGL</option>
      </select>
      <button onClick={() => board.camera.zoomTo('out')}>−</button>
      <button className="zoom" onClick={() => board.camera.zoomTo('fit')} title="Показать всё">
        {percent}%
      </button>
      <button onClick={() => board.camera.zoomTo('in')}>+</button>
      <button onClick={() => demo(editor)}>Демо</button>
      <button onClick={() => board.elements.load([])}>Очистить</button>
      <Stats />
    </div>
  );
}

/** Backend, frames per second and drawn elements, once a second. */
function Stats() {
  const editor = useEditor();
  const [text, setText] = useState('');
  useEffect(() => {
    let last = editor.renderer?.stats.frames ?? 0;
    const timer = setInterval(() => {
      const renderer = editor.renderer;
      if (!renderer) return;
      const frames = renderer.stats.frames;
      setText(`${renderer.backend} · ${frames - last} кадр/с · ${renderer.stats.instances} эл.`);
      last = frames;
    }, 1000);
    return () => clearInterval(timer);
  }, [editor]);
  return <span className="stats">{text}</span>;
}
