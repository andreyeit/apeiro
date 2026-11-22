import {
  Camera,
  CameraAnimator,
  copyElements,
  createTextElement,
  defaultTextBlock,
  hexColor,
  History,
  isShape,
  LINE_HEIGHT,
  measureTextBox,
  newId,
  pasteElements,
  Scene,
  validateElement,
  type BoardClipboard,
  type BoardElement,
  type Box,
  type CameraOptions,
  type ElementPatch,
  type ShapeElement,
  type UndoHistory,
  type Vec2,
} from '@apeiro/core';
import { createRenderer, type BoardRenderer } from '@apeiro/renderer';
import { exportFrame, renderImage, sceneOf, type ExportImageOptions } from '../export/export-image';
import { attachControls, cropControls, type CropControls } from '../input/controls';
import { AudioController } from '../media/audio-controller';
import {
  importFiles,
  localUploader,
  revokeUnusedObjectUrls,
  type Uploader,
} from '../media/import-files';
import { Overlay, type OverlayLayer } from '../overlay/overlay';
import {
  DraftScene,
  normalizeDraft,
  type BoardDraft,
  type NormalizedDraft,
} from '../preview/draft-preview';
import { PreviewCanvas } from '../preview/preview-canvas';
import { groupSelection, ungroupSelection } from '../selection/grouping';
import { linkAtPoint } from '../text-editor/links';
import {
  openLink,
  TextEditor,
  type TextFormatCommand,
  type TextFormatState,
} from '../text-editor/text-editor';
import { CORNER_RADIUS, createShape, ELEMENT_SIZE, SHAPE_PRESETS } from '../tools/shapes';
import {
  ToolState,
  VIEW_TOOLS,
  type ConnectorStyle,
  type PenStyle,
  type PlaceKind,
  type Tool,
  type ToolActivation,
} from '../tools/tool-state';
import {
  applyRendererTheme,
  boardThemeColors,
  gridBackdrop,
  THEME_KEEP_TYPES,
  type BoardGrid,
  type BoardThemeColors,
  type BoardThemeName,
} from '../theme/board-theme';
import { activeBoard } from './active-board';
import { BoardListeners, type BoardListenerHost } from './board-listeners';
import { createBoardDom, watchPixelRatio } from './dom';
import { Emitter } from './emitter';
import { HistoryProxy } from './history-proxy';
import { readSystemClipboard, writeSystemClipboard } from './system-clipboard';

/** Edit guard of a read-only board: nothing may change. */
const refuseEdits = (): boolean => false;

export type ZoomTarget = 'in' | 'out' | 'fit' | 'selection' | 'reset' | number;

export interface BoardEditorOptions {
  /** Scene to edit; by default a new empty one. Pass one to edit an existing scene. */
  scene?: Scene;
  /** Undo history; by default a local `History` of the scene. Can be replaced later with `setHistory`. */
  history?: UndoHistory;
  camera?: CameraOptions;
  /** 'light' (default) or 'dark'. Only changes how colors are drawn, never stored colors. */
  theme?: BoardThemeName;
  /** `auto` (default): WebGPU when available, otherwise WebGL2. */
  backend?: 'auto' | 'webgpu' | 'webgl';
  /** Grid of the board: dots, lines (default) or none. */
  grid?: BoardGrid;
  /** Smart guides while moving and resizing (default true). */
  snapping?: boolean;
  /** Animated zoom and pan (default true). */
  smoothCamera?: boolean;
  /**
   * Where dropped or pasted images and audio are stored; returns their URL. By default
   * object URLs, which only this tab can open: on a shared board pass an upload to your
   * storage, or other participants will not see the files.
   */
  upload?: Uploader;
  /** Origins images and audio may be loaded from, besides blob:, data: and the page's own. */
  mediaOrigins?: readonly string[];
  /** Opens a link clicked in board text (default: a new tab, without an opener). */
  openLink?: (href: string) => void;
  /** The comment tool was clicked at a world point; show your comment UI there. */
  onComment?: (at: Vec2) => void;
  /** A file could not be added, or the renderer failed to start. */
  onError?: (error: unknown) => void;
  /** Keep the drawn frame (screenshots, `canvas.toDataURL`); forces WebGL. */
  preserveDrawingBuffer?: boolean;
  /**
   * A viewer's board: it can be panned, zoomed, selected and copied, links open and audio
   * plays, but nothing changes it — no creating tools, handles, moving, typing, deleting,
   * pasting or undo. `load` still applies. Can change
   * later with `setReadOnly` (e.g. when the user's role changes).
   */
  readOnly?: boolean;
}

/** What `on` can listen to. Every listener is called without arguments; read the state from the editor. */
export type BoardEditorEvent =
  | 'mount'
  | 'tool'
  | 'selection'
  | 'history'
  | 'camera'
  | 'editing'
  | 'textFormat'
  | 'theme'
  | 'pointer'
  | 'clipboard'
  | 'gesture'
  | 'readOnly'
  | 'preview';

/** Offset of a duplicate, and of each repeated paste at one place, in screen pixels. */
const PASTE_STEP_PX = 24;
/** Pasted text wider than this (world units) wraps. */
const MAX_PASTED_TEXT_WIDTH = 480;
/** A drag smaller than this (world units) still makes a default-sized element. */
const MIN_PLACE = 8;
/** Elements a draft would delete are outlined in this color during the preview. */
const PREVIEW_REMOVE_COLOR = '#ef4444';

/** A board on the page: what `mount` created, until `unmount`. */
interface Mounted {
  root: HTMLDivElement;
  renderer: BoardRenderer;
  /** Draws the draft being previewed, over the board (see `showPreview`). */
  preview: PreviewCanvas;
  overlay: Overlay;
  text: TextEditor;
  audio: AudioController;
  crop: CropControls;
  dispose: () => void;
}

/**
 * An interactive board: scene, camera, tools, selection, undo and, once mounted into a DOM
 * element, the GPU renderer with all pointer and keyboard handling and the text editor.
 *
 * Everything but `mount` works without a DOM, so the editor can be created during server
 * rendering; `mount` must run in the browser. It can be mounted, unmounted and mounted
 * again (e.g. into another element) without losing the board, the camera or the history.
 */
export class BoardEditor {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly animator: CameraAnimator;
  /** Current tool and the style of new connectors and pen strokes. */
  readonly tools = new ToolState();
  private currentHistory: UndoHistory;
  private unsubscribeHistory: () => void;
  private ownsHistory: boolean;
  private readonly options: BoardEditorOptions;
  private mounted: Mounted | null = null;
  private mountToken = 0;
  /** Bumped by each deferred text open and by `stopEditing`, which cancels pending ones. */
  private editToken = 0;
  private readonly events = new Emitter<BoardEditorEvent>((error) => this.reportError(error));
  /** Selection while unmounted (the overlay owns it while mounted). */
  private pendingSelection = new Set<string>();
  private selectionSnapshot: readonly string[] = [];
  private lastSelectionSet: ReadonlySet<string> | null = null;
  private editingSnapshot: string | null = null;
  private cameraSnapshot: { x: number; y: number; zoom: number };
  private themeName: BoardThemeName;
  private pointerWorld: Vec2 | null = null;
  private clipboardData: BoardClipboard | null = null;
  private interacting = false;
  /** Last paste, so pasting the same data at the same place again steps aside. */
  private lastPaste: { data: BoardClipboard; at: Vec2; count: number } | null = null;
  private readOnlyMode: boolean;
  /** The draft being previewed, its scene and its subscription to the board. */
  private draft: { scene: DraftScene; unsubscribe: () => void } | null = null;
  private disposers: Array<() => void> = [];
  private destroyed = false;
  /**
   * Stable object handed to the controls and the text editor: forwards to the current
   * history, so `setHistory` takes effect without remounting.
   */
  private readonly historyProxy: UndoHistory;

  constructor(options: BoardEditorOptions = {}) {
    this.options = options;
    this.scene = options.scene ?? new Scene();
    this.camera = new Camera({ minZoom: 0.01, maxZoom: 32, ...options.camera });
    this.animator = new CameraAnimator(this.camera);
    this.animator.enabled = options.smoothCamera ?? true;
    this.themeName = options.theme ?? 'light';
    this.ownsHistory = !options.history;
    this.currentHistory = options.history ?? new History(this.scene);
    this.cameraSnapshot = { ...this.camera.getState() };
    this.historyProxy = new HistoryProxy(() => this.currentHistory);
    this.readOnlyMode = options.readOnly ?? false;
    if (this.readOnlyMode) this.applyGuard();
    this.unsubscribeHistory = this.currentHistory.subscribe(() => this.emit('history'));
    this.disposers.push(() => this.unsubscribeHistory());
    this.disposers.push(
      this.camera.subscribe(() => {
        this.cameraSnapshot = { ...this.camera.getState() };
        this.emit('camera');
      }),
      // Elements removed (also by someone else) leave the selection.
      this.scene.subscribe((changes) => {
        if (changes.removed.length > 0 && !this.mounted) {
          for (const id of changes.removed) this.pendingSelection.delete(id);
          this.syncSelection();
        }
      }),
    );
    this.tools.onChange = () => this.emit('tool');
  }

  // --- State ---------------------------------------------------------------------

  get history(): UndoHistory {
    return this.currentHistory;
  }

  /**
   * Replaces the undo history.
   * The previous history is disposed if the editor created it.
   */
  setHistory(history: UndoHistory): void {
    if (history === this.currentHistory) return;
    if (this.ownsHistory) this.currentHistory.dispose();
    this.ownsHistory = false;
    this.currentHistory = history;
    this.unsubscribeHistory();
    this.unsubscribeHistory = history.subscribe(() => this.emit('history'));
    this.emit('history');
  }

  get canUndo(): boolean {
    return this.currentHistory.canUndo;
  }

  get canRedo(): boolean {
    return this.currentHistory.canRedo;
  }

  get tool(): Tool {
    return this.tools.tool;
  }

  /** Picks a tool; on a read-only board only `select`, `hand` and `comment` (see `VIEW_TOOLS`). */
  setTool(tool: Tool, options: ToolActivation = {}): void {
    if (this.readOnlyMode && !VIEW_TOOLS.has(tool)) return;
    this.mounted?.text.stop();
    this.tools.setTool(tool, options);
  }

  /** Style of new connectors; also applied to the selected connectors. */
  setConnectorStyle(style: Partial<ConnectorStyle>): void {
    this.tools.setDefaults('connector', style);
    const ids = this.selection.filter((id) => this.scene.get(id)?.type === 'connector');
    if (ids.length > 0) this.updateElements(ids, style as ElementPatch);
  }

  /** The board can't be changed here (a viewer). See the `readOnly` option. */
  get readOnly(): boolean {
    return this.readOnlyMode;
  }

  /**
   * Makes the board read-only (a viewer) or editable again, e.g. when the user's role
   * changes. Going read-only ends text editing, crop mode and any creating tool.
   */
  setReadOnly(readOnly: boolean): void {
    if (readOnly === this.readOnlyMode) return;
    if (readOnly) {
      this.mounted?.text.stop();
      this.mounted?.crop.stop();
      if (!VIEW_TOOLS.has(this.tools.tool)) this.tools.setTool('select');
    }
    this.readOnlyMode = readOnly;
    if (this.mounted) {
      this.mounted.overlay.readOnly = readOnly;
      this.mounted.overlay.anchorsFor = null;
      this.mounted.overlay.request();
    }
    this.applyGuard();
    this.emit('readOnly');
  }

  /**
   * A read-only scene refuses local edits. A last line of defence: the board already
   * doesn't offer them.
   */
  private applyGuard(): void {
    this.scene.setEditGuard(this.readOnlyMode ? refuseEdits : null);
  }

  setPenStyle(style: Partial<PenStyle>): void {
    this.tools.setDefaults('pen', style);
  }

  /** Selected element ids. Same array until the selection changes. */
  get selection(): readonly string[] {
    return this.selectionSnapshot;
  }

  /** The selection as the controls see it (live set). */
  private get selectionSet(): Set<string> {
    return this.mounted ? this.mounted.overlay.selection : this.pendingSelection;
  }

  select(ids: Iterable<string>): void {
    const next = new Set<string>();
    for (const id of ids) if (this.scene.has(id)) next.add(id);
    if (this.mounted) {
      this.mounted.overlay.selection = next;
      this.mounted.overlay.request();
    } else this.pendingSelection = next;
    this.syncSelection();
  }

  selectAll(): void {
    this.select([...this.scene.all()].map((element) => element.id));
  }

  clearSelection(): void {
    this.select([]);
  }

  /** Elements currently selected (that still exist). */
  selectedElements(): BoardElement[] {
    const out: BoardElement[] = [];
    for (const id of this.selection) {
      const element = this.scene.get(id);
      if (element) out.push(element);
    }
    return out;
  }

  /** World bounds of the selection, or null if nothing is selected. */
  selectionBounds(): Box | null {
    return this.selection.length > 0 ? this.scene.bounds(this.selection) : null;
  }

  /** Element whose text is being edited, if any. */
  get editing(): string | null {
    return this.editingSnapshot;
  }

  /** Camera position and zoom. Same object until the camera moves. */
  get view(): Readonly<{ x: number; y: number; zoom: number }> {
    return this.cameraSnapshot;
  }

  get theme(): BoardThemeName {
    return this.themeName;
  }

  setTheme(theme: BoardThemeName): void {
    if (theme === this.themeName) return;
    this.themeName = theme;
    if (this.mounted) this.applyTheme(this.mounted);
    this.emit('theme');
  }

  /** A pointer gesture on the board is in progress (pressed, not yet released). */
  get isInteracting(): boolean {
    return this.interacting;
  }

  private setInteracting(on: boolean): void {
    if (on === this.interacting) return;
    this.interacting = on;
    this.emit('gesture');
  }

  /** Pointer position in world coordinates while it is over the board. */
  get pointer(): Vec2 | null {
    return this.pointerWorld;
  }

  /** The renderer while mounted (advanced: stats, text layout, color theme). */
  get renderer(): BoardRenderer | null {
    return this.mounted?.renderer ?? null;
  }

  /** The 2D overlay while mounted: add drawing on top of the board with `addLayer`. */
  get overlay(): Overlay | null {
    return this.mounted?.overlay ?? null;
  }

  get isMounted(): boolean {
    return this.mounted !== null;
  }

  /** Listens to a kind of change. Returns the unsubscribe function. */
  on(event: BoardEditorEvent, listener: () => void): () => void {
    return this.events.on(event, listener);
  }

  private emit(event: BoardEditorEvent): void {
    this.events.emit(event);
  }

  /** Errors of listeners and custom tools: to `onError`, else the console. */
  private reportError(error: unknown): void {
    (this.options.onError ?? console.error)(error);
  }

  private syncSelection(): void {
    const set = this.selectionSet;
    const previous = this.selectionSnapshot;
    let changed = set !== this.lastSelectionSet || set.size !== previous.length;
    if (!changed)
      for (const id of previous) if (!set.has(id) || !this.scene.has(id)) changed = true;
    this.lastSelectionSet = set;
    if (!changed) return;
    const next = [...set].filter((id) => this.scene.has(id));
    if (next.length === previous.length && next.every((id, i) => id === previous[i])) return;
    this.selectionSnapshot = next;
    this.emit('selection');
  }

  private syncEditing(): void {
    const id = this.mounted?.text.editing ?? null;
    if (id === this.editingSnapshot) return;
    this.editingSnapshot = id;
    this.emit('editing');
  }

  // --- Commands ------------------------------------------------------------------

  // Commands that change the board do nothing on a read-only one (see `readOnly`).

  undo(): void {
    if (this.readOnlyMode) return;
    this.mounted?.text.stop();
    this.select(this.currentHistory.undo());
  }

  redo(): void {
    if (this.readOnlyMode) return;
    this.mounted?.text.stop();
    this.select(this.currentHistory.redo());
  }

  /** Runs `fn` as one undo step (all scene changes inside merge). */
  batch<T>(run: () => T): T {
    return this.currentHistory.batch(run);
  }

  /** Adds elements (one undo step) and selects them. */
  addElements(elements: readonly BoardElement[], options: { select?: boolean } = {}): void {
    if (this.readOnlyMode) return;
    this.scene.transact(() => {
      for (const element of elements) this.scene.add(element);
    });
    if (options.select ?? true) this.select(elements.map((element) => element.id));
  }

  /** Patches elements, one undo step. A function patch is called per element. */
  updateElements(
    ids: Iterable<string>,
    patch: ElementPatch | ((element: BoardElement) => ElementPatch | null),
  ): void {
    if (this.readOnlyMode) return;
    this.scene.transact(() => {
      for (const id of ids) {
        const element = this.scene.get(id);
        if (!element) continue;
        const resolvedPatch = typeof patch === 'function' ? patch(element) : patch;
        if (resolvedPatch) this.scene.update(id, resolvedPatch);
      }
    });
    this.mounted?.overlay.request();
  }

  /** Patches every selected element, one undo step. */
  updateSelection(patch: ElementPatch | ((element: BoardElement) => ElementPatch | null)): void {
    this.updateElements(this.selection, patch);
  }

  /** Deletes the selection with the connectors attached to it. */
  deleteSelection(): void {
    if (this.selection.length === 0 || this.readOnlyMode) return;
    this.mounted?.text.stop();
    this.scene.removeWithConnectors(this.selection);
    this.select([]);
  }

  /** Deletes elements with the connectors attached to them, one undo step; they leave the selection. */
  removeElements(ids: Iterable<string>): void {
    if (this.readOnlyMode) return;
    const gone = new Set(ids);
    if (gone.size === 0) return;
    this.mounted?.text.stop();
    this.scene.removeWithConnectors(gone);
    this.select(this.selection.filter((id) => this.scene.has(id)));
  }

  /** Moves the selection above (`front`) or below (`back`) everything else. */
  reorderSelection(where: 'front' | 'back'): void {
    const elements = this.selectedElements().sort((first, second) => first.z - second.z);
    if (elements.length === 0 || this.readOnlyMode) return;
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const element of this.scene.all()) {
      minimum = Math.min(minimum, element.z);
      maximum = Math.max(maximum, element.z);
    }
    this.scene.transact(() => {
      elements.forEach((element, i) => {
        const z = where === 'front' ? maximum + 1 + i : minimum - elements.length + i;
        this.scene.update(element.id, { z });
      });
    });
    this.mounted?.overlay.request();
  }

  group(): void {
    if (this.readOnlyMode) return;
    const next = groupSelection(this.scene, new Set(this.selection));
    if (next) this.select(next);
  }

  ungroup(): void {
    if (this.readOnlyMode) return;
    const next = ungroupSelection(this.scene, new Set(this.selection));
    if (next) this.select(next);
  }

  /** Center of the view in world coordinates. */
  viewCenter(): Vec2 {
    return this.camera.screenToWorld({
      x: this.camera.viewportWidth / 2,
      y: this.camera.viewportHeight / 2,
    });
  }

  /** A point given in page client coordinates (e.g. a mouse event) in world coordinates. */
  clientToWorld(clientX: number, clientY: number): Vec2 {
    const rectangle = this.mounted?.root.getBoundingClientRect();
    return this.camera.screenToWorld({
      x: clientX - (rectangle?.left ?? 0),
      y: clientY - (rectangle?.top ?? 0),
    });
  }

  zoomTo(to: ZoomTarget): void {
    const center = { x: this.camera.viewportWidth / 2, y: this.camera.viewportHeight / 2 };
    if (to === 'in') this.animator.zoomAt(center, 1.25);
    else if (to === 'out') this.animator.zoomAt(center, 0.8);
    else if (to === 'fit' || to === 'selection') {
      const bounds = to === 'fit' ? this.scene.bounds() : this.selectionBounds();
      if (bounds) this.animator.fitBox(bounds, 96);
    } else this.animator.zoomAt(center, (to === 'reset' ? 1 : to) / this.camera.zoom);
  }

  /**
   * Adds a sticky note or shape at `at` (default: the view center), or over `box`,
   * and selects it. A new sticky opens for typing. Null on a read-only board.
   */
  place(kind: PlaceKind, at: Vec2 = this.viewCenter(), box: Box | null = null): string | null {
    if (this.readOnlyMode) return null;
    this.mounted?.text.stop();
    const sized = box && box.maxX - box.minX >= MIN_PLACE && box.maxY - box.minY >= MIN_PLACE;
    let id: string;
    if (kind === 'sticky') {
      const defaults = this.tools.getDefaults('sticky');
      const width = sized ? box.maxX - box.minX : (defaults.width ?? ELEMENT_SIZE);
      const height = sized ? box.maxY - box.minY : (defaults.height ?? ELEMENT_SIZE);
      const element: ShapeElement = {
        id: newId('s'),
        type: 'sticky',
        x: sized ? box.minX : at.x - width / 2,
        y: sized ? box.minY : at.y - height / 2,
        rotation: 0,
        z: this.scene.maxZ() + 1,
        fill: hexColor('#fff9b1'), // Miro's classic light yellow
        stroke: 0,
        strokeWidth: 0,
        radius: CORNER_RADIUS,
        ...defaults,
        width: width,
        height: height,
      };
      this.scene.add(element);
      id = element.id;
    } else {
      id = this.scene.transact(() => {
        const center = sized ? { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 } : at;
        const element = createShape(
          this.scene,
          { ...SHAPE_PRESETS[kind], ...this.tools.getDefaults(kind) },
          center,
        );
        if (sized)
          this.scene.update(element.id, {
            x: box.minX,
            y: box.minY,
            width: box.maxX - box.minX,
            height: box.maxY - box.minY,
          });
        return element.id;
      });
    }
    this.select([id]);
    if (kind === 'sticky') this.editText(id);
    return id;
  }

  /** Adds an empty text box at `at` and opens it for typing; null on a read-only board. */
  addText(at: Vec2 = this.viewCenter(), width?: number): string | null {
    if (this.readOnlyMode) return null;
    const defaults = this.tools.getDefaults('text');
    const block = { ...defaultTextBlock('text'), ...defaults };
    const size = block.fontSize;
    const y = width === undefined ? at.y - (size * LINE_HEIGHT) / 2 : at.y;
    const element = createTextElement(
      newId('t'),
      { x: at.x, y },
      this.scene.maxZ() + 1,
      width,
      block,
    );
    if (defaults.sizing !== undefined) element.text!.sizing = defaults.sizing;
    this.select([]);
    if (this.mounted) {
      const mounted = this.mounted;
      const token = ++this.editToken;
      requestAnimationFrame(() => {
        // `stopEditing` before then: an empty text box that was never opened leaves no trace.
        if (this.mounted !== mounted || token !== this.editToken) return;
        mounted.text.create(element);
        this.select([element.id]);
      });
    } else this.scene.add(element);
    return element.id;
  }

  /**
   * Opens the text of a shape for editing (next frame, after the current pointer event;
   * `stopEditing` before then cancels it).
   */
  editText(id: string): void {
    const mounted = this.mounted;
    if (!mounted) return;
    const token = ++this.editToken;
    requestAnimationFrame(() => {
      if (
        this.mounted === mounted &&
        token === this.editToken &&
        this.scene.has(id) &&
        !this.readOnlyMode
      )
        mounted.text.start(id);
    });
  }

  /** Closes the text being edited, and cancels an `editText` or `addText` not opened yet. */
  stopEditing(): void {
    this.editToken++;
    this.mounted?.text.stop();
  }

  /**
   * Formatting at the selection of the text being edited (null when nothing is), for your
   * formatting controls. Same object until it changes (event `textFormat`).
   */
  get textFormat(): TextFormatState | null {
    return this.mounted?.text.format ?? null;
  }

  /**
   * Changes the formatting of the text being edited (bold, color, size, list, link…) and
   * returns the focus to it. Wrap your controls in an element with `data-ap-text-controls`
   * so pressing them keeps the editor open. False when nothing is edited or the link is
   * not allowed.
   */
  formatText(command: TextFormatCommand): boolean {
    if (this.readOnlyMode) return false;
    return this.mounted?.text.apply(command) ?? false;
  }

  /** Adds image and audio files around `at` (default: the view center) and selects them. */
  async addFiles(files: Iterable<File>, at: Vec2 = this.viewCenter()): Promise<string[]> {
    if (this.readOnlyMode) return [];
    const ids = await importFiles(
      [...files],
      at,
      this.scene,
      this.options.upload ?? localUploader,
      (file, error) =>
        this.options.onError?.(new Error(`Could not add ${file.name}`, { cause: error })),
    );
    if (ids.length > 0) this.select(ids);
    return ids;
  }

  // --- Clipboard -------------------------------------------------------------------

  /** What `copy`/`cut` put on this editor's clipboard last (also kept when the system one fails). */
  get clipboard(): BoardClipboard | null {
    return this.clipboardData;
  }

  /**
   * Copies the selection (with the lines between selected shapes). Kept by the editor for
   * `paste`, and also written to the system clipboard when the browser allows it (call it
   * from a click or key handler), so it can be pasted into another board or tab.
   * Ctrl/⌘+C does this on the board. Returns the copied data, or null with nothing selected.
   */
  copy(): BoardClipboard | null {
    const data = this.takeCopy();
    if (data) void writeSystemClipboard(data);
    return data;
  }

  /** Copies the selection and deletes it (Ctrl/⌘+X). */
  cut(): BoardClipboard | null {
    if (this.readOnlyMode) return null;
    const data = this.copy();
    if (data) this.deleteSelection();
    return data;
  }

  /**
   * Pastes `data` (default: this editor's clipboard) as new elements, selected, one undo step.
   * Placed centered at `at`, else under the pointer when it is over the board, else in the
   * middle of the view; pasting the same data at the same place again steps aside each time.
   * Ctrl/⌘+V does this on the board (also with data copied in another tab or board).
   */
  paste(data: BoardClipboard | null = this.clipboardData, at?: Vec2): string[] {
    if (!data || this.readOnlyMode) return [];
    this.mounted?.text.stop();
    const target = at ?? this.pointerWorld ?? this.viewCenter();
    const last = this.lastPaste;
    const again =
      last && last.data === data && Math.hypot(last.at.x - target.x, last.at.y - target.y) < 1e-6;
    const count = again ? last.count + 1 : 0;
    this.lastPaste = { data, at: target, count };
    const step = (PASTE_STEP_PX / this.camera.zoom) * count;
    const ids = pasteElements(this.scene, data, {
      at: { x: target.x + step, y: target.y + step },
      newId: (element) => newId(element.type === 'connector' ? 'c' : 's'),
    });
    this.select(ids);
    return ids;
  }

  /**
   * Pastes what the system clipboard holds: board elements, images, or text (as a text box).
   * Needs the browser's permission to read the clipboard; falls back to this editor's
   * clipboard. For a "Paste" button; Ctrl/⌘+V on the board doesn't need it.
   */
  async pasteFromClipboard(at?: Vec2): Promise<string[]> {
    if (this.readOnlyMode) return [];
    const content = await readSystemClipboard();
    if (content?.kind === 'image') return this.addFiles([content.file], at);
    if (content?.kind === 'board') return this.paste(content.data, at);
    if (content?.kind === 'text') {
      const id = this.pasteText(content.text, at);
      if (id) return [id];
    }
    // Nothing usable, or no permission: what this editor copied.
    return this.paste(this.clipboardData, at);
  }

  /**
   * Duplicates the selection next to itself and selects the copies, one undo step
   * (Ctrl/⌘+D). Lines between selected shapes are duplicated with them.
   */
  duplicate(): string[] {
    if (this.selection.length === 0 || this.readOnlyMode) return [];
    this.mounted?.text.stop();
    const step = PASTE_STEP_PX / this.camera.zoom;
    const data = copyElements(this.scene, this.selection);
    if (!data) return [];
    const ids = pasteElements(this.scene, data, {
      offset: { x: step, y: step },
      newId: (element) => newId(element.type === 'connector' ? 'c' : 's'),
    });
    this.select(ids);
    return ids;
  }

  /**
   * Adds `text` as a text box centered at `at` (default: pointer or view center); returns
   * its id, or null on a read-only board.
   */
  pasteText(text: string, at?: Vec2): string | null {
    if (this.readOnlyMode) return null;
    this.mounted?.text.stop();
    const target = at ?? this.pointerWorld ?? this.viewCenter();
    const block = { ...defaultTextBlock('text'), runs: [{ text: text.replace(/\r\n?/g, '\n') }] };
    let element = createTextElement(newId('t'), target, this.scene.maxZ() + 1, undefined, block);
    const measurer = this.mounted?.renderer.measurer;
    if (measurer) {
      let size = measureTextBox(element, measurer);
      // Long text wraps in a column instead of running off in one line.
      if (size && size.width > MAX_PASTED_TEXT_WIDTH) {
        element = {
          ...element,
          width: MAX_PASTED_TEXT_WIDTH,
          text: { ...block, sizing: 'auto-height' },
        };
        size = measureTextBox(element, measurer);
      }
      if (size) element = { ...element, width: size.width, height: size.height };
    }
    element = { ...element, x: target.x - element.width / 2, y: target.y - element.height / 2 };
    this.scene.add(element);
    this.select([element.id]);
    return element.id;
  }

  /** Copies the selection without touching the system clipboard. */
  private takeCopy(): BoardClipboard | null {
    const data = copyElements(this.scene, this.selection);
    if (!data) return null;
    this.clipboardData = data;
    this.lastPaste = null;
    this.emit('clipboard');
    return data;
  }

  /** Starts crop mode for a selected image (Enter or double click do it on the board). */
  cropImage(id: string): void {
    if (this.readOnlyMode) return;
    this.mounted?.crop.start(id);
  }

  /**
   * Replaces the board's content; not undoable (the history is cleared).
   * Invalid elements or duplicate ids throw before changing the board.
   */
  load(elements: readonly BoardElement[]): void {
    const ids = new Set<string>();
    for (const element of elements) {
      const problem = validateElement(element);
      if (problem) throw new Error(`Invalid element ${element?.id}: ${problem}`);
      if (ids.has(element.id)) throw new Error(`Element ${element.id} already exists`);
      ids.add(element.id);
    }
    this.mounted?.text.stop();
    this.scene.transact(() => {
      this.scene.clear();
      for (const element of elements) this.scene.add(element);
    }, 'load');
    this.currentHistory.clear();
    this.select([]);
  }

  /** Every element of the board (plain data, e.g. to save as JSON). */
  getElements(): BoardElement[] {
    return this.scene.sortedByZ();
  }

  // --- Export ----------------------------------------------------------------------

  /**
   * An image of the board (PNG by default): everything, the elements `ids` (e.g. the
   * selection) or a world `area`, drawn off screen at `scale` pixels per unit without the
   * selection, handles or cursors, once images and text are ready. Browser only; works
   * whether or not the board is mounted.
   *
   * ```ts
   * const png = await editor.exportImage({ ids: editor.selection, scale: 2 });
   * ```
   */
  async exportImage(options: ExportImageOptions = {}): Promise<Blob> {
    const ids = options.area ? null : options.ids ? [...options.ids] : null;
    const bounds = options.area ?? (ids ? this.scene.bounds(ids) : this.scene.bounds());
    if (!bounds) throw new Error('apeiro: nothing to export');
    const frame = exportFrame(
      bounds,
      options.scale ?? 2,
      options.padding ?? (options.area ? 0 : 24),
      options.maxSize ?? 8192,
    );
    const colors = this.themeColors();
    // The grid only when asked for.
    const grid = gridBackdrop(options.grid ? this.grid : 'none', colors);
    return renderImage(
      ids ? sceneOf(this.scene, ids) : this.scene,
      frame,
      {
        background:
          options.background === 'transparent' ? 0 : (options.background ?? colors.background),
        gridColor: grid.gridColor,
        gridStyle: this.grid === 'none' ? 'dots' : this.grid,
        ...(this.options.mediaOrigins ? { mediaOrigins: this.options.mediaOrigins } : {}),
        colorTheme: colors.colorTheme,
        keepTypes: THEME_KEEP_TYPES,
        audio: colors.audio,
      },
      options,
    );
  }

  // --- Preview of proposed changes -------------------------------------------------

  /**
   * Shows proposed changes (e.g. an AI assistant's) over the board for this user only:
   * new and changed elements drawn see-through on top, elements to delete outlined in red.
   * Nothing changes on the board until `applyPreview`;
   * `discardPreview` drops it. A new preview replaces the current one. Throws, showing
   * nothing, if an element of the draft is invalid.
   */
  showPreview(draft: BoardDraft): void {
    const scene = new DraftScene(this.scene, normalizeDraft(this.scene, draft));
    this.endPreview();
    const unsubscribe = this.scene.subscribe((changes) => scene.boardChanged(changes));
    this.draft = { scene, unsubscribe };
    if (this.mounted) this.showDraft(this.mounted);
    this.emit('preview');
  }

  /** The draft being previewed, as applying it would change the board; null without one. */
  get preview(): NormalizedDraft | null {
    return this.draft?.scene.draft ?? null;
  }

  /**
   * Applies the previewed draft to the board as one undo step and selects what it added
   * and changed; returns those ids. Elements deleted meanwhile by someone else are
   * skipped. Nothing on a read-only board (the preview stays).
   */
  applyPreview(): string[] {
    const draft = this.draft?.scene.draft;
    if (!draft || this.readOnlyMode) return [];
    this.endPreview();
    this.mounted?.text.stop();
    const ids: string[] = [];
    this.batch(() =>
      this.scene.transact(() => {
        for (const element of draft.add) {
          if (this.scene.has(element.id)) continue;
          this.scene.add(element);
          ids.push(element.id);
        }
        for (const { id, ...patch } of draft.update) if (this.scene.update(id, patch)) ids.push(id);
        this.scene.removeWithConnectors(draft.remove.filter((id) => this.scene.has(id)));
      }),
    );
    this.select(ids);
    this.emit('preview');
    return ids;
  }

  /** Drops the previewed draft; the board stays as it is. */
  discardPreview(): void {
    if (!this.draft) return;
    this.endPreview();
    this.emit('preview');
  }

  private endPreview(): void {
    if (!this.draft) return;
    this.draft.unsubscribe();
    this.draft = null;
    if (this.mounted) {
      this.mounted.preview.hide();
      this.mounted.overlay.request();
    }
  }

  /** Draws the draft on the preview canvas of a mounted board. */
  private showDraft(mounted: Mounted): void {
    if (!this.draft) return;
    mounted.preview.show(this.draft.scene.scene);
    mounted.overlay.request();
  }

  /** Elements the previewed draft would delete: outlined in red. */
  private readonly drawPreview: OverlayLayer = () => {
    const remove = this.draft?.scene.draft.remove;
    if (remove && remove.length > 0)
      this.mounted?.overlay.drawTintedSelection(new Set(remove), PREVIEW_REMOVE_COLOR);
  };

  // --- Mounting --------------------------------------------------------------------

  /**
   * Renders the board into `container` (it fills it: give the container a size) and
   * starts handling input. Resolves once the renderer runs. Mounting again moves the board.
   */
  async mount(container: HTMLElement): Promise<void> {
    if (this.destroyed) throw new Error('BoardEditor is destroyed');
    this.unmount();
    const token = ++this.mountToken;
    const { root, stage, canvas, previewCanvas, overlayCanvas, editorLayer } = createBoardDom(
      container,
      { theme: this.themeName },
    );

    let renderer: BoardRenderer;
    try {
      renderer = await createRenderer({
        backend: this.options.backend ?? 'auto',
        canvas,
        scene: this.scene,
        camera: this.camera,
        preserveDrawingBuffer: this.options.preserveDrawingBuffer ?? false,
        background: this.themeColors().background,
        ...gridBackdrop(this.grid, this.themeColors()),
        ...(this.options.mediaOrigins
          ? { media: { allowedOrigins: this.options.mediaOrigins } }
          : {}),
      });
    } catch (error) {
      root.remove();
      this.options.onError?.(error);
      throw error;
    }
    if (token !== this.mountToken || this.destroyed) {
      renderer.destroy();
      root.remove();
      return;
    }

    const disposers: Array<() => void> = [activeBoard.mounted(this)];
    const overlay = new Overlay(overlayCanvas, this.scene, this.camera);
    overlay.readOnly = this.readOnlyMode;
    overlay.selection = this.pendingSelection;
    disposers.push(renderer.onAfterRender(() => overlay.draw()));
    const text = new TextEditor(editorLayer, this.scene, this.camera, renderer, this.historyProxy);
    const audio = new AudioController(
      this.scene,
      renderer,
      undefined,
      this.options.mediaOrigins ?? [],
    );
    const preview = new PreviewCanvas(previewCanvas, this.camera, this.themeColors(), {
      backend: renderer.backend,
      ...(this.options.mediaOrigins ? { mediaOrigins: this.options.mediaOrigins } : {}),
      onError: (error) => this.options.onError?.(error),
    });
    const crop = cropControls();
    const mounted: Mounted = {
      root,
      renderer,
      preview,
      overlay,
      text,
      audio,
      crop,
      dispose: () => undefined,
    };
    this.mounted = mounted;
    disposers.push(overlay.addLayer(this.drawPreview));
    overlay.onDraw = () => {
      this.syncSelection();
      this.syncEditing();
    };
    // While text is edited the board shows just its outline: no handles over the typing.
    text.onStart = (id) => {
      overlay.editing = id;
      overlay.request();
      this.syncEditing();
    };
    text.onFormat = () => this.emit('textFormat');
    text.onStop = (id) => {
      overlay.editing = null;
      overlay.selection = id ? new Set([id]) : new Set();
      overlay.request();
      this.syncEditing();
    };
    // Created after the controls: their double click on a handle must stop the text editing one.
    let listeners: BoardListeners | null = null;
    disposers.push(
      attachControls(stage, this.scene, this.camera, overlay, this.tools, this.animator, {
        crop,
        history: this.historyProxy,
        onQuickCreate: (id) => this.editText(id),
        createText: (at, width) => void this.addText(at, width),
        editText: (id) => this.editText(id),
        linkAt: (id, world) => {
          const element = this.scene.get(id);
          return element && isShape(element)
            ? linkAtPoint(element, renderer.textLayout(element), world, 2 / this.camera.zoom)
            : null;
        },
        openLink: this.options.openLink ?? openLink,
        measurer: renderer.measurer,
        audio,
        place: (kind, at, box) => void this.place(kind, at, box),
        addComment: (at) => this.options.onComment?.(at),
        zoom: (to) => this.zoomTo(to),
        snapping: this.options.snapping ?? true,
        readOnly: () => this.readOnlyMode,
        acceptsKeys: () => activeBoard.acceptsKeys(this, listeners?.pointerInside ?? false),
        onToolError: (error) => this.reportError(error),
      }),
    );
    listeners = new BoardListeners(stage, this, this.listenerHost(mounted));
    disposers.push(() => listeners.dispose());
    disposers.push(revokeUnusedObjectUrls(this.scene));

    const resize = () => {
      renderer.resize();
      preview.resize();
      overlay.resize();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    disposers.push(() => observer.disconnect());
    disposers.push(watchPixelRatio(resize));

    mounted.dispose = () => {
      preview.hide();
      for (const dispose of disposers.reverse()) dispose();
      overlay.dispose();
      text.destroy();
      audio.dispose();
      renderer.destroy();
      root.remove();
    };
    this.applyTheme(mounted);
    resize();
    this.showDraft(mounted);
    this.syncSelection();
    this.emit('mount');
  }

  /** What the page listeners of a mount do on this editor. */
  private listenerHost(mounted: Mounted): BoardListenerHost {
    return {
      scene: this.scene,
      isReadOnly: () => this.readOnlyMode,
      hasSelection: () => this.selection.length > 0,
      hasCopy: () => this.clipboardData !== null,
      isCurrentMount: () => this.mounted === mounted,
      clientToWorld: (clientX, clientY) => this.clientToWorld(clientX, clientY),
      startEditing: (id) => mounted.text.start(id),
      setPointer: (world) => {
        this.pointerWorld = world;
        this.emit('pointer');
      },
      setInteracting: (interacting) => this.setInteracting(interacting),
      takeCopy: () => this.takeCopy(),
      copy: () => void this.copy(),
      cut: () => void this.cut(),
      deleteSelection: () => this.deleteSelection(),
      duplicate: () => void this.duplicate(),
      paste: (data) => void this.paste(data),
      pasteText: (text) => void this.pasteText(text),
      pasteFromClipboard: () => this.pasteFromClipboard(),
      addFiles: (files, at) => this.addFiles(files, at),
    };
  }

  /** Removes the board from the page; the scene, camera, selection and history stay. */
  unmount(): void {
    this.mountToken++;
    const mounted = this.mounted;
    if (!mounted) return;
    mounted.text.stop();
    this.pendingSelection = new Set(mounted.overlay.selection);
    this.mounted = null;
    mounted.dispose();
    this.pointerWorld = null;
    this.syncSelection();
    this.syncEditing();
    this.emit('mount');
  }

  /** Unmounts and releases everything; the editor can't be used afterwards. */
  destroy(): void {
    if (this.destroyed) return;
    this.unmount();
    this.endPreview();
    this.destroyed = true;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    if (this.ownsHistory) this.currentHistory.dispose();
    this.animator.stop();
    this.events.clear();
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** The board's grid option. */
  private get grid(): BoardGrid {
    return this.options.grid ?? 'lines';
  }

  private themeColors(): BoardThemeColors {
    return boardThemeColors(this.themeName);
  }

  private applyTheme(mounted: Mounted): void {
    const colors = this.themeColors();
    mounted.overlay.accent = colors.accent;
    mounted.overlay.handleFill = colors.handleFill;
    mounted.overlay.request();
    mounted.root.dataset.apTheme = this.themeName;
    mounted.renderer.setBackdrop({
      background: colors.background,
      gridColor: gridBackdrop(this.grid, colors).gridColor,
    });
    applyRendererTheme(mounted.renderer, colors);
    mounted.preview.restyle(colors);
    mounted.text.restyle(); // the edited text is shown by the DOM, in the board's colors
  }
}
