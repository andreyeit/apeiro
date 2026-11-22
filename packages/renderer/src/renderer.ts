import {
  FONT_FAMILIES,
  GRID_MIN_PX,
  gridStep,
  boxIntersects,
  isConnector,
  isMedia,
  unpackColor,
  type BoardElement,
  type Camera,
  type Scene,
  type SceneChanges,
  type ShapeElement,
  type TextLayout,
} from '@apeiro/core';
import type { BackendFactory, BackendKind, GridLevel, RenderBackend } from './backend';
import { CanvasSize, MAX_PIXEL_RATIO } from './canvas-size';
import { ColorTheme } from './color-theme';
import { shapeDepth } from './depth';
import { InstanceStore } from './layers/instance-store';
import { LineLayer } from './layers/line-layer';
import { TextLayer, type TextLayerOptions } from './layers/text-layer';
import type { AudioVisualState, AudioWidgetStyle } from './media/audio-widget';
import { MediaPass, type MediaDrawItem, type MediaPassOptions } from './media/media-pass';
import {
  CanvasFontMeasurer,
  createColorRasterizer,
  createSdfRasterizer,
  cssFont,
  SDF_CUTOFF,
} from './text/font';
import { GlyphAtlas } from './text/glyph-atlas';
import { createWebGlBackend } from './webgl/gl-backend';
import { requestWebGpuBackend } from './webgpu/gpu-backend';

/** Text whose glyphs make the browser load both the Latin and the Cyrillic subset of a face. */
const FACE_SAMPLE = 'AaЯя';

export type GridStyle = 'dots' | 'lines';

/** Elements drawn by the line pass: connectors and pen strokes. */
const drawnAsLine = (element: BoardElement) => isConnector(element) || element.type === 'ink';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  scene: Scene;
  camera: Camera;
  /** Packed 0xRRGGBBAA. */
  background?: number;
  /** Packed 0xRRGGBBAA, alpha controls the grid's opacity. 0 disables the grid. */
  gridColor?: number;
  /** Dots at the grid's crossings (default) or thin lines, like Miro's. */
  gridStyle?: GridStyle;
  /** Cap for devicePixelRatio (default 3: the screen's own on every common device). */
  maxPixelRatio?: number;
  /** Fixed pixels per CSS pixel instead of the screen's (e.g. 1 when rendering an image). */
  pixelRatio?: number;
  /**
   * See-through canvas: `background`'s alpha is kept (0: nothing but the elements), so the
   * page or another canvas shows under it.
   */
  transparent?: boolean;
  /**
   * Keep the frame after compositing (needed for screenshots/readback outside the render
   * call). Only WebGL has this, so `createRenderer` picks WebGL for it unless told otherwise.
   */
  preserveDrawingBuffer?: boolean;
  text?: TextLayerOptions;
  /** Which media URLs may be loaded (by default: blob:, data:, the page's own origin). */
  media?: MediaPassOptions;
}

export interface CreateRendererOptions extends RendererOptions {
  /** `auto` (default): WebGPU when the browser has it, otherwise WebGL2. */
  backend?: 'auto' | BackendKind;
}

export interface RenderStats {
  instances: number;
  holes: number;
  /** CPU time of the last frame (GPU work is asynchronous and not included). */
  cpuMs: number;
  uploadedBytes: number;
  frames: number;
  glyphs: number;
  /** Connector segment + cap instances. */
  lineInstances: number;
  /** Time of the last text rebuild (only happens when the view leaves the built region or content changes). */
  textBuildMs: number;
  atlasSize: number;
}

/**
 * Creates a renderer on the best GPU API available: WebGPU if the browser offers a working
 * device, WebGL2 otherwise. Asynchronous because a WebGPU device is.
 */
export async function createRenderer(options: CreateRendererOptions): Promise<BoardRenderer> {
  const want = options.backend ?? 'auto';
  const tryGpu = want === 'webgpu' || (want === 'auto' && !options.preserveDrawingBuffer);
  if (tryGpu) {
    const gpu = await requestWebGpuBackend(options.canvas);
    if (gpu) return new BoardRenderer(options, gpu);
    if (want === 'webgpu') console.warn('apeiro: WebGPU is not available, using WebGL');
  }
  return new BoardRenderer(options, createWebGlBackend);
}

/**
 * Draws a Scene through a Camera. Renders on demand: a frame is scheduled only
 * when the scene or camera changes, so an idle board costs nothing.
 *
 * Everything that decides what to draw lives here and is the same for every GPU API;
 * the backend (WebGPU or WebGL2) uploads the CPU layers and issues the draw calls.
 */
export class BoardRenderer {
  readonly stats: RenderStats = {
    instances: 0,
    holes: 0,
    cpuMs: 0,
    uploadedBytes: 0,
    frames: 0,
    glyphs: 0,
    lineInstances: 0,
    textBuildMs: 0,
    atlasSize: 0,
  };
  /** Shared with UI code (e.g. a text editor overlay) so wrapping matches exactly. */
  readonly measurer: CanvasFontMeasurer;

  private readonly canvas: HTMLCanvasElement;
  private readonly scene: Scene;
  private readonly camera: Camera;
  private readonly gpu: RenderBackend;
  private readonly store = new InstanceStore();
  private background: [number, number, number, number];
  private gridColor: [number, number, number, number];
  private gridStyle: GridStyle;
  private readonly maxPixelRatio: number;
  private pixelRatio = 1;
  private readonly size: CanvasSize;
  private readonly fixedPixelRatio: number | null;
  private frame = 0;
  private needsRebuild = true;
  private disposers: Array<() => void> = [];
  private afterRender = new Set<() => void>();
  private readonly sdfAtlas = new GlyphAtlas({ channels: 1, maxSize: 4096 });
  private readonly colorAtlas = new GlyphAtlas({ channels: 4, initialSize: 512, maxSize: 2048 });
  private readonly textLayer: TextLayer;
  private readonly lineLayer = new LineLayer();
  private colorTheme = new ColorTheme();
  private readonly mediaPass: MediaPass;
  /** Image and audio elements (few, tracked directly instead of querying the viewport) → their src. */
  private mediaSource = new Map<string, string>();
  /** How many elements use each src: a texture is freed when the last one goes away. */
  private sourceReferences = new Map<string, number>();
  /** Connectors added/changed since the last frame. */
  private pendingLines = new Set<string>();
  /** Which board font faces were loaded when glyphs were last reset. */
  private fontSignature = '';
  /** A font finished loading since the last frame: maybe one of the board's faces. */
  private fontsChanged = false;
  private textErrorLogged = false;

  /** Without a backend factory it draws with WebGL2; `createRenderer` picks one for you. */
  constructor(options: RendererOptions, backend: BackendFactory = createWebGlBackend) {
    this.canvas = options.canvas;
    this.scene = options.scene;
    this.camera = options.camera;
    this.background = unpackColor(options.background ?? 0xf5f5f7ff);
    this.gridColor = unpackColor(options.gridColor ?? 0x9ca3af80);
    this.gridStyle = options.gridStyle ?? 'dots';
    this.maxPixelRatio = options.maxPixelRatio ?? MAX_PIXEL_RATIO;
    this.fixedPixelRatio = options.pixelRatio ?? null;
    this.measurer = new CanvasFontMeasurer();
    this.textLayer = new TextLayer(
      this.sdfAtlas,
      this.colorAtlas,
      this.measurer,
      { sdf: createSdfRasterizer(), color: createColorRasterizer() },
      options.text,
    );

    this.gpu = backend({
      canvas: this.canvas,
      store: this.store,
      lineLayer: this.lineLayer,
      textLayer: this.textLayer,
      sdfAtlas: this.sdfAtlas,
      colorAtlas: this.colorAtlas,
      sdfEdge: 1 - SDF_CUTOFF,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      transparent: options.transparent ?? false,
      onLost: () => {
        this.mediaPass.lose();
        cancelAnimationFrame(this.frame);
        this.frame = 0;
      },
      onRestored: () => {
        this.mediaPass.initialize();
        this.requestRender();
      },
    });
    this.mediaPass = new MediaPass(this.gpu.textures, () => this.requestRender(), options.media);
    this.mediaPass.colorOf = (type, color) => this.colorTheme.of(type, color);
    if (this.gpu.ready) this.mediaPass.initialize();

    this.disposers.push(
      this.scene.subscribe((changes) => this.onSceneChanges(changes)),
      this.camera.subscribe(() => this.requestRender()),
    );
    // Web fonts load asynchronously: glyphs and metrics cached before that belong to the
    // fallback. Each face loads separately and other fonts on the page fire the same
    // event, so glyphs are only dropped when one of the board's faces became available.
    const fontSet = typeof document !== 'undefined' ? document.fonts : undefined;
    if (fontSet) {
      this.fontSignature = this.loadedFaces();
      fontSet.addEventListener('loadingdone', this.onFontsLoaded);
      this.disposers.push(() => fontSet.removeEventListener('loadingdone', this.onFontsLoaded));
      this.loadFaces();
    }
    this.size = new CanvasSize(this.canvas, () => this.resize());
    this.disposers.push(() => this.size.dispose());
    this.resize();
  }

  /** The GPU API this renderer draws with. */
  get backend(): BackendKind {
    return this.gpu.kind;
  }

  /** Drops cached glyphs and text layouts, e.g. after a font finished loading. */
  refreshFonts(): void {
    this.fontSignature = this.loadedFaces();
    this.measurer.clear();
    this.sdfAtlas.reset();
    this.colorAtlas.reset();
    this.textLayer.resetLayouts();
    this.requestRender();
  }

  /** Layout the renderer uses for an element's text (cached). For editors and hit testing text. */
  textLayout(element: ShapeElement): TextLayout | undefined {
    return this.textLayer.layoutOf(element);
  }

  /** Hides an element's text, e.g. while a DOM editor shows it instead. */
  setTextHidden(id: string, hidden: boolean): void {
    this.textLayer.setHidden(id, hidden);
    this.requestRender();
  }

  /**
   * Syncs the drawing buffer with the canvas's size on screen, pixel for pixel (see
   * `CanvasSize`). The renderer watches its canvas itself; call it after a layout change
   * it can't see (e.g. a canvas that was hidden).
   */
  resize(): void {
    const metrics = this.size.measure(this.maxPixelRatio, this.fixedPixelRatio);
    const cleared = this.size.apply(metrics);
    this.pixelRatio = metrics.ratio;
    this.camera.setViewport(metrics.cssWidth, metrics.cssHeight);
    if (cleared && this.gpu.ready) {
      // Resizing the buffer cleared it, and ResizeObserver runs after this frame's
      // animation callbacks: waiting for the next one would show an empty canvas (flicker).
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.render();
    } else this.requestRender();
  }

  /**
   * Colors to draw in place of stored ones, e.g. for a dark theme: [stored, drawn] pairs
   * of 0xRRGGBB. Elements of the `keep` types are drawn as stored. Redraws everything.
   */
  setColorTheme(
    pairs: ReadonlyArray<readonly [number, number]>,
    keep: Iterable<string> = [],
  ): void {
    const theme = new ColorTheme();
    theme.set(pairs, keep);
    this.colorTheme = theme;
    this.store.theme = theme;
    this.lineLayer.theme = theme;
    this.textLayer.theme = theme;
    this.needsRebuild = true; // rewrites every shape and line with the new colors
    this.textLayer.markDirty();
    this.requestRender();
  }

  /** The color drawn for an element's stored color (DOM editors show text the same way). */
  drawnColor(type: string, color: number): number {
    return this.colorTheme.of(type, color);
  }

  /** Changes the board's background and grid (e.g. when the UI switches to a dark theme). */
  setBackdrop(backdrop: { background?: number; gridColor?: number; gridStyle?: GridStyle }): void {
    if (backdrop.background !== undefined) this.background = unpackColor(backdrop.background);
    if (backdrop.gridColor !== undefined) this.gridColor = unpackColor(backdrop.gridColor);
    if (backdrop.gridStyle !== undefined) this.gridStyle = backdrop.gridStyle;
    this.requestRender();
  }

  requestRender(): void {
    if (this.frame || !this.gpu.ready) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Called after each frame; overlays (selection, cursors) can sync to it. */
  onAfterRender(callback: () => void): () => void {
    this.afterRender.add(callback);
    return () => this.afterRender.delete(callback);
  }

  /** Renders synchronously. Normally you want `requestRender`. */
  render(): void {
    if (!this.gpu.ready) return;
    const startTime = performance.now();

    if (this.fontsChanged) {
      this.fontsChanged = false;
      // Glyphs and metrics cached so far belong to the fallback font.
      if (this.loadedFaces() !== this.fontSignature) this.refreshFonts();
    }
    if (this.needsRebuild) {
      this.store.rebuild(this.scene.sortedByZ());
      this.needsRebuild = false;
      this.textLayer.markDirty(); // slots (and therefore text depths) changed
      this.lineLayer.rebuild(this.scene, (id) => this.store.slot(id));
      this.pendingLines.clear();
    }
    this.updateLines();
    const { x, y, zoom } = this.camera.getState();
    // Text comes from element data (other participants, eventually): whatever it contains,
    // a failure there must not stop shapes, lines and media from being drawn.
    let textDrawn = true;
    try {
      this.textLayer.update(this.scene, this.camera.viewportBounds(), zoom, this.pixelRatio, (id) =>
        this.store.slot(id),
      );
    } catch (error) {
      textDrawn = false;
      if (!this.textErrorLogged) {
        this.textErrorLogged = true;
        console.error('apeiro: text layout failed, text is not drawn this frame', error);
      }
    }

    this.gpu.render({
      x,
      y,
      zoom,
      viewportWidth: this.camera.viewportWidth,
      viewportHeight: this.camera.viewportHeight,
      pixelRatio: this.pixelRatio,
      background: this.background,
      grid: this.gridColor[3] > 0 ? this.grid(zoom) : null,
      media: this.mediaPass.prepare(this.visibleMedia(), x, y, zoom, this.pixelRatio),
      drawText: textDrawn,
    });

    this.stats.glyphs = this.textLayer.count;
    this.stats.lineInstances = this.lineLayer.count;
    this.stats.uploadedBytes += this.gpu.takeUploadedBytes();
    this.stats.textBuildMs = this.textLayer.lastBuildMs;
    this.stats.atlasSize = this.sdfAtlas.size;
    this.stats.instances = this.store.count - this.store.holeCount;
    this.stats.holes = this.store.holeCount;
    this.stats.cpuMs = performance.now() - startTime;
    this.stats.frames++;
    // One failing overlay must not keep the others (or the next frames) from running.
    for (const callback of this.afterRender) {
      try {
        callback();
      } catch (error) {
        console.error('apeiro: an after-render callback failed', error);
      }
    }
    // Glyphs/layouts that didn't fit this frame's budget arrive in the next ones.
    if (textDrawn && this.textLayer.needsMoreFrames) this.requestRender();
  }

  /** Playback state of an audio element (owned by the app's audio player); redraws it. */
  setAudioState(id: string, state: AudioVisualState): void {
    this.mediaPass.setAudioState(id, state);
    this.requestRender();
  }

  /** Colours of the audio players, e.g. the app's theme tokens; unset fields keep theirs. */
  setAudioStyle(style: Partial<AudioWidgetStyle>): void {
    this.mediaPass.setAudioStyle(style);
    this.requestRender();
  }

  /** True while images are still loading. */
  get mediaPending(): boolean {
    return this.mediaPass.pending;
  }

  /** True while text is still being rasterized/laid out over several frames. */
  get textPending(): boolean {
    return this.textLayer.needsMoreFrames;
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.afterRender.clear();
    this.mediaPass.dispose();
    this.gpu.destroy();
  }

  /** The grid's levels this frame; null when the zoom makes no sense. */
  private grid(zoom: number) {
    if (!(zoom > 0) || !Number.isFinite(zoom)) return null;
    const spacing = gridStep(zoom); // the same steps moves snap to
    // Fine level fades in as it grows; the coarse level (4x) is always visible,
    // so switching levels never pops.
    const fade = Math.min(1, Math.max(0, (spacing * zoom - GRID_MIN_PX) / GRID_MIN_PX));
    const lines = this.gridStyle === 'lines';
    // Coarse lines are a subset of the fine ones: once the fine level is fully in, drawing
    // both would make every 4th line darker. Dots stay layered (the coarse ones read as a frame).
    const levels: GridLevel[] = [
      { spacing: spacing * 4, fade: lines ? 1 - fade : 1 },
      { spacing, fade },
    ].filter((level) => level.fade > 0);
    return { color: this.gridColor, lines, levels };
  }

  private visibleMedia(): MediaDrawItem[] {
    const view = this.camera.viewportBounds();
    const items: MediaDrawItem[] = [];
    for (const id of this.mediaSource.keys()) {
      const element = this.scene.get(id);
      const bounds = this.scene.getBounds(id);
      const slot = this.store.slot(id);
      if (
        !element ||
        !bounds ||
        slot === undefined ||
        !boxIntersects(bounds, view) ||
        element.type === 'connector'
      )
        continue;
      if (Math.max(element.width, element.height) * this.camera.zoom < 1) continue; // sub-pixel
      items.push({ element, depth: shapeDepth(slot) });
    }
    // Paint order: overlapping images with transparent pixels blend bottom to top, as
    // `bringToFront`/`sendToBack` say, not in the order they were added. Depth decreases upwards.
    return items.sort((first, second) => second.depth - first.depth);
  }

  /**
   * A font finished loading, maybe one of the board's faces. Faces finish one by one (and
   * the event fires for every font on the page): the check and the reset happen once, in
   * the next frame, however many arrived meanwhile.
   */
  private readonly onFontsLoaded = () => {
    this.fontsChanged = true;
    this.requestRender();
  };

  /** Canvas measuring doesn't make the browser fetch a web font: asks for every face. */
  private loadFaces(): void {
    const fontSet = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fontSet) return;
    for (const face of this.faces())
      fontSet.load(face, FACE_SAMPLE).then(this.onFontsLoaded, () => undefined);
  }

  /** Every face text can use: each family of `FONT_FAMILIES` in regular/bold/italic. */
  private faces(): string[] {
    const out: string[] = [];
    for (let variant = 0; variant < FONT_FAMILIES.length * 4; variant++)
      out.push(cssFont(variant, 16));
    return out;
  }

  /** Load state of the board's font faces (Latin and Cyrillic subsets). */
  private loadedFaces(): string {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts) return '';
    return this.faces()
      .map((font) => (fonts.check(font, FACE_SAMPLE) ? '1' : '0'))
      .join('');
  }

  private onSceneChanges(changes: SceneChanges): void {
    this.textLayer.applyChanges(changes);
    for (const id of changes.removed) {
      this.lineLayer.remove(id);
      this.pendingLines.delete(id);
      this.trackMedia(id, undefined);
    }
    for (const element of changes.added)
      if (drawnAsLine(element)) this.pendingLines.add(element.id);
    for (const element of [...changes.added, ...changes.updated])
      this.trackMedia(element.id, isMedia(element) ? element.media.source : undefined);
    for (const element of changes.updated)
      if (drawnAsLine(element)) this.pendingLines.add(element.id);
    if (!this.needsRebuild) {
      if (changes.orderChanged) this.needsRebuild = true;
      else {
        for (const id of changes.removed) this.store.remove(id);
        for (const element of changes.updated)
          if (!this.store.update(element)) this.needsRebuild = true;
        if (!this.store.tryAppend(changes.added)) this.needsRebuild = true;
        if (this.store.needsCompaction()) this.needsRebuild = true;
      }
    }
    this.requestRender();
  }

  /** Keeps `mediaSource`/`sourceReferences` in sync and frees GPU resources nobody uses any more. */
  private trackMedia(id: string, source: string | undefined): void {
    const previous = this.mediaSource.get(id);
    if (previous === source) return;
    if (previous !== undefined) {
      const count = (this.sourceReferences.get(previous) ?? 1) - 1;
      if (count > 0) this.sourceReferences.set(previous, count);
      else {
        this.sourceReferences.delete(previous);
        this.mediaPass.releaseImage(previous);
      }
      this.mediaPass.releaseAudio(id);
    }
    if (source === undefined) {
      this.mediaSource.delete(id);
      return;
    }
    this.mediaSource.set(id, source);
    this.sourceReferences.set(source, (this.sourceReferences.get(source) ?? 0) + 1);
  }

  /** Rewrites connectors changed since the last frame (after slots are up to date). */
  private updateLines(): void {
    if (this.lineLayer.needsCompaction()) {
      this.lineLayer.rebuild(this.scene, (id) => this.store.slot(id));
      this.pendingLines.clear();
      return;
    }
    for (const id of this.pendingLines) {
      const element = this.scene.get(id);
      if (element && isConnector(element)) {
        this.lineLayer.set(element, this.scene.connectorGeometry(id), this.store.slot(id));
      } else if (element && element.type === 'ink') {
        this.lineLayer.setInk(element, this.store.slot(id));
      }
    }
    this.pendingLines.clear();
  }
}
