import type { BoardElement } from '@apeiro/core';
import type { BoardCollaboration, BoardEditor, BoardThemeName } from '@apeiro/editor';
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
import { useCollaboration } from './collaboration';
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
 * `config` to `<Board>` or `<BoardProvider>`, inline or defined once (type it with
 * `satisfies BoardOptions`).
 *
 * `theme`, `readOnly` and the callbacks can change at any time, and they are the only
 * source of the board's theme and read-only mode. The other options (`initialElements`,
 * `grid`, `backend`…) are read once, when the board is created; changing one later logs a
 * warning (give the component a new `key` to start over).
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
  /** The board is on the page and its renderer runs (each time a `<Board>` shows it). */
  onReady?: (board: BoardEditor) => void;
  /**
   * The renderer couldn't start (no WebGPU or WebGL2; `errorFallback` of `<Board>` is
   * shown), a file could not be added, or a listener threw. Default: the console.
   */
  onError?: (error: unknown) => void;
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
   * during initial collaboration sync and until the GPU renderer has started (e.g.
   * a spinner). Nothing by default.
   */
  fallback?: ReactNode;
  /**
   * Shown in the board's box, instead of the board and its children, when the renderer
   * can't start (no WebGPU or WebGL2) or initial collaboration fails; a function gets
   * the error. Nothing by default.
   */
  errorFallback?: ReactNode | ((error: unknown) => ReactNode);
}

export interface BoardProviderProps {
  /** The board: content, settings and callbacks (see `BoardOptions`). */
  config?: BoardOptions;
  /** Optional adapter, e.g. yjs({ document, awareness, user }) from apeiro/yjs. */
  collaboration?: BoardCollaboration;
  /** Shown until the collaboration adapter finishes its initial synchronization. */
  fallback?: ReactNode;
  /** Shown if collaboration cannot connect or synchronize. */
  errorFallback?: ReactNode | ((error: unknown) => ReactNode);
  /**
   * Show this editor instead of creating one: pass it for the provider's whole lifetime
   * (it may be another editor later), or never. It is not destroyed on unmount, and its
   * creation options are its own; `theme`, `readOnly` and the callbacks of `config` still
   * apply.
   */
  editor?: BoardEditor;
  children?: ReactNode;
}

/**
 * Props of `<Board>`. Without a provider it creates its board from `config` and connects
 * `collaboration`. Under a provider its board is shown; pass those settings to the provider.
 */
export interface BoardProps extends BoardViewProps {
  /** The board: content, settings and callbacks (see `BoardOptions`). */
  config?: BoardOptions;
  /** Connect this board directly, e.g. socketIO({ document, url, roomId, user }). */
  collaboration?: BoardCollaboration;
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
  collaboration,
  fallback,
  errorFallback,
  children,
}: BoardProviderProps) {
  const { theme, readOnly, onChange, onReady, onError, ...options } = config;
  if (collaboration && options.initialElements?.length) {
    throw new Error(
      'apeiro: with collaboration, pass initialElements to the adapter (e.g. yjs), not config',
    );
  }
  const resolvedTheme = useResolvedTheme(theme);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const reportError = useCallback(
    (error: unknown) => (callbacks.current.onError ?? consoleError)(error),
    [],
  );
  const ready = useCallback((editor: BoardEditor) => callbacks.current.onReady?.(editor), []);
  // Whether the board comes from `editor` is fixed by the first render.
  const [external] = useState(editorProperty !== undefined);
  if (external !== (editorProperty !== undefined)) {
    throw new Error(
      'apeiro: pass `editor` to <BoardProvider> for its whole lifetime, or never (give the provider a new `key` to switch)',
    );
  }
  const own = useOwnedEditor(
    external
      ? null
      : {
          ...options,
          ...(resolvedTheme ? { theme: resolvedTheme } : {}),
          ...(readOnly !== undefined ? { readOnly } : {}),
          onError: reportError,
        },
    LIVE_OPTIONS,
  );
  const editor = (editorProperty ?? own)!;
  const connection = useCollaboration(editor, collaboration, reportError);
  useChangeListener(editor, onChange);
  useEffect(() => {
    if (resolvedTheme) editor.setTheme(resolvedTheme);
  }, [editor, resolvedTheme]);
  // A viewer's board; follows `config` (the user's role can change while they're here).
  useEffect(() => {
    if (readOnly !== undefined) editor.setReadOnly(readOnly);
  }, [editor, readOnly]);

  const value = useMemo<BoardContextValue>(
    () => ({ editor, reportError, ready }),
    [editor, reportError, ready],
  );
  const shown = connection.failed
    ? typeof errorFallback === 'function'
      ? errorFallback(connection.error)
      : errorFallback
    : connection.ready
      ? children
      : fallback;
  return <BoardContext.Provider value={value}>{shown}</BoardContext.Provider>;
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
  const { config, collaboration, ...view } = props;
  useConfigUnderProviderWarning(!!context && (config !== undefined || collaboration !== undefined));
  if (context) {
    return <BoardView {...view} context={context} />;
  }
  return (
    <BoardProvider
      config={config}
      collaboration={collaboration}
      fallback={<BoardSyncFallback {...view}>{view.fallback}</BoardSyncFallback>}
      errorFallback={(error) => (
        <BoardSyncFallback {...view}>
          {typeof view.errorFallback === 'function'
            ? view.errorFallback(error)
            : view.errorFallback}
        </BoardSyncFallback>
      )}
    >
      <ProvidedBoardView {...view} />
    </BoardProvider>
  );
}

function ProvidedBoardView(props: BoardViewProps) {
  const context = useContext(BoardContext)!;
  return <BoardView {...props} context={context} />;
}

const FILL: CSSProperties = { position: 'absolute', inset: 0 };

/** Keep the canvas box in the layout while its collaboration connection is pending. */
function BoardSyncFallback({ className, style, children }: BoardViewProps) {
  return (
    <div
      className={className ? `ap-host ${className}` : 'ap-host'}
      style={{ position: 'relative', overflow: 'hidden', ...style }}
    >
      {children !== undefined && children !== null && (
        <div className="ap-fallback" style={FILL}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Mounts the editor of `context` into a box and shows the fallbacks until it runs. */
function BoardView({
  context,
  className,
  style,
  children,
  fallback,
  errorFallback,
}: BoardViewProps & { context: BoardContextValue }) {
  const { editor, reportError, ready: notifyReady } = context;
  const client = useIsClient();
  const host = useRef<HTMLDivElement>(null);
  const ready = useSyncExternalStore(
    useCallback((onChange: () => void) => editor.on('mount', onChange), [editor]),
    () => editor.isMounted,
    () => false,
  );
  // The error of the editor that failed to start here (another editor may follow).
  const [failure, setFailure] = useState<{ editor: BoardEditor; error: unknown } | null>(null);
  const failed = failure?.editor === editor;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let active = true;
    editor.mount(element).then(
      () => {
        if (active && editor.isMounted) notifyReady(editor);
      },
      (error: unknown) => {
        if (!active) return;
        setFailure({ editor, error });
        reportError(error);
      },
    );
    return () => {
      active = false;
      editor.unmount();
    };
  }, [editor, client, reportError, notifyReady]);

  const shown = failed
    ? typeof errorFallback === 'function'
      ? errorFallback(failure.error)
      : errorFallback
    : ready
      ? null
      : fallback;
  return (
    <div
      className={className ? `ap-host ${className}` : 'ap-host'}
      style={{ position: 'relative', overflow: 'hidden', ...style }}
    >
      {client && <div ref={host} className="ap-mount" style={FILL} />}
      {shown !== undefined && shown !== null && (
        <div className="ap-fallback" style={FILL}>
          {shown}
        </div>
      )}
      {client && !failed && children !== undefined && children !== null && (
        <div className="ap-ui">{children}</div>
      )}
    </div>
  );
}

/** Warns once when board-owned settings are given under a provider. */
function useConfigUnderProviderWarning(ignored: boolean): void {
  const warned = useRef(false);
  useEffect(() => {
    if (!ignored || warned.current) return;
    warned.current = true;
    console.warn(
      'apeiro: <Board config/collaboration> is ignored under a <BoardProvider>: pass these settings to the provider.',
    );
  });
}
