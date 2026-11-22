import type {
  BoardClipboard,
  BoardElement,
  Box,
  CameraState,
  ElementPatch,
  UndoHistory,
  Vec2,
} from '@apeiro/core';
import type { BoardDraft, NormalizedDraft } from '../preview/draft-preview';
import type { TextFormatCommand, TextFormatState } from '../text-editor/text-editor';
import type {
  CustomTool,
  PlaceKind,
  ShapeToolStyle,
  Tool,
  ToolActivation,
  ToolDefaults,
  ToolStyles,
} from '../tools/tool-state';

// The editor's API, grouped by what it works on: `editor.tools`, `editor.selection`… Every
// function of a group is bound and stable, so it can be passed as a callback
// (`onClick={editor.history.undo}`); the other members are state, read when needed.
// Commands that change the board do nothing on a read-only one.

export type ZoomTarget = 'in' | 'out' | 'fit' | 'selection' | 'reset' | number;

/** A patch, or a function that makes one per element (null: leave that element alone). */
export type ElementUpdate = ElementPatch | ((element: BoardElement) => ElementPatch | null);

export interface EditorTools {
  /** The active tool (event `tool`). */
  readonly current: Tool;
  /**
   * Picks a tool; `{ repeat: true }` keeps a one-shot tool (shapes, text) active. A
   * read-only board offers only `select`, `hand` and `comment`.
   */
  activate(tool: Tool, options?: ToolActivation): void;
  /** Style of shapes, text, lines and pen strokes created from now on (existing ones keep theirs). */
  setDefaults<K extends keyof ToolStyles>(tool: K, style: ToolStyles[K]): void;
  /**
   * The full style new elements of `tool` get: built-in values with your `setDefaults`, e.g.
   * to show the current pen color. Same object until it changes (event `tool`).
   */
  getDefaults<K extends keyof ToolStyles>(tool: K): Readonly<ToolDefaults[K]>;
  /** Adds a tool of your own; returns the function that removes it. */
  register(name: string, definition: CustomTool): () => void;
}

export interface EditorSelection {
  /** Ids of the selected elements; same array until the selection changes (event `selection`). */
  readonly ids: readonly string[];
  /** The selected elements. */
  elements(): BoardElement[];
  /** World bounds of the selection; null without one. */
  bounds(): Box | null;
  set(ids: Iterable<string>): void;
  all(): void;
  clear(): void;
  /** Patches every selected element, one undo step. */
  update(patch: ElementUpdate): void;
  /** Deletes the selected elements with the connectors attached to them. */
  delete(): void;
  /** Above (`front`) or below (`back`) everything else. */
  reorder(where: 'front' | 'back'): void;
  group(): void;
  ungroup(): void;
}

/** Options of `elements.create`. */
export interface CreateOptions {
  /** Center of the new element (world point; default: the middle of the view). */
  at?: Vec2;
  /** The box it fills instead (world units). */
  box?: Box;
  /** Its style, over the tool's (`tools.getDefaults`). */
  style?: ShapeToolStyle;
  /** Its text. */
  text?: string;
  /** Selects it (default true); a selected new sticky without text opens for typing. */
  select?: boolean;
}

export interface EditorElements {
  /** Every element in paint order: plain data, e.g. to save as JSON. */
  getAll(): BoardElement[];
  /**
   * A sticky note or shape as its tool makes it, in one undo step; returns its id (null on
   * a read-only board).
   *
   * ```ts
   * editor.elements.create('rect', { box, style: { fill: hexColor('#fde68a') }, text: 'Idea' });
   * ```
   */
  create(kind: PlaceKind, options?: CreateOptions): string | null;
  /** An empty text box at `at` (default: the middle of the view), opened for typing; `width` makes it wrap. */
  createText(options?: { at?: Vec2; width?: number }): string | null;
  /** Adds elements as they are (one undo step) and selects them unless `select: false`. */
  add(elements: readonly BoardElement[], options?: { select?: boolean }): void;
  /** Images and audio files placed around `at` (default: the middle of the view) and selected; resolves with their ids. */
  addFiles(files: Iterable<File>, options?: { at?: Vec2 }): Promise<string[]>;
  /** Patches elements, one undo step; a function patch is called per element. */
  update(ids: Iterable<string>, patch: ElementUpdate): void;
  /** Deletes elements with the connectors attached to them, one undo step. */
  remove(ids: Iterable<string>): void;
  /**
   * Replaces the whole content; not undoable (the history is cleared). Invalid elements or
   * duplicate ids throw before anything changes. Works on a read-only board too.
   */
  load(elements: readonly BoardElement[]): void;
  /** Starts crop mode for an image (Enter or a double click do it on the board). */
  crop(id: string): void;
}

export interface EditorText {
  /** Id of the element whose text is being edited, or null (event `editing`). */
  readonly editing: string | null;
  /**
   * Formatting at the caret or selection of the text being edited (bold, font, size,
   * color, list, link…), or null; same object until it changes (event `textFormat`).
   */
  readonly format: TextFormatState | null;
  /** Opens the text of an element for typing (next frame; `stop` before then cancels it). */
  edit(id: string): void;
  /** Closes the text being edited. */
  stop(): void;
  /**
   * Changes the formatting of the text being edited and gives it the focus back, for your
   * own controls: put them inside `data-ap-text-controls` so pressing them keeps the text
   * open. False when nothing is edited or the link is not allowed.
   */
  apply(command: TextFormatCommand): boolean;
}

export interface EditorHistory {
  /** There is something to undo and the board isn't read-only (event `history`). */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): void;
  redo(): void;
  /** Runs `action` as one undo step (all scene changes inside merge). */
  batch<T>(action: () => T): T;
  /** Uses another undo history; omit it to restore a fresh, editor-owned local history. */
  replace(history?: UndoHistory): void;
}

export interface EditorCamera {
  /** World point at the board's top left corner (event `camera`). */
  readonly x: number;
  readonly y: number;
  /** Screen pixels per world unit: 1 is 100%. */
  readonly zoom: number;
  /** Moves the camera there at once (stops an animated zoom). */
  set(state: Partial<CameraState>): void;
  /** `'in'`, `'out'`, `'fit'` (everything), `'selection'`, `'reset'` (100%) or a zoom; animated. */
  zoomTo(target: ZoomTarget): void;
  /** The middle of the view as a world point. */
  center(): Vec2;
  /** A point in page client coordinates (e.g. of a mouse event) as a world point. */
  clientToWorld(clientX: number, clientY: number): Vec2;
  /** A world point in CSS pixels from the board's top left corner. */
  worldToScreen(point: Vec2): Vec2;
  screenToWorld(point: Vec2): Vec2;
}

export interface EditorClipboard {
  /** What this board copied last (event `clipboard`); the system clipboard may hold more. */
  readonly content: BoardClipboard | null;
  /**
   * Copies the selection (with the lines between selected shapes), also to the system
   * clipboard when the browser allows it (call it from a click or key handler). Returns the
   * copied data, null with nothing selected. Ctrl/⌘+C does this on the board.
   */
  copy(): BoardClipboard | null;
  /** Copies the selection and deletes it (Ctrl/⌘+X). */
  cut(): BoardClipboard | null;
  /**
   * Pastes what the system clipboard holds (board elements, images, or text as a text box;
   * the browser asks for permission), else what this board copied. Placed at `at`, else
   * under the pointer, else in the middle of the view; resolves with the new ids, never
   * rejects (errors go to `onError`). Ctrl/⌘+V on the board needs no permission.
   */
  paste(options?: { at?: Vec2 }): Promise<string[]>;
  /** Copies of the selection next to it, selected, one undo step (Ctrl/⌘+D). */
  duplicate(): string[];
}

export interface EditorPreview {
  /** The draft being previewed, as applying it would change the board, or null (event `preview`). */
  readonly draft: NormalizedDraft | null;
  /**
   * Shows proposed changes (e.g. an AI assistant's) over the board for this user only: new
   * and changed elements see-through on top, elements to delete outlined in red. Replaces
   * the current draft; throws, showing nothing, if an element of it is invalid.
   */
  show(draft: BoardDraft): void;
  /**
   * Applies the draft as one undo step and selects what it added and changed; returns those
   * ids. Nothing on a read-only board (the preview stays).
   */
  apply(): string[];
  /** Drops the draft; the board stays as it is. */
  discard(): void;
}

/**
 * A frozen group of the editor's API: `state` are read-only properties computed when read,
 * `methods` the commands.
 */
export function group<T extends object, State extends keyof T = never>(
  state: { [K in State]: () => T[K] },
  methods: Omit<T, State>,
): T {
  const target: Record<string, unknown> = { ...methods };
  for (const [key, get] of Object.entries(state))
    Object.defineProperty(target, key, { get: get as () => unknown, enumerable: true });
  return Object.freeze(target) as T;
}
