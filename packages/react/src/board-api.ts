import type { BoardElement, Box, ElementPatch, Vec2 } from '@apeiro/core';
import type {
  BoardDraft,
  BoardEditor,
  CustomTool,
  ExportImageOptions,
  PlaceKind,
  TextFormatCommand,
  Tool,
  ToolActivation,
  ToolStyles,
  ZoomTarget,
} from '@apeiro/editor';
import { useEditor } from './editor-context';

/** A patch, or a function that makes one per element (null: leave that element alone). */
export type ElementUpdate = ElementPatch | ((element: BoardElement) => ElementPatch | null);

/**
 * Every command of a board, grouped by what it works on. The object and its functions are
 * stable for the board's lifetime: pass them to `onClick` directly, put them in effect
 * dependencies, and calling them never re-renders. Commands that change the board do
 * nothing on a read-only one.
 *
 * State (the current tool, the selection…) is read with `useBoardState` and the other hooks.
 */
export interface BoardApi {
  readonly tools: {
    /** Picks a tool; `{ repeat: true }` keeps a one-shot tool (shapes, text) active. */
    activate(tool: Tool, options?: ToolActivation): void;
    /** Style of shapes, text, lines and pen strokes created from now on. */
    setDefaults<K extends keyof ToolStyles>(tool: K, style: ToolStyles[K]): void;
    getDefaults<K extends keyof ToolStyles>(tool: K): Readonly<ToolStyles[K]>;
    /** Adds a tool of your own; returns the function that removes it. */
    register(name: string, definition: CustomTool): () => void;
  };
  readonly selection: {
    set(ids: Iterable<string>): void;
    clear(): void;
    all(): void;
    update(patch: ElementUpdate): void;
    /** Deletes the selected elements with their connectors. */
    delete(): void;
    /** Above (`front`) or below (`back`) everything else. */
    reorder(where: 'front' | 'back'): void;
    group(): void;
    ungroup(): void;
  };
  readonly elements: {
    /** A sticky note or shape at `at` (default: the view center), or over `box`; selected. */
    create(kind: PlaceKind, options?: { at?: Vec2; box?: Box }): string | null;
    /** An empty text box at `at`, opened for typing; `width` makes it wrap. */
    createText(at?: Vec2, width?: number): string | null;
    add(elements: readonly BoardElement[], options?: { select?: boolean }): void;
    /** Images and audio files placed around `at`; resolves with their ids. */
    addFiles(files: Iterable<File>, at?: Vec2): Promise<string[]>;
    update(ids: Iterable<string>, patch: ElementUpdate): void;
    /** Deletes elements with their connectors. */
    remove(ids: Iterable<string>): void;
    /** Replaces the whole content; not undoable (the history is cleared). */
    load(elements: readonly BoardElement[]): void;
    getAll(): BoardElement[];
  };
  readonly text: {
    /** Opens the text of an element for typing. */
    edit(id: string): void;
    /** Closes the text being edited. */
    stop(): void;
    /**
     * Formatting of the text being edited, for your own controls (read it with
     * `useTextFormat`). Put the controls inside `data-ap-text-controls` so pressing them
     * keeps the text open. False when nothing is edited or the link is not allowed.
     */
    format(command: TextFormatCommand): boolean;
  };
  readonly history: {
    undo(): void;
    redo(): void;
    /** Runs `fn` as one undo step. */
    batch<T>(action: () => T): T;
  };
  readonly camera: {
    /** `'in'`, `'out'`, `'fit'` (everything), `'selection'`, `'reset'` (100%) or a zoom factor. */
    zoomTo(to: ZoomTarget): void;
  };
  readonly clipboard: {
    copy(): void;
    cut(): void;
    /** Pastes what the system clipboard holds (asks the browser), else what this board copied. */
    paste(): Promise<string[]>;
    duplicate(): void;
  };
  /** Proposed changes (e.g. an AI assistant's), shown to this user before they are made. */
  readonly preview: {
    show(draft: BoardDraft): void;
    apply(): string[];
    discard(): void;
  };
  /** An image of the board (PNG by default); see `ExportImageOptions`. */
  exportImage(options?: ExportImageOptions): Promise<Blob>;
}

const apis = new WeakMap<BoardEditor, BoardApi>();

/**
 * The commands of the surrounding board (see `BoardApi`). Never re-renders.
 *
 * ```tsx
 * const board = useBoard();
 * <button onClick={board.history.undo}>Undo</button>
 * <button onClick={() => board.tools.activate('rect')}>Rectangle</button>
 * ```
 */
export function useBoard(): BoardApi {
  return boardApi(useEditor());
}

/** The command object of an editor, made once per editor. */
export function boardApi(editor: BoardEditor): BoardApi {
  let api = apis.get(editor);
  if (api) return api;
  api = Object.freeze<BoardApi>({
    tools: Object.freeze({
      activate: (tool: Tool, options?: ToolActivation) => editor.setTool(tool, options),
      setDefaults: <K extends keyof ToolStyles>(tool: K, style: ToolStyles[K]) =>
        editor.tools.setDefaults(tool, style),
      getDefaults: <K extends keyof ToolStyles>(tool: K) => editor.tools.getDefaults(tool),
      register: (name: string, definition: CustomTool) => editor.tools.register(name, definition),
    }),
    selection: Object.freeze({
      set: (ids: Iterable<string>) => editor.select(ids),
      clear: () => editor.clearSelection(),
      all: () => editor.selectAll(),
      update: (patch: ElementUpdate) => editor.updateSelection(patch),
      delete: () => editor.deleteSelection(),
      reorder: (where: 'front' | 'back') => editor.reorderSelection(where),
      group: () => editor.group(),
      ungroup: () => editor.ungroup(),
    }),
    elements: Object.freeze({
      create: (kind: PlaceKind, options?: { at?: Vec2; box?: Box }) =>
        editor.place(kind, options?.at, options?.box),
      createText: (at?: Vec2, width?: number) => editor.addText(at, width),
      add: (elements: readonly BoardElement[], options?: { select?: boolean }) =>
        editor.addElements(elements, options),
      addFiles: (files: Iterable<File>, at?: Vec2) => editor.addFiles(files, at),
      update: (ids: Iterable<string>, patch: ElementUpdate) => editor.updateElements(ids, patch),
      remove: (ids: Iterable<string>) => editor.removeElements(ids),
      load: (elements: readonly BoardElement[]) => editor.load(elements),
      getAll: () => editor.getElements(),
    }),
    text: Object.freeze({
      edit: (id: string) => editor.editText(id),
      stop: () => editor.stopEditing(),
      format: (command: TextFormatCommand) => editor.formatText(command),
    }),
    history: Object.freeze({
      undo: () => editor.undo(),
      redo: () => editor.redo(),
      batch: <T>(action: () => T) => editor.batch(action),
    }),
    camera: Object.freeze({
      zoomTo: (to: ZoomTarget) => editor.zoomTo(to),
    }),
    clipboard: Object.freeze({
      copy: () => void editor.copy(),
      cut: () => void editor.cut(),
      paste: () => editor.pasteFromClipboard(),
      duplicate: () => void editor.duplicate(),
    }),
    preview: Object.freeze({
      show: (draft: BoardDraft) => editor.showPreview(draft),
      apply: () => editor.applyPreview(),
      discard: () => editor.discardPreview(),
    }),
    exportImage: (options?: ExportImageOptions) => editor.exportImage(options),
  });
  apis.set(editor, api);
  return api;
}
