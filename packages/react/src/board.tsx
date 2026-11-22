import type { BoardElement } from '@apeiro/core';
import type { BoardEditor, BoardThemeName } from '@apeiro/editor';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useChangeListener, type BoardChanges } from './changes';
import {
  BoardContext,
  noSubscribe,
  useIsClient,
  useOwnedEditor,
  type BoardContextValue,
  type EditorOptions,
} from './editor-context';

/** `'system'` follows the color scheme of the user's OS (`prefers-color-scheme`). */
export type BoardTheme = BoardThemeName | 'system';

/**
 * Everything a board is, in one object: its content, settings and callbacks. Passed as
 * `config` to `<Board>` or `<BoardProvider>`; define it once with `boardOptions` (e.g. in a
 * module of its own) or inline.
 *
 * `theme`, `readOnly` and the callbacks can change at any time. The other options
 * (`initialElements`, `grid`, `backend`…) are read once, when the board is created;
 * changing one later logs a warning (give the component a new `key` to start over).
 */
export interface BoardOptions extends Omit<EditorOptions, 'onError' | 'theme' | 'readOnly'> {
  /** Light or dark drawing of the board, or `'system'`. Never changes stored colors. */
  theme?: BoardTheme;
  /** A viewer's board: nothing can be changed (see `readOnly` of `BoardEditor`). */
  readOnly?: boolean;
  /**
   * The board's content changed (by the user, undo, `load`…): all its elements, e.g. to
   * save them, and what changed (`changes`), e.g. to save or send only that. Changes made
   * together (one event handler, `batch`…) are reported once, a drag, resize or pen stroke
   * once when it ends; changes of different origins (this user, undo…) in separate calls.
   * Not called for `initialElements`.
   */
  onChange?: (elements: BoardElement[], changes: BoardChanges) => void;
  /** The renderer couldn't start (no WebGPU or WebGL2), or a file could not be added. */
  onError?: (error: unknown) => void;
}

/**
 * Defines a board's config: returns `options` as they are, typed (like `queryOptions` of
 * TanStack Query). Share one between components, or extend it: `{ ...options, readOnly }`.
 *
 * ```ts
 * export const boardConfig = boardOptions({
 *   theme: 'system',
 *   grid: 'dots',
 *   onChange: (elements) => save(elements),
 * });
 * ```
 */
export function boardOptions(options: BoardOptions): BoardOptions {
  return options;
}

/** How the board's canvas is shown on the page. */
export interface BoardViewProps {
  className?: string;
  style?: CSSProperties;
  /**
   * Your UI over the board (toolbars, menus, comment pins). Positioned against the board's
   * box; children receive pointer events, the empty space passes them to the board.
   */
  children?: ReactNode;
  /**
   * Shown in the board's box until the board runs: on the server, while hydrating and
   * until the GPU renderer has started (e.g. a spinner). Nothing by default.
   */
  fallback?: ReactNode;
  /** The renderer started. */
  onReady?: (editor: BoardEditor) => void;
}

export interface BoardProviderProps {
  /** The board: content, settings and callbacks (see `boardOptions`). */
  config?: BoardOptions;
  /**
   * Show this editor instead of creating one (it is then not destroyed on unmount, and
   * its creation options are its own; `theme`, `readOnly`, `onChange` and `onError` of
   * `config` still apply).
   */
  editor?: BoardEditor;
  children?: ReactNode;
}

/**
 * Props of `<Board>`. Without a provider `<Board>` creates its board from `config`; under
 * a `<BoardProvider>` the provider's board is shown (passing `config` here logs a warning).
 */
export interface BoardProps extends BoardViewProps {
  /** The board: content, settings and callbacks (see `boardOptions`). */
  config?: BoardOptions;
}

const NO_OPTIONS: BoardOptions = Object.freeze({});

const darkScheme = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

const subscribeScheme = (onChange: () => void) => {
  const query = darkScheme();
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};

/** The theme to draw: `theme`, or the OS color scheme for `'system'` (light on the server). */
function useResolvedTheme(theme: BoardTheme | undefined): BoardThemeName | undefined {
  const dark = useSyncExternalStore(
    theme === 'system' ? subscribeScheme : noSubscribe,
    () => theme === 'system' && !!darkScheme()?.matches,
    () => false,
  );
  return theme === 'system' ? (dark ? 'dark' : 'light') : theme;
}

/** Options the provider applies itself when they change (not reported as ignored). */
const LIVE_OPTIONS: ReadonlySet<string> = new Set(['theme', 'readOnly']);

const consoleError = (error: unknown) => console.error('apeiro:', error);

/**
 * Owns a board: creates its editor from `config` (or shows `editor`) and makes it
 * available to everything below: `<Board>` (the canvas) and the hooks, so toolbars and
 * panels can live anywhere around the canvas.
 *
 * ```tsx
 * <BoardProvider config={{ initialElements: saved, onChange: save, theme: 'system' }}>
 *   <Sidebar />
 *   <Board style={{ flex: 1 }} />
 * </BoardProvider>
 * ```
 */
export function BoardProvider({
  config = NO_OPTIONS,
  editor: editorProperty,
  children,
}: BoardProviderProps) {
  const { theme, readOnly, onChange, onError, ...options } = config;
  const resolvedTheme = useResolvedTheme(theme);
  const onErrorReference = useRef(onError);
  onErrorReference.current = onError;
  const reportError = useCallback(
    (error: unknown) => (onErrorReference.current ?? consoleError)(error),
    [],
  );
  const own = useOwnedEditor(
    editorProperty
      ? null
      : {
          ...options,
          ...(resolvedTheme ? { theme: resolvedTheme } : {}),
          ...(readOnly !== undefined ? { readOnly } : {}),
          onError: reportError,
        },
    LIVE_OPTIONS,
  );
  const editor = editorProperty ?? own;
  if (!editor) {
    throw new Error(
      'apeiro: keep passing `editor` to <BoardProvider> for its whole lifetime (or never)',
    );
  }
  useChangeListener(editor, onChange);
  useEffect(() => {
    if (resolvedTheme) editor.setTheme(resolvedTheme);
  }, [editor, resolvedTheme]);
  // A viewer's board; follows `config` (the user's role can change while they're here).
  useEffect(() => {
    if (readOnly !== undefined) editor.setReadOnly(readOnly);
  }, [editor, readOnly]);

  const value = useMemo<BoardContextValue>(() => ({ editor, reportError }), [editor, reportError]);
  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

/**
 * The board's canvas. Fills its box: give it a size (or a parent with one).
 *
 * Under a `<BoardProvider>` it shows the provider's board; on its own it is one: it creates
 * the board from `config`.
 *
 * Rendered only in the browser: on the server (and while hydrating) it is an empty box of
 * the same size with `fallback` in it, and its children are not rendered either, so they
 * never run on the server or cause hydration mismatches.
 *
 * ```tsx
 * <Board style={{ height: '100vh' }} config={{ theme: 'system', initialElements: saved, onChange: save }}>
 *   <MyToolbar />
 * </Board>
 * ```
 */
export function Board(props: BoardProps) {
  const context = useContext(BoardContext);
  const { config, ...view } = props;
  useConfigUnderProviderWarning(!!context && config !== undefined);
  if (context) {
    return <BoardView {...view} context={context} />;
  }
  return (
    <BoardProvider config={config}>
      <ProvidedBoardView {...view} />
    </BoardProvider>
  );
}

function ProvidedBoardView(props: BoardViewProps) {
  const context = useContext(BoardContext)!;
  return <BoardView {...props} context={context} />;
}

/** Mounts the editor of `context` into a box and shows the fallback until it runs. */
function BoardView({
  context,
  className,
  style,
  children,
  fallback,
  onReady,
}: BoardViewProps & { context: BoardContextValue }) {
  const { editor, reportError } = context;
  const client = useIsClient();
  const host = useRef<HTMLDivElement>(null);
  const onReadyReference = useRef(onReady);
  onReadyReference.current = onReady;
  const ready = useSyncExternalStore(
    useCallback((onChange: () => void) => editor.on('mount', onChange), [editor]),
    () => editor.isMounted,
    () => false,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let active = true;
    editor.mount(element).then(
      () => {
        if (active && editor.isMounted) onReadyReference.current?.(editor);
      },
      (error: unknown) => {
        if (!active) return;
        setFailed(true);
        reportError(error);
      },
    );
    return () => {
      active = false;
      editor.unmount();
    };
  }, [editor, client, reportError]);

  return (
    <div
      className={className ? `ap-host ${className}` : 'ap-host'}
      style={{ position: 'relative', overflow: 'hidden', ...style }}
    >
      {client && <div ref={host} className="ap-mount" style={{ position: 'absolute', inset: 0 }} />}
      {!ready && !failed && fallback !== undefined && fallback !== null && (
        <div className="ap-fallback" style={{ position: 'absolute', inset: 0 }}>
          {fallback}
        </div>
      )}
      {client && children !== undefined && children !== null && (
        <div className="ap-ui">{children}</div>
      )}
    </div>
  );
}

/** Warns once when `<Board config>` is given under a provider: the provider owns the board. */
function useConfigUnderProviderWarning(ignored: boolean): void {
  const warned = useRef(false);
  useEffect(() => {
    if (!ignored || warned.current) return;
    warned.current = true;
    console.warn(
      'apeiro: <Board config> is ignored under a <BoardProvider>: pass it to the provider.',
    );
  });
}
