import type { BoardElement, Box, SceneChanges } from '@apeiro/core';
import type {
  BoardEditor,
  BoardEditorEvent,
  BoardThemeName,
  NormalizedDraft,
  TextFormatState,
  Tool,
} from '@apeiro/editor';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { useChangeListener, type BoardChangeListener } from './changes';
import { useBoard } from './editor-context';
import {
  idSet,
  sameDependencies,
  storeOf,
  touches,
  type BoardStore,
  type Dependency,
} from './board-store';

type Subscribe = (onChange: () => void) => () => void;
type Equal<T> = (first: T, second: T) => boolean;

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

/**
 * Equal values, or arrays / plain objects whose items are equal (`Object.is`). The default
 * comparison of `useBoardState`, so a selector may return a fresh array or object.
 */
function shallowEqual(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (typeof first !== 'object' || typeof second !== 'object' || first === null || second === null)
    return false;
  if (Array.isArray(first) || Array.isArray(second)) {
    if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length)
      return false;
    for (let i = 0; i < first.length; i++) if (!Object.is(first[i], second[i])) return false;
    return true;
  }
  if (!isPlainObject(first) || !isPlainObject(second)) return false;
  const firstKeys = Object.keys(first);
  if (firstKeys.length !== Object.keys(second).length) return false;
  const firstRecord = first as Record<string, unknown>;
  const secondRecord = second as Record<string, unknown>;
  return firstKeys.every(
    (key) => Object.hasOwn(secondRecord, key) && Object.is(firstRecord[key], secondRecord[key]),
  );
}

/**
 * `useSyncExternalStore` that keeps returning the previous value while `isEqual` holds, so
 * a component re-renders only when the value really changes.
 */
function useStoreValue<T>(subscribe: Subscribe, select: () => T, isEqual: Equal<T> = Object.is): T {
  const last = useRef<{ value: T } | null>(null);
  const get = (): T => {
    const value = select();
    const previous = last.current;
    if (previous && isEqual(previous.value, value)) return previous.value;
    last.current = { value };
    return value;
  };
  return useSyncExternalStore(subscribe, get, get);
}

/** The editor of the surrounding board and its store. */
function useStore(): [BoardEditor, BoardStore] {
  const editor = useBoard();
  return [editor, storeOf(editor)];
}

/** A subscription to fixed dependencies, stable for the store. */
function useWatch(store: BoardStore, ...dependencies: Dependency[]): Subscribe {
  const key = dependencies.join(',');
  return useCallback(
    (onChange) => store.watch(key.split(',') as Dependency[], onChange),
    [store, key],
  );
}

/** A watcher whose dependencies follow what the selector last read. */
interface Tracked<T> {
  store: BoardStore;
  /** What the selector read the last time it ran. */
  dependencies: ReadonlySet<Dependency> | null;
  /** What the subscription listens to now. */
  watched: ReadonlySet<Dependency> | null;
  /** React's callback while subscribed. */
  onChange: (() => void) | null;
  unsubscribe: (() => void) | null;
  last: { value: T } | null;
  /** The selector that produced `last`: a new one (new props…) runs again. */
  select: ((editor: BoardEditor) => T) | null;
  /** Something the selector read may have changed since it last ran. */
  stale: boolean;
  /** Inside React's render: subscriptions are switched in an effect then, not here. */
  rendering: boolean;
  /** The misuse warning was shown (see `get` in `useBoardState`). */
  warned: boolean;
}

/**
 * Any state of the board, picked by `select`; re-renders only when the picked value
 * changes (`isEqual`, shallow by default: arrays and plain objects are compared item by
 * item, so a selector may return a fresh one).
 *
 * `select` runs again only when something it read can have changed: reading
 * `board.tools.current` listens to tool changes, `board.camera.zoom` to the camera,
 * `board.scene.get(id)` to that element… Read the state through the argument (not a
 * board from a closure) for this to work: a selector that reads nothing through it runs on
 * every change, and warns once when its value changes anyway.
 *
 * ```tsx
 * const zoom = useBoardState((board) => board.camera.zoom);
 * const stickies = useBoardState((board) =>
 *   board.selection.elements().filter((element) => element.type === 'sticky'),
 * );
 * ```
 */
export function useBoardState<T>(
  select: (editor: BoardEditor) => T,
  isEqual: (first: T, second: T) => boolean = shallowEqual,
): T {
  const [, store] = useStore();
  const reference = useRef<Tracked<T> | null>(null);
  const state =
    reference.current?.store === store
      ? reference.current
      : (reference.current = {
          store,
          dependencies: null,
          watched: null,
          onChange: null,
          unsubscribe: null,
          last: null,
          select: null,
          stale: true,
          rendering: false,
          warned: false,
        });

  const listen = useCallback(() => {
    state.stale = true;
    state.onChange?.();
  }, [state]);

  /** Listens to what the selector read last; true if that changed. */
  const rewatch = useCallback((): boolean => {
    const dependencies = state.dependencies;
    if (!state.onChange || !dependencies || sameDependencies(state.watched, dependencies))
      return false;
    state.unsubscribe?.();
    state.unsubscribe = store.watch(dependencies, listen);
    state.watched = dependencies;
    return true;
  }, [store, state, listen]);

  const subscribe = useCallback<Subscribe>(
    (onChange) => {
      state.onChange = onChange;
      state.watched = null;
      rewatch();
      // Something may have changed between rendering and subscribing.
      state.stale = true;
      return () => {
        state.unsubscribe?.();
        state.unsubscribe = null;
        state.watched = null;
        state.onChange = null;
      };
    },
    [state, rewatch],
  );

  // The snapshot is cached: the selector runs again only after a change of what it read, or
  // when it is a new function (it may use new props). Running it on every call would hand
  // React a new value each time a selector builds fresh objects, and loop.
  const get = (): T => {
    if (!state.stale && state.last && state.select === select) return state.last.value;
    const { value, dependencies, untracked } = store.track(select);
    const previous = state.last;
    // The same selector read nothing through its argument, yet its value changed: it reads a
    // board from a closure, which can't be tracked (so it runs on every change).
    if (untracked && previous && state.select === select && !state.warned) {
      if (!isEqual(previous.value, value)) {
        state.warned = true;
        console.warn(
          'apeiro: a useBoardState selector changed without reading the board from its ' +
            'argument, so it runs on every change. Read the state through the argument: ' +
            'useBoardState((board) => board.selection.ids).',
        );
      }
    }
    state.stale = false;
    state.select = select;
    if (!sameDependencies(state.dependencies, dependencies)) {
      state.dependencies = dependencies;
      // After a change (not while rendering): listen to what it reads now right away.
      if (!state.rendering) rewatch();
    }
    if (previous && isEqual(previous.value, value)) return previous.value;
    state.last = { value };
    return value;
  };

  // A selector may branch on the state and read something else after a render: listen to
  // that, and check for a change missed meanwhile.
  useEffect(() => {
    if (rewatch()) listen();
  });

  state.rendering = true;
  try {
    return useSyncExternalStore(subscribe, get, get);
  } finally {
    state.rendering = false;
  }
}

/**
 * Calls `handler` on an editor event (`'selection'`, `'tool'`, `'camera'`…) without
 * re-rendering, e.g. to log or sync something. The latest `handler` is called (no need to
 * memoize it). To show state, use `useBoardState` instead.
 */
export function useBoardEvent(
  event: BoardEditorEvent,
  handler: (board: BoardEditor) => void,
): void {
  const editor = useBoard();
  const reference = useRef(handler);
  reference.current = handler;
  useEffect(() => editor.on(event, () => reference.current(editor)), [editor, event]);
}

/**
 * Calls `onChange` when the board's content changes, like `onChange` of the config but from
 * any component below the board or its provider (an autosave, a "saved" badge…). Changes
 * made together are reported once, a drag or a stroke when it ends, each origin separately.
 *
 * ```tsx
 * function Autosave({ boardId }: { boardId: string }) {
 *   useBoardChange((elements) => saveBoard(boardId, elements));
 *   return null;
 * }
 * ```
 */
export function useBoardChange(onChange: BoardChangeListener): void {
  useChangeListener(useBoard(), onChange);
}

/** The active tool (`board.tools.current`); pick one with `board.tools.activate`. */
export function useTool(): Tool {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'tool'), () => editor.tools.current);
}

/** Ids of the selected elements (same array until the selection changes). */
export function useSelectedIds(): readonly string[] {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'selection'), () => editor.selection.ids);
}

/** Listens to the selection and to scene changes of selected elements only. */
function useSelectionWatch(store: BoardStore, onSelectionChange?: () => void): Subscribe {
  return useCallback(
    (onChange) => {
      const offSelection = store.on('selection', () => {
        onSelectionChange?.();
        onChange();
      });
      const offScene = store.onScene((changes: SceneChanges) => {
        if (!touches(changes, idSet(store.editor.selection.ids))) return;
        onSelectionChange?.();
        onChange();
      });
      return () => {
        offSelection();
        offScene();
      };
    },
    [store, onSelectionChange],
  );
}

/** The selected elements, updated when they change (other elements' changes are skipped). */
export function useSelectedElements(): readonly BoardElement[] {
  const [editor, store] = useStore();
  return useStoreValue(useSelectionWatch(store), () => editor.selection.elements(), shallowEqual);
}

/** One element by id (undefined if it doesn't exist), updated when it changes. */
export function useElement(id: string | null | undefined): BoardElement | undefined {
  const [editor, store] = useStore();
  const subscribe = useCallback<Subscribe>(
    (onChange) => (id ? store.onElement(id, onChange) : () => undefined),
    [store, id],
  );
  return useStoreValue(subscribe, () => (id ? editor.scene.get(id) : undefined));
}

export interface HistoryState {
  /** There is something to undo and the board isn't read-only. */
  canUndo: boolean;
  canRedo: boolean;
}

/** Whether undo and redo are available, for toolbar buttons (`board.history.undo`…). */
export function useHistory(): HistoryState {
  const [editor, store] = useStore();
  return useStoreValue(
    useWatch(store, 'history', 'readOnly'),
    () => ({ canUndo: editor.history.canUndo, canRedo: editor.history.canRedo }),
    shallowEqual,
  );
}

export interface ClipboardState {
  /** Something is selected (`board.clipboard.copy`). */
  canCopy: boolean;
  /** Something is selected and the board isn't read-only (`cut`, `duplicate`). */
  canCut: boolean;
  /** The board isn't read-only (`paste`). */
  canPaste: boolean;
  /** This board copied something (the system clipboard may hold more: `paste` reads it). */
  hasCopy: boolean;
}

/** What copy, cut, paste and duplicate can do now, for toolbar buttons (`board.clipboard`…). */
export function useClipboard(): ClipboardState {
  const [editor, store] = useStore();
  return useStoreValue(
    useWatch(store, 'selection', 'clipboard', 'readOnly'),
    () => {
      const canCopy = editor.selection.ids.length > 0;
      return {
        canCopy,
        canCut: canCopy && !editor.readOnly,
        canPaste: !editor.readOnly,
        hasCopy: editor.clipboard.content !== null,
      };
    },
    shallowEqual,
  );
}

/** The draft being previewed (`board.preview.show`), or null. */
export function usePreview(): NormalizedDraft | null {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'preview'), () => editor.preview.draft);
}

/**
 * The zoom in whole percent (`83`): re-renders only when that number changes, not on every
 * frame of an animated zoom. The exact zoom: `useBoardState((board) => board.camera.zoom)`.
 *
 * ```tsx
 * const percent = useZoomPercent();
 * <button onClick={() => board.camera.zoomTo('reset')}>{percent}%</button>
 * ```
 */
export function useZoomPercent(): number {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'camera'), () => Math.round(editor.camera.zoom * 100));
}

/**
 * How the board is drawn now: `'light'` or `'dark'` (`'system'` resolved). The theme is
 * set by `theme` of the config.
 */
export function useBoardTheme(): BoardThemeName {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'theme'), () => editor.theme);
}

/**
 * Screen box of the selection relative to the board's box (CSS pixels), for placing a
 * floating toolbar above it (see `useFloating`); null without a selection. Follows pans,
 * zooms and edits.
 */
export function useSelectionScreenBounds(): Box | null {
  const [editor, store] = useStore();
  // World bounds change with the selection and its elements only; a pan or zoom just
  // projects them again (O(1) instead of a pass over the selection).
  const worldReference = useRef<{ box: Box | null; valid: boolean; store: BoardStore } | null>(
    null,
  );
  if (worldReference.current?.store !== store)
    worldReference.current = { box: null, valid: false, store };
  const world = worldReference.current;
  const invalidate = useCallback(() => {
    world.valid = false;
  }, [world]);
  const selection = useSelectionWatch(store, invalidate);
  const subscribe = useCallback<Subscribe>(
    (onChange) => {
      // Something may have changed between rendering and subscribing.
      world.valid = false;
      const offSelection = selection(onChange);
      const offView = store.watch(['camera', 'mount'], onChange);
      return () => {
        offSelection();
        offView();
      };
    },
    [selection, store, world],
  );
  const compute = (): Box | null => {
    if (!world.valid) {
      world.box = editor.selection.bounds();
      world.valid = true;
    }
    return world.box ? toScreen(editor, world.box) : null;
  };
  return useStoreValue(subscribe, compute, shallowEqual);
}

/** A world box projected to the board's box (CSS pixels). */
function toScreen(editor: BoardEditor, bounds: Box): Box {
  const topLeft = editor.camera.worldToScreen({ x: bounds.minX, y: bounds.minY });
  const bottomRight = editor.camera.worldToScreen({ x: bounds.maxX, y: bounds.maxY });
  return { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y };
}

/**
 * Screen box of element `id` relative to the board's box (CSS pixels), or null if it
 * doesn't exist: for UI pinned to an element (a comment marker, a badge). Follows pans,
 * zooms and changes of that element only.
 *
 * ```tsx
 * const box = useElementScreenBounds(thread.elementId);
 * return box && <CommentPin style={{ left: box.maxX, top: box.minY }} />;
 * ```
 */
export function useElementScreenBounds(id: string | null | undefined): Box | null {
  const [editor, store] = useStore();
  const subscribe = useCallback<Subscribe>(
    (onChange) => {
      const offElement = id ? store.onElement(id, onChange) : () => undefined;
      const offView = store.watch(['camera', 'mount'], onChange);
      return () => {
        offElement();
        offView();
      };
    },
    [store, id],
  );
  const compute = (): Box | null => {
    const bounds = id ? editor.scene.getBounds(id) : undefined;
    return bounds ? toScreen(editor, bounds) : null;
  };
  return useStoreValue(subscribe, compute, shallowEqual);
}

/** The text being edited, for a formatting toolbar (see `useTextEditing`). */
export interface TextEditing {
  /** Id of the element whose text is edited. */
  id: string;
  /** Formatting at the caret or selection; change it with `board.text.apply`. */
  format: TextFormatState;
  /** Screen box of the element relative to the board's box (CSS pixels). */
  bounds: Box;
}

/**
 * The text being edited, or null: its element, its formatting and where it is on screen.
 * Everything a formatting toolbar needs (the board has none of its own): place it with
 * `useFloating(editing?.bounds)`, change the text with `board.text.apply`, and put it inside
 * `data-ap-text-controls` so pressing it keeps the text open.
 *
 * ```tsx
 * function TextToolbar() {
 *   const editing = useTextEditing();
 *   const floating = useFloating(editing?.bounds);
 *   const board = useBoard();
 *   if (!editing) return null;
 *   return (
 *     <div ref={floating.ref} style={floating.style} data-ap-text-controls>
 *       <button
 *         aria-pressed={editing.format.bold}
 *         onClick={() => board.text.apply({ type: 'toggle', style: 'bold' })}
 *       >
 *         B
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useTextEditing(): TextEditing | null {
  const [editor, store] = useStore();
  const id = useStoreValue(useWatch(store, 'editing'), () => editor.text.editing);
  const format = useStoreValue(useWatch(store, 'textFormat', 'mount'), () => editor.text.format);
  const bounds = useElementScreenBounds(id);
  return useMemo(
    () => (id && format && bounds ? { id, format, bounds } : null),
    [id, format, bounds],
  );
}

export interface FloatingOptions {
  /** Above the anchor (default) or below it; flips to the other side when there's no room. */
  placement?: 'top' | 'bottom';
  /** Space between the anchor and the element (CSS pixels, default 12). */
  gap?: number;
  /** Space kept from the board's edges (CSS pixels, default 8). */
  margin?: number;
}

export interface Floating {
  /** Give it to the floating element. */
  ref: (element: HTMLElement | null) => void;
  /** Its position: absolute, next to the anchor, inside the board. */
  style: CSSProperties;
}

/**
 * Places an element of yours (a toolbar, a menu) next to a box on the board: centered above
 * it, below when there's no room, and kept inside the board. For a child of `<Board>`, with
 * `useSelectionScreenBounds`, `useElementScreenBounds` or `useTextEditing`; hidden while
 * `anchor` is null.
 *
 * ```tsx
 * const floating = useFloating(useSelectionScreenBounds());
 * <div ref={floating.ref} style={floating.style}>…</div>
 * ```
 */
export function useFloating(
  anchor: Box | null | undefined,
  options: FloatingOptions = {},
): Floating {
  const { placement = 'top', gap = 12, margin = 8 } = options;
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0, boardWidth: 0, boardHeight: 0 });
  // Measured before the browser paints, so the element never shows at a wrong place.
  useLayoutEffect(() => {
    if (!element) return;
    const parent = element.offsetParent;
    const next = {
      width: element.offsetWidth,
      height: element.offsetHeight,
      boardWidth: parent?.clientWidth ?? 0,
      boardHeight: parent?.clientHeight ?? 0,
    };
    setSize((current) =>
      current.width === next.width &&
      current.height === next.height &&
      current.boardWidth === next.boardWidth &&
      current.boardHeight === next.boardHeight
        ? current
        : next,
    );
  });
  if (!anchor) return { ref: setElement, style: { position: 'absolute', display: 'none' } };
  const { width, height, boardWidth, boardHeight } = size;
  const above = anchor.minY - gap - height;
  const below = anchor.maxY + gap;
  let top =
    placement === 'top'
      ? above >= margin
        ? above
        : below
      : below + height <= boardHeight - margin || boardHeight === 0
        ? below
        : above;
  if (boardHeight > 0) top = Math.max(margin, Math.min(top, boardHeight - height - margin));
  const centered = (anchor.minX + anchor.maxX) / 2 - width / 2;
  const left =
    boardWidth > 0 ? Math.max(margin, Math.min(centered, boardWidth - width - margin)) : centered;
  return { ref: setElement, style: { position: 'absolute', left, top } };
}
