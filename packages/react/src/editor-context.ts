import type { BoardElement } from '@apeiro/core';
import { BoardEditor, type BoardEditorOptions } from '@apeiro/editor';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

/** What `<BoardProvider>` hands down: its editor and where errors of the board go. */
export interface BoardContextValue {
  editor: BoardEditor;
  /** The provider's `onError`, or the console. */
  reportError: (error: unknown) => void;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

/** Options of the editor a `<BoardProvider>` (or a standalone `<Board>`) creates. */
export interface EditorOptions extends BoardEditorOptions {
  /**
   * What the new board shows at first (plain element data, e.g. loaded from your storage).
   * Not an undo step. Read once, when the editor is created, like the other options.
   */
  initialElements?: readonly BoardElement[];
}

/** Components using an owned editor; it is destroyed when the last one unmounts. */
const users = new WeakMap<BoardEditor, number>();

function retain(editor: BoardEditor): void {
  users.set(editor, (users.get(editor) ?? 0) + 1);
}

function release(editor: BoardEditor): void {
  users.set(editor, (users.get(editor) ?? 1) - 1);
  // Deferred: React's StrictMode unmounts and remounts effects right away in development.
  setTimeout(() => {
    if ((users.get(editor) ?? 0) <= 0) editor.destroy();
  }, 0);
}

function createEditor(
  { initialElements, ...options }: EditorOptions,
  latest: { readonly current: EditorOptions | null },
): BoardEditor {
  // Callbacks (`upload`, `openLink`, `onComment`…) call the latest ones passed, so inline
  // functions that use the component's state stay current.
  const wrapped: Record<string, unknown> = { ...options };
  for (const [key, first] of Object.entries(options)) {
    if (typeof first !== 'function') continue;
    wrapped[key] = (...args: unknown[]) => {
      const now = (latest.current as Record<string, unknown> | null)?.[key];
      return (typeof now === 'function' ? now : first)(...args) as unknown;
    };
  }
  const editor = new BoardEditor(wrapped as BoardEditorOptions);
  if (initialElements && initialElements.length > 0) editor.load(initialElements);
  return editor;
}

/**
 * An editor created on the first render when `options` is not null, and destroyed when
 * the component unmounts. Null when created without options (an editor comes from elsewhere).
 */
export function useOwnedEditor(
  options: EditorOptions | null,
  /** Options the caller applies itself when they change (not reported as ignored). */
  live: ReadonlySet<string> = NONE,
): BoardEditor | null {
  const latest = useRef(options);
  latest.current = options;
  const [editor] = useState(() => (options ? createEditor(options, latest) : null));
  useEffect(() => {
    if (!editor) return;
    retain(editor);
    return () => release(editor);
  }, [editor]);
  useIgnoredOptionsWarning(editor ? options : null, live);
  return editor;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Warns once per option when a plain value (string, number, boolean) the editor was created
 * with changes later: options are read once, so the change has no effect. Callbacks and
 * objects are skipped, since inline ones are new on every render.
 */
function useIgnoredOptionsWarning(options: EditorOptions | null, live: ReadonlySet<string>): void {
  const first = useRef<Record<string, unknown> | null>(null);
  const warned = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!options) return;
    if (!first.current) {
      first.current = { ...options };
      return;
    }
    const was = first.current;
    const now = options as Record<string, unknown>;
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (live.has(key) || Object.is(was[key], now[key])) continue;
      const plain = (value: unknown) =>
        value === undefined || (typeof value !== 'object' && typeof value !== 'function');
      if (!plain(was[key]) || !plain(now[key])) continue;
      const seen = (warned.current ??= new Set());
      if (seen.has(key)) continue;
      seen.add(key);
      console.warn(
        `apeiro: the \`${key}\` option changed after the board was created and is ignored ` +
          '(options are read once). Recreate the board with a new `key`, or use the editor API.',
      );
    }
  });
}

/**
 * The low-level `BoardEditor` of the surrounding board: the scene, the camera, the renderer,
 * and everything `useBoard()` doesn't cover. Never re-renders
 * by itself; read changing state with `useBoardState` or the other hooks.
 */
export function useEditor(): BoardEditor {
  return useBoardContext().editor;
}

/** The surrounding provider's context; throws outside one. */
export function useBoardContext(): BoardContextValue {
  const context = useContext(BoardContext);
  if (!context)
    throw new Error(
      'apeiro: board hooks (useBoard, useBoardState, useTool…) must be used inside <Board> or <BoardProvider>',
    );
  return context;
}

export const noSubscribe = () => () => undefined;

/**
 * False on the server and while hydrating, true once rendering in the browser (React then
 * re-renders with true right after hydration). For UI that must exist only in the browser.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}
