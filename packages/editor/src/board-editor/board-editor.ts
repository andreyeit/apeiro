import {
  Camera,
  CameraAnimator,
  copyElements,
  createTextElement,
  defaultTextBlock,
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
  type CameraState,
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
import { DraftScene, normalizeDraft, type BoardDraft } from '../preview/draft-preview';
import { PreviewCanvas } from '../preview/preview-canvas';
import { groupSelection, ungroupSelection } from '../selection/grouping';
import { linkAtPoint } from '../text-editor/links';
import { openLink, TextEditor, type TextFormatCommand } from '../text-editor/text-editor';
import {
  ToolState,
  VIEW_TOOLS,
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
import {
  group,
  type CreateOptions,
  type EditorCamera,
  type EditorClipboard,
  type EditorElements,
  type EditorHistory,
  type EditorPreview,
  type EditorSelection,
  type EditorText,
  type EditorTools,
  type ElementUpdate,
  type ZoomTarget,
} from './editor-groups';
import { Emitter } from './emitter';
import { HistoryProxy } from './history-proxy';
import { readSystemClipboard, writeSystemClipboard } from './system-clipboard';

/** Edit guard of a read-only board: nothing may change. */
const refuseEdits = (): boolean => false;

export interface BoardEditorOptions {
  /** Scene to edit; by default a new empty one. Pass one to edit an existing scene. */
  scene?: Scene;
  /** Undo history; by default a local `History` of the scene. Can be replaced later (`history.replace`). */
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
  /**
   * A file could not be added, pasting failed, or a listener or custom tool threw (default:
   * the console). A renderer that can't start rejects `mount` instead.
   */
  onError?: (error: unknown) => void;
  /** Keep the drawn frame (screenshots, `canvas.toDataURL`); forces WebGL. */
  preserveDrawingBuffer?: boolean;
  /**
   * A viewer's board: it can be panned, zoomed, selected and copied, links open and audio
   * plays, but nothing changes it — no creating tools, handles, moving, typing, deleting,
   * pasting or undo. `elements.load` still applies. Can change later with `setReadOnly`
   * (e.g. when the user's role changes).
   */
  readOnly?: boolean;
}

/** What `on` can listen to. Every listener is called without arguments; read the state from the editor. */
export type BoardEditorEvent =
  | 'destroy'
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
  | 'locks'
  | 'preview';

/** The default text block of a `kind` of element holding `text` (line breaks normalized). */
const textBlockOf = (kind: ShapeElement['type'], text: string) => ({
  ...defaultTextBlock(kind),
  runs: [{ text: text.replace(/\r\n?/g, '\n') }],
});

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
  /** Draws the draft being previewed, over the board (see `preview.show`). */
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
  /** The board's content: read elements with `get`, `has`, `getBounds`, `size`… */
  readonly scene: Scene;
  /** The active tool and the style of what tools create. */
  readonly tools: EditorTools;
  readonly selection: EditorSelection;
  /** Creating, changing and removing elements. */
  readonly elements: EditorElements;
  /** The text being edited and its formatting. */
  readonly text: EditorText;
  readonly history: EditorHistory;
  /** Position and zoom of the view, and coordinates between the page and the board. */
  readonly camera: EditorCamera;
  readonly clipboard: EditorClipboard;
  /** Proposed changes (e.g. an AI assistant's), shown to this user before they are made. */
  readonly preview: EditorPreview;

  private readonly cameraModel: Camera;
  private readonly animator: CameraAnimator;
  private readonly toolState = new ToolState();
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
  private themeName: BoardThemeName;
  private pointerWorld: Vec2 | null = null;
  private clipboardData: BoardClipboard | null = null;
  private interacting = false;
  /** Last paste, so pasting the same data at the same place again steps aside. */
  private lastPaste: { data: BoardClipboard; at: Vec2; count: number } | null = null;
  private readOnlyMode: boolean;
  private lockedElements = new Set<string>();
  /** The draft being previewed, its scene and its subscription to the board. */
  private draft: { scene: DraftScene; unsubscribe: () => void } | null = null;
  private disposers: Array<() => void> = [];
  private destroyed = false;
  /**
   * Stable object handed to the controls and the text editor: forwards to the current
   * history, so `history.replace` takes effect without remounting.
   */
  private readonly historyProxy: UndoHistory;

  constructor(options: BoardEditorOptions = {}) {
    this.options = options;
    this.scene = options.scene ?? new Scene();
    this.disposers.push(
      this.scene.addEditGuard((id, origin) => origin === 'remote' || !this.isElementLocked(id)),
    );
    this.cameraModel = new Camera({ minZoom: 0.01, maxZoom: 32, ...options.camera });
    this.animator = new CameraAnimator(this.cameraModel);
    this.animator.enabled = options.smoothCamera ?? true;
    this.themeName = options.theme ?? 'light';
    this.ownsHistory = !options.history;
    this.currentHistory = options.history ?? new History(this.scene);
    this.historyProxy = new HistoryProxy(() => this.currentHistory);
    this.readOnlyMode = options.readOnly ?? false;
    if (this.readOnlyMode) this.applyGuard();
    this.unsubscribeHistory = this.currentHistory.subscribe(() => this.emit('history'));
    this.disposers.push(() => this.unsubscribeHistory());
    this.disposers.push(
      this.cameraModel.subscribe(() => this.emit('camera')),
      // Elements removed (also by someone else) leave the selection.
      this.scene.subscribe((changes) => {
        if (changes.removed.length > 0 && !this.mounted) {
          for (const id of changes.removed) this.pendingSelection.delete(id);
          this.syncSelection();
        }
      }),
    );
    this.toolState.onChange = () => this.emit('tool');

    const tools = this.toolState;
    this.tools = group<EditorTools, 'current'>(
      { current: () => tools.tool },
      {
        activate: (tool, activation) => this.activateTool(tool, activation),
        setDefaults: (tool, style) => tools.setDefaults(tool, style),
        getDefaults: (tool) => tools.getDefaults(tool),
        register: (name, definition) => tools.register(name, definition),
      },
    );
    this.selection = group<EditorSelection, 'ids'>(
      { ids: () => this.selectionSnapshot },
      {
        elements: () => this.selectedElements(),
        bounds: () => this.selectionBounds(),
        set: (ids) => this.select(ids),
        all: () => this.select([...this.scene.all()].map((element) => element.id)),
        clear: () => this.select([]),
        update: (patch) => this.updateElements(this.selectionSnapshot, patch),
        delete: () => this.deleteSelection(),
        reorder: (where) => this.reorderSelection(where),
        group: () => this.groupSelected(),
        ungroup: () => this.ungroupSelected(),
      },
    );
    this.elements = group<EditorElements>(
      {},
      {
        getAll: () => this.scene.sortedByZ(),
        create: (kind, createOptions) => this.place(kind, createOptions),
        createText: (textOptions) => this.addText(textOptions?.at, textOptions?.width),
        add: (elements, addOptions) => this.addElements(elements, addOptions?.select ?? true),
        addFiles: (files, fileOptions) => this.addFiles(files, fileOptions?.at),
        update: (ids, patch) => this.updateElements(ids, patch),
        remove: (ids) => this.removeElements(ids),
        load: (elements) => this.load(elements),
        crop: (id) => this.cropImage(id),
      },
    );
    this.text = group<EditorText, 'editing' | 'format'>(
      {
        editing: () => this.editingSnapshot,
        format: () => this.mounted?.text.format ?? null,
      },
      {
        edit: (id) => this.editText(id),
        stop: () => this.stopEditing(),
        apply: (command) => this.formatText(command),
      },
    );
    this.history = group<EditorHistory, 'canUndo' | 'canRedo'>(
      {
        canUndo: () => !this.readOnlyMode && this.currentHistory.canUndo,
        canRedo: () => !this.readOnlyMode && this.currentHistory.canRedo,
      },
      {
        undo: () => this.undo(),
        redo: () => this.redo(),
        batch: (action) => this.currentHistory.batch(action),
        replace: (history) => this.replaceHistory(history),
      },
    );
    const camera = this.cameraModel;
    this.camera = group<EditorCamera, 'x' | 'y' | 'zoom'>(
      { x: () => camera.x, y: () => camera.y, zoom: () => camera.zoom },
      {
        set: (state) => this.setCamera(state),
        zoomTo: (target) => this.zoomTo(target),
        center: () => this.viewCenter(),
        clientToWorld: (clientX, clientY) => this.clientToWorld(clientX, clientY),
        worldToScreen: (point) => camera.worldToScreen(point),
        screenToWorld: (point) => camera.screenToWorld(point),
      },
    );
    this.clipboard = group<EditorClipboard, 'content'>(
      { content: () => this.clipboardData },
      {
        copy: () => this.copy(),
        cut: () => this.cut(),
        paste: (pasteOptions) => this.pasteFromClipboard(pasteOptions?.at),
        duplicate: () => this.duplicate(),
      },
    );
    this.preview = group<EditorPreview, 'draft'>(
      { draft: () => this.draft?.scene.draft ?? null },
      {
        show: (draft) => this.showPreview(draft),
        apply: () => this.applyPreview(),
        discard: () => this.discardPreview(),
      },
    );
  }

  // --- State ---------------------------------------------------------------------

  /** The board can't be changed here (a viewer). See the `readOnly` option. */
  get readOnly(): boolean {
    return this.readOnlyMode;
  }

  /** An element reserved by another participant. */
  readonly isElementLocked = (id: string): boolean => this.lockedElements.has(id);

  /** Collaboration updates the elements unavailable to this client; remote updates still apply. */
  readonly setLockedElements = (ids: Iterable<string>): void => {
    const next = new Set(ids);
    if (
      next.size === this.lockedElements.size &&
      [...next].every((id) => this.lockedElements.has(id))
    )
      return;
    this.lockedElements = next;
    const editing = this.mounted?.text.editing;
    if (editing && next.has(editing)) this.stopEditing();
    if (this.mounted?.overlay.cropping && next.has(this.mounted.overlay.cropping))
      this.mounted.crop.stop();
    this.select(this.selectionSet);
    this.mounted?.overlay.request();
    this.emit('locks');
  };

  /**
   * Makes the board read-only (a viewer) or editable again, e.g. when the user's role
   * changes. Going read-only ends text editing, crop mode and any creating tool.
   */
  readonly setReadOnly = (readOnly: boolean): void => {
    if (readOnly === this.readOnlyMode) return;
    if (readOnly) {
      this.mounted?.text.stop();
      this.mounted?.crop.stop();
      if (!VIEW_TOOLS.has(this.toolState.tool)) this.toolState.setTool('select');
    }
    this.readOnlyMode = readOnly;
    if (this.mounted) {
      this.mounted.overlay.readOnly = readOnly;
      this.mounted.overlay.anchorsFor = null;
      this.mounted.overlay.request();
    }
    this.applyGuard();
    this.emit('readOnly');
  };

  get theme(): BoardThemeName {
    return this.themeName;
  }

  /** Light or dark drawing of the board; never changes stored colors. */
  readonly setTheme = (theme: BoardThemeName): void => {
    if (theme === this.themeName) return;
    this.themeName = theme;
    if (this.mounted) this.applyTheme(this.mounted);
    this.emit('theme');
  };

  /** A pointer gesture on the board is in progress (pressed, not yet released). */
  get isInteracting(): boolean {
    return this.interacting;
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
  readonly on = (event: BoardEditorEvent, listener: () => void): (() => void) =>
    this.events.on(event, listener);

  private emit(event: BoardEditorEvent): void {
    this.events.emit(event);
  }

  /** Errors of listeners, custom tools and files: to `onError`, else the console. */
  private reportError(error: unknown): void {
    (this.options.onError ?? console.error)(error);
  }

  /**
   * A read-only scene refuses local edits. A last line of defence: the board already
   * doesn't offer them.
   */
  private applyGuard(): void {
    this.scene.setEditGuard(this.readOnlyMode ? refuseEdits : null);
  }

  private replaceHistory(history?: UndoHistory): void {
    if (history === this.currentHistory) return;
    if (this.ownsHistory) this.currentHistory.dispose();
    this.ownsHistory = !history;
    this.currentHistory = history ?? new History(this.scene);
    this.unsubscribeHistory();
    this.unsubscribeHistory = this.currentHistory.subscribe(() => this.emit('history'));
    this.emit('history');
  }

  /** On a read-only board only `select`, `hand` and `comment` (see `VIEW_TOOLS`). */
  private activateTool(tool: Tool, options: ToolActivation = {}): void {
    if (this.readOnlyMode && !VIEW_TOOLS.has(tool)) return;
    this.mounted?.text.stop();
    this.toolState.setTool(tool, options);
  }

  /** The selection as the controls see it (live set). */
  private get selectionSet(): Set<string> {
    return this.mounted ? this.mounted.overlay.selection : this.pendingSelection;
  }

  private select(ids: Iterable<string>): void {
    const next = new Set<string>();
    for (const id of ids) if (this.scene.has(id) && !this.isElementLocked(id)) next.add(id);
    if (this.mounted) {
      this.mounted.overlay.selection = next;
      this.mounted.overlay.request();
    } else this.pendingSelection = next;
    this.syncSelection();
  }

  /** Elements currently selected (that still exist). */
  private selectedElements(): BoardElement[] {
    const out: BoardElement[] = [];
    for (const id of this.selectionSnapshot) {
      const element = this.scene.get(id);
      if (element) out.push(element);
    }
    return out;
  }

  private selectionBounds(): Box | null {
    return this.selectionSnapshot.length > 0 ? this.scene.bounds(this.selectionSnapshot) : null;
  }

  private setInteracting(on: boolean): void {
    if (on === this.interacting) return;
    this.interacting = on;
    this.emit('gesture');
  }

  private syncSelection(): void {
    const set = this.selectionSet;
    for (const id of set) if (this.isElementLocked(id)) set.delete(id);
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

  private undo(): void {
    if (this.readOnlyMode) return;
    this.mounted?.text.stop();
    this.select(this.currentHistory.undo());
  }

  private redo(): void {
    if (this.readOnlyMode) return;
    this.mounted?.text.stop();
    this.select(this.currentHistory.redo());
  }

  private addElements(elements: readonly BoardElement[], select: boolean): void {
    if (this.readOnlyMode) return;
    this.scene.transact(() => {
      for (const element of elements) this.scene.add(element);
    });
    if (select) this.select(elements.map((element) => element.id));
  }

  private updateElements(ids: Iterable<string>, patch: ElementUpdate): void {
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

  private deleteSelection(): void {
    if (this.selectionSnapshot.length === 0 || this.readOnlyMode) return;
    this.mounted?.text.stop();
    this.scene.removeWithConnectors(this.selectionSnapshot);
    this.select([]);
  }

  /** The removed elements leave the selection. */
  private removeElements(ids: Iterable<string>): void {
    if (this.readOnlyMode) return;
    const gone = new Set(ids);
    if (gone.size === 0) return;
    this.mounted?.text.stop();
    this.scene.removeWithConnectors(gone);
    this.select(this.selectionSnapshot.filter((id) => this.scene.has(id)));
  }

  private reorderSelection(where: 'front' | 'back'): void {
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

  private groupSelected(): void {
    if (this.readOnlyMode) return;
    const next = groupSelection(this.scene, new Set(this.selectionSnapshot));
    if (next) this.select(next);
  }

  private ungroupSelected(): void {
    if (this.readOnlyMode) return;
    const next = ungroupSelection(this.scene, new Set(this.selectionSnapshot));
    if (next) this.select(next);
  }

  /** Center of the view in world coordinates. */
  private viewCenter(): Vec2 {
    return this.cameraModel.screenToWorld({
      x: this.cameraModel.viewportWidth / 2,
      y: this.cameraModel.viewportHeight / 2,
    });
  }

  private clientToWorld(clientX: number, clientY: number): Vec2 {
    const rectangle = this.mounted?.root.getBoundingClientRect();
    return this.cameraModel.screenToWorld({
      x: clientX - (rectangle?.left ?? 0),
      y: clientY - (rectangle?.top ?? 0),
    });
  }

  private setCamera(state: Partial<CameraState>): void {
    this.animator.stop();
    this.cameraModel.set(state);
  }

  private zoomTo(to: ZoomTarget): void {
    const center = {
      x: this.cameraModel.viewportWidth / 2,
      y: this.cameraModel.viewportHeight / 2,
    };
    if (to === 'in') this.animator.zoomAt(center, this.cameraModel.zoomStep);
    else if (to === 'out') this.animator.zoomAt(center, 1 / this.cameraModel.zoomStep);
    else if (to === 'fit' || to === 'selection') {
      const bounds = to === 'fit' ? this.scene.bounds() : this.selectionBounds();
      if (bounds) this.animator.fitBox(bounds, 96);
    } else this.animator.zoomAt(center, (to === 'reset' ? 1 : to) / this.cameraModel.zoom);
  }

  /** A sticky note or shape styled like its tool makes it, in one scene change (see `elements.create`). */
  private place(kind: PlaceKind, options: CreateOptions = {}): string | null {
    if (this.readOnlyMode) return null;
    this.mounted?.text.stop();
    const { box, style, text, select = true } = options;
    const at = options.at ?? this.viewCenter();
    const sized = box && box.maxX - box.minX >= MIN_PLACE && box.maxY - box.minY >= MIN_PLACE;
    const look = { ...this.toolState.getDefaults(kind), ...style };
    const width = sized ? box.maxX - box.minX : look.width;
    const height = sized ? box.maxY - box.minY : look.height;
    const element: ShapeElement = {
      ...look,
      id: newId('s'),
      type: kind,
      x: sized ? box.minX : at.x - width / 2,
      y: sized ? box.minY : at.y - height / 2,
      width,
      height,
      rotation: 0,
      z: this.scene.maxZ() + 1,
      ...(text ? { text: textBlockOf(kind, text) } : {}),
    };
    this.scene.add(element);
    if (!select) return element.id;
    this.select([element.id]);
    if (kind === 'sticky' && !text) this.editText(element.id);
    return element.id;
  }

  /** An empty text box at `at`, opened for typing; null on a read-only board. */
  private addText(at: Vec2 = this.viewCenter(), width?: number): string | null {
    if (this.readOnlyMode) return null;
    const defaults = this.toolState.overrides('text');
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
  private editText(id: string): void {
    const mounted = this.mounted;
    if (!mounted) return;
    const token = ++this.editToken;
    requestAnimationFrame(() => {
      if (
        this.mounted === mounted &&
        token === this.editToken &&
        this.scene.has(id) &&
        !this.readOnlyMode &&
        !this.isElementLocked(id)
      )
        mounted.text.start(id);
    });
  }

  /** Closes the text being edited, and cancels an `editText` or `addText` not opened yet. */
  private stopEditing(): void {
    this.editToken++;
    this.mounted?.text.stop();
  }

  private formatText(command: TextFormatCommand): boolean {
    if (this.readOnlyMode) return false;
    return this.mounted?.text.apply(command) ?? false;
  }

  private async addFiles(files: Iterable<File>, at: Vec2 = this.viewCenter()): Promise<string[]> {
    if (this.readOnlyMode) return [];
    const ids = await importFiles(
      [...files],
      at,
      this.scene,
      this.options.upload ?? localUploader,
      (file, error) => this.reportError(new Error(`Could not add ${file.name}`, { cause: error })),
    );
    if (ids.length > 0) this.select(ids);
    return ids;
  }

  // --- Clipboard -------------------------------------------------------------------

  /** Kept by the editor for `paste`, and also written to the system clipboard. */
  private copy(): BoardClipboard | null {
    const data = this.takeCopy();
    if (data) void writeSystemClipboard(data);
    return data;
  }

  private cut(): BoardClipboard | null {
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
  private paste(data: BoardClipboard | null = this.clipboardData, at?: Vec2): string[] {
    if (!data || this.readOnlyMode) return [];
    this.mounted?.text.stop();
    const target = at ?? this.pointerWorld ?? this.viewCenter();
    const last = this.lastPaste;
    const again =
      last && last.data === data && Math.hypot(last.at.x - target.x, last.at.y - target.y) < 1e-6;
    const count = again ? last.count + 1 : 0;
    this.lastPaste = { data, at: target, count };
    const step = (PASTE_STEP_PX / this.cameraModel.zoom) * count;
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
   * clipboard. For a "Paste" button; Ctrl/⌘+V on the board doesn't need it. Never rejects.
   */
  private async pasteFromClipboard(at?: Vec2): Promise<string[]> {
    if (this.readOnlyMode) return [];
    try {
      const content = await readSystemClipboard();
      if (content?.kind === 'image') return await this.addFiles([content.file], at);
      if (content?.kind === 'board') return this.paste(content.data, at);
      if (content?.kind === 'text') {
        const id = this.pasteText(content.text, at);
        if (id) return [id];
      }
      // Nothing usable, or no permission: what this editor copied.
      return this.paste(this.clipboardData, at);
    } catch (error) {
      this.reportError(error);
      return [];
    }
  }

  /**
   * Duplicates the selection next to itself and selects the copies, one undo step
   * (Ctrl/⌘+D). Lines between selected shapes are duplicated with them.
   */
  private duplicate(): string[] {
    if (this.selectionSnapshot.length === 0 || this.readOnlyMode) return [];
    this.mounted?.text.stop();
    const step = PASTE_STEP_PX / this.cameraModel.zoom;
    const data = copyElements(this.scene, this.selectionSnapshot);
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
  private pasteText(text: string, at?: Vec2): string | null {
    if (this.readOnlyMode) return null;
    this.mounted?.text.stop();
    const target = at ?? this.pointerWorld ?? this.viewCenter();
    const block = textBlockOf('text', text);
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
    const data = copyElements(this.scene, this.selectionSnapshot);
    if (!data) return null;
    this.clipboardData = data;
    this.lastPaste = null;
    this.emit('clipboard');
    return data;
  }

  private cropImage(id: string): void {
    if (this.readOnlyMode || this.isElementLocked(id)) return;
    this.mounted?.crop.start(id);
  }

  private load(elements: readonly BoardElement[]): void {
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

  // --- Export ----------------------------------------------------------------------

  /**
   * An image of the board (PNG by default): everything, the elements `ids` (e.g. the
   * selection) or a world `area`, drawn off screen at `scale` pixels per unit without the
   * selection, handles or cursors, once images and text are ready. Browser only; works
   * whether or not the board is mounted.
   *
   * ```ts
   * const png = await editor.exportImage({ ids: editor.selection.ids, scale: 2 });
   * ```
   */
  readonly exportImage = async (options: ExportImageOptions = {}): Promise<Blob> => {
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
  };

  // --- Preview of proposed changes -------------------------------------------------

  private showPreview(draft: BoardDraft): void {
    const scene = new DraftScene(this.scene, normalizeDraft(this.scene, draft));
    this.endPreview();
    const unsubscribe = this.scene.subscribe((changes) => scene.boardChanged(changes));
    this.draft = { scene, unsubscribe };
    if (this.mounted) this.showDraft(this.mounted);
    this.emit('preview');
  }

  /** Elements deleted meanwhile by someone else are skipped. */
  private applyPreview(): string[] {
    const draft = this.draft?.scene.draft;
    if (!draft || this.readOnlyMode) return [];
    this.endPreview();
    this.mounted?.text.stop();
    const ids: string[] = [];
    this.currentHistory.batch(() =>
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

  private discardPreview(): void {
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
   * starts handling input. Resolves once the renderer runs; rejects when it can't start
   * (no WebGPU or WebGL2). Mounting again moves the board.
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
        camera: this.cameraModel,
        preserveDrawingBuffer: this.options.preserveDrawingBuffer ?? false,
        background: this.themeColors().background,
        ...gridBackdrop(this.grid, this.themeColors()),
        ...(this.options.mediaOrigins
          ? { media: { allowedOrigins: this.options.mediaOrigins } }
          : {}),
      });
    } catch (error) {
      root.remove();
      throw error;
    }
    if (token !== this.mountToken || this.destroyed) {
      renderer.destroy();
      root.remove();
      return;
    }

    const disposers: Array<() => void> = [activeBoard.mounted(this)];
    const overlay = new Overlay(overlayCanvas, this.scene, this.cameraModel);
    overlay.readOnly = this.readOnlyMode;
    overlay.selection = this.pendingSelection;
    disposers.push(renderer.onAfterRender(() => overlay.draw()));
    const text = new TextEditor(
      editorLayer,
      this.scene,
      this.cameraModel,
      renderer,
      this.historyProxy,
      (id) => !this.readOnlyMode && !this.isElementLocked(id),
    );
    const audio = new AudioController(
      this.scene,
      renderer,
      undefined,
      this.options.mediaOrigins ?? [],
    );
    const preview = new PreviewCanvas(previewCanvas, this.cameraModel, this.themeColors(), {
      backend: renderer.backend,
      ...(this.options.mediaOrigins ? { mediaOrigins: this.options.mediaOrigins } : {}),
      onError: (error) => this.reportError(error),
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
      this.select([id]);
      if (this.isElementLocked(id)) {
        this.stopEditing();
        return;
      }
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
      attachControls(stage, this.scene, this.cameraModel, overlay, this.toolState, this.animator, {
        crop,
        history: this.historyProxy,
        onQuickCreate: (id) => this.editText(id),
        createText: (at, width) => void this.addText(at, width),
        editText: (id) => this.editText(id),
        linkAt: (id, world) => {
          const element = this.scene.get(id);
          return element && isShape(element)
            ? linkAtPoint(element, renderer.textLayout(element), world, 2 / this.cameraModel.zoom)
            : null;
        },
        openLink: this.options.openLink ?? openLink,
        measurer: renderer.measurer,
        audio,
        place: (kind, at, box) => void this.place(kind, box ? { at, box } : { at }),
        addComment: (at) => this.options.onComment?.(at),
        zoom: (to) => this.zoomTo(to),
        snapping: this.options.snapping ?? true,
        readOnly: () => this.readOnlyMode,
        isLocked: this.isElementLocked,
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
      hasSelection: () => this.selectionSnapshot.length > 0,
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
    this.emit('destroy');
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
