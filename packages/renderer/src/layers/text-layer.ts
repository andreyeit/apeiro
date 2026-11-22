import {
  AUTO_GROW_SHARE,
  boxContainsBox,
  boxIntersects,
  inflateBox,
  isColorGlyph,
  isShape,
  layoutText,
  textArea,
  type BoardElement,
  type Box,
  type FontMeasurer,
  type FontVariant,
  type LaidOutGlyph,
  type Scene,
  type SceneChanges,
  type ShapeElement,
  type TextBlock,
  type TextLayout,
} from '@apeiro/core';
import { ColorTheme } from '../color-theme';
import { textDepth } from '../depth';
import type { BitmapRasterizer, GlyphRasterizer } from '../text/font';
import type { AtlasGlyph, GlyphAtlas } from '../text/glyph-atlas';
import { DirtyRanges, type BufferUpload } from './buffer-upload';
import {
  growBuffer,
  vec4Attributes,
  writeColorBytes,
  type InstanceLayout,
} from './instance-layout';

/**
 * Per-quad instance (interleaved, 56 bytes):
 *   0  f32 anchorX, anchorY  element center (world)
 *   8  f32 offsetX, offsetY  quad top-left relative to the center, unrotated
 *   16 f32 width, height, rotation, depth
 *   32 f32 startU, startV, endU, endV  normalized atlas coordinates
 *   48 f32 mode              MODE_*
 *   52 u8x4 color
 */
export const GLYPH_STRIDE = 56;
const FLOATS = GLYPH_STRIDE / 4;
const COLOR_BYTE = 52;

export const GLYPH_LAYOUT: InstanceLayout = {
  stride: GLYPH_STRIDE,
  attributes: [
    ...vec4Attributes(0, 3),
    { format: 'float32', components: 1, offset: 48 },
    { format: 'unorm8', components: 4, offset: COLOR_BYTE },
  ],
};

export const MODE_SDF = 0;
export const MODE_COLOR = 1;
/** Solid rectangle: underline, strike-through, greeking bars. */
export const MODE_SOLID = 2;
/**
 * A glyph rasterized at exactly its size on screen and drawn pixel for pixel (its element's
 * anchor snapped to the device pixel grid), the way the browser draws text: as crisp as the
 * page's own text. Used once the zoom has settled; while it changes, glyphs come from the
 * distance fields, which scale smoothly.
 */
export const MODE_BITMAP = 3;
/** Horizontal glyph positions keep this many steps per pixel (spacing stays even). */
const SUBPIXEL_STEPS = 4;
/** Frames the zoom must stay the same before text is drawn from exact-size bitmaps. */
const SETTLE_FRAMES = 3;

/** Raster sizes. A glyph is drawn from the smallest tier that is at most ~1.5x magnified. */
export const SDF_TIERS = [32, 64, 128, 256, 512] as const;
/** Bitmaps don't scale down as well as distance fields: small emoji get their own tier. */
export const COLOR_TIERS = [16, 32, 64, 128, 256] as const;
const MAX_MAGNIFICATION = 1.5;
/**
 * Largest tier rasterized ahead of time (see `prefetchGlyphs`). Bigger ones cost a lot of
 * atlas space and rasterization (a 512 px glyph takes 64 of the 400 units of a frame).
 */
const PREFETCH_MAX_TIER = 256;
/** Glyphs waiting to be rasterized ahead of time, at most. */
const PREFETCH_MAX_GLYPHS = 4096;
/** Memory for quads kept per element between builds (oldest blocks are dropped first). */
const BLOCK_CACHE_BYTES = 32 * 1024 * 1024;

export interface TextLayerOptions {
  /** Below this on-screen font size (CSS px) glyphs are replaced by line bars. */
  minGlyphPx?: number;
  /** Below this on-screen font size text is not drawn at all. */
  minGreekPx?: number;
  /** Upper bound of quads per build. */
  maxQuads?: number;
  /**
   * Time per frame spent on actual work (layout, rasterization); the rest continues next frame.
   * Iterating already prepared text does not count, so progress never starves.
   */
  budgetMs?: number;
  /** Work units per frame: one per layout, one per 64x64 rasterized px. Guards coarse timers. */
  budgetUnits?: number;
  /** Max cached layouts (FIFO eviction). */
  layoutCacheSize?: number;
  /**
   * Once the zoom settles, draw unrotated text from glyphs rasterized at their exact size on
   * screen (see `MODE_BITMAP`) instead of distance fields (default true).
   */
  crisp?: boolean;
}

export interface TextRasterizers {
  sdf: GlyphRasterizer;
  color: GlyphRasterizer;
  bitmap: BitmapRasterizer;
}

/** A glyph to rasterize ahead of time at the tier above the one it is drawn from. */
interface PrefetchGlyph {
  atlas: GlyphAtlas;
  size: number;
  cluster: string;
  variant: FontVariant;
  rasterize: GlyphRasterizer;
}

interface CachedLayout {
  width: number;
  height: number;
  layout: TextLayout;
}

/** Everything `textArea` and the layout depend on: if any of it changes, text is laid out again. */
interface LayoutInputs {
  text: TextBlock;
  width: number;
  height: number;
  strokeWidth: number;
  type: ShapeElement['type'];
  sides: ShapeElement['sides'];
}

/** Quads emitted for an element in the current build (empty if it was too small). */
interface Range extends LayoutInputs {
  start: number;
  end: number;
  /** Drawn from exact-size bitmaps: valid only unrotated and at the built scale. */
  crisp: boolean;
}

/**
 * An element's quads from an earlier build, ready to be copied into the next one. Anchor,
 * rotation and depth are patched when the element moved; anything else that changes the
 * quads (text, size, raster tier, atlas contents, colours) makes the block invalid.
 */
interface QuadBlock extends LayoutInputs {
  /** `layout.maxFontSize`: picks glyphs, bars or nothing without the layout. */
  maxFontSize: number;
  greek: boolean;
  /** Device px per world unit over which every glyph keeps its raster tier: (minPx, maxPx]. */
  minPx: number;
  maxPx: number;
  tierCap: number;
  /** Device px per world unit its bitmap glyphs were made for, null for distance fields. */
  crispScale: number | null;
  generations: string;
  theme: ColorTheme;
  centerX: number;
  centerY: number;
  rotation: number;
  depth: number;
  /** Null for text that was too small to draw: only its `maxFontSize` is kept. */
  quads: Float32Array | null;
}

/** Bytes a block without quads is counted as in the cache budget. */
const SIZE_ONLY_BYTES = 256;

export type TextUpload = BufferUpload;

/**
 * Builds quads for text that is visible right now. Cost is bounded by the screen,
 * not the board: only elements in the viewport (+50%) are considered, tiny text
 * becomes line bars, and invisible text costs nothing.
 *
 * Geometry-only changes (dragging) patch the element's quads in place; anything
 * else triggers a rebuild of the visible set. A rebuild copies each element's quads from
 * the previous build when they are still valid, so panning and zooming mostly copy memory.
 * Text that ran out of the frame budget (layout, rasterization) is finished in later
 * frames by appending just that text, not by building everything again.
 */
export class TextLayer {
  /** Colors drawn in place of the stored ones (set by the renderer). */
  theme = new ColorTheme();
  readonly options: Required<TextLayerOptions>;
  private layouts = new Map<TextBlock, CachedLayout>();
  private blocks = new Map<string, QuadBlock>();
  private blockBytes = 0;
  private buffer = new ArrayBuffer(4096 * GLYPH_STRIDE);
  private floats = new Float32Array(this.buffer);
  private bytes = new Uint8Array(this.buffer);
  private quadCount = 0;
  private covered: Box | null = null;
  private builtZoom = 0;
  private builtPixelRatio = 0;
  private builtGenerations = '';
  private builtTierCap = SDF_TIERS.length - 1;
  /** Device px per world unit of the build's bitmap glyphs, null if it used distance fields. */
  private builtCrispScale: number | null = null;
  /** Device px per world unit of the last frame, and for how many frames it stayed so. */
  private lastScale = 0;
  private steadyFrames = 0;
  private dirty = true;
  private incomplete = false;
  /** The quad budget ran out in this build: the rest of the text is skipped. */
  private full = false;
  /** Elements to finish in a later frame: their layout or the wanted glyph tier was missing. */
  private pending: string[] = [];
  /**
   * Glyphs at the tier above the one they are drawn from, by atlas key: rasterized in frames
   * with budget to spare, so zooming in finds them ready instead of magnifying the smaller
   * tier (rounded corners, smudged strokes) until they are rasterized.
   */
  private prefetch = new Map<string, PrefetchGlyph>();
  private considered = new Map<string, Range>();
  private hidden = new Set<string>();
  private changed = new DirtyRanges();
  private spentMs = 0;
  private spentUnits = 0;
  /**
   * Upper bound of the font sizes on the board (-1: not computed yet). Only grows: when even
   * the largest text is too small to draw, a build skips the board entirely.
   */
  private maxTextSize = -1;
  /** Set when a glyph came from another tier than wanted (or was missing): don't cache it. */
  private usedFallback = false;
  /** Tier validity of the glyphs emitted for the current element, see `QuadBlock`. */
  private minPx = 0;
  private maxPx = Infinity;
  lastBuildMs = 0;

  constructor(
    private readonly sdfAtlas: GlyphAtlas,
    private readonly colorAtlas: GlyphAtlas,
    private readonly measurer: FontMeasurer,
    private readonly rasterizers: TextRasterizers,
    options: TextLayerOptions = {},
  ) {
    this.options = {
      minGlyphPx: options.minGlyphPx ?? 2.5,
      minGreekPx: options.minGreekPx ?? 1,
      maxQuads: options.maxQuads ?? 400_000,
      budgetMs: options.budgetMs ?? 6,
      budgetUnits: options.budgetUnits ?? 400,
      layoutCacheSize: options.layoutCacheSize ?? 20_000,
      crisp: options.crisp ?? true,
    };
  }

  get count(): number {
    return this.quadCount;
  }
  get data(): ArrayBuffer {
    return this.buffer;
  }
  /** True while glyphs or layouts are still being produced over several frames. */
  get needsMoreFrames(): boolean {
    return this.incomplete || this.prefetch.size > 0 || this.awaitingCrisp;
  }

  /** The zoom stopped, but the text is not drawn from exact-size bitmaps yet. */
  private get awaitingCrisp(): boolean {
    return this.options.crisp && this.lastScale > 0 && this.builtCrispScale !== this.lastScale;
  }

  /** Returns what changed in the CPU buffer since the last call. */
  takeUpload(): TextUpload {
    return this.changed.take();
  }

  /** Forces a full upload (e.g. after a lost context). */
  markUploadAll(): void {
    this.changed.markAll();
  }

  setHidden(id: string, hidden: boolean): void {
    if (hidden ? this.hidden.has(id) : !this.hidden.has(id)) return;
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Drops cached layouts, e.g. after a font finished loading. */
  resetLayouts(): void {
    this.layouts.clear();
    this.blocks.clear();
    this.prefetch.clear();
    this.blockBytes = 0;
    this.dirty = true;
  }

  /** Cached layout of an element's text (computed synchronously if missing). */
  layoutOf(element: ShapeElement): TextLayout | undefined {
    if (!element.text) return undefined;
    return this.layout(element, element.text, true);
  }

  /**
   * Applies scene changes: moves quads of elements that only moved/rotated,
   * and schedules a rebuild for anything else that affects visible text.
   */
  applyChanges(changes: SceneChanges): void {
    for (const id of changes.removed) this.forgetBlock(id);
    if (this.maxTextSize >= 0) {
      for (const element of changes.added) this.noteTextSize(element);
      for (const element of changes.updated) this.noteTextSize(element);
    }
    if (this.dirty || !this.covered) return;
    const covered = this.covered;
    for (const id of changes.removed) {
      const range = this.considered.get(id);
      if (range) this.hideRange(range);
      this.considered.delete(id);
    }
    for (const element of changes.added) {
      if (isShape(element) && element.text && this.overlaps(element, covered)) {
        this.dirty = true;
        return;
      }
    }
    for (const element of changes.updated) {
      if (!isShape(element)) continue;
      const range = this.considered.get(element.id);
      if (!range) {
        if (element.text && this.overlaps(element, covered)) {
          this.dirty = true;
          return;
        }
        continue;
      }
      // Bitmap glyphs can't turn: a rotation (or back to none) needs the other kind.
      const crispNow = this.builtCrispScale !== null && element.rotation === 0;
      if (!sameLayoutInputs(range, element) || range.crisp !== crispNow) {
        this.dirty = true;
        return;
      }
      this.moveRange(range, element);
    }
  }

  /** Rebuilds quads if the view left the built region, zoom changed notably, or content changed. */
  update(
    scene: Scene,
    view: Box,
    zoom: number,
    pixelRatio: number,
    slotOf: (id: string) => number | undefined,
  ): void {
    // Bitmap glyphs once the zoom has stayed the same for a few frames.
    const scale = zoom * pixelRatio;
    this.steadyFrames = scale === this.lastScale ? this.steadyFrames + 1 : 0;
    this.lastScale = scale;
    const crispScale = this.options.crisp && this.steadyFrames >= SETTLE_FRAMES ? scale : null;
    if (crispScale !== this.builtCrispScale) this.dirty = true;
    const zoomChanged = zoom > this.builtZoom * 1.25 || zoom < this.builtZoom / 1.25;
    const sameView =
      !zoomChanged &&
      pixelRatio === this.builtPixelRatio &&
      this.builtGenerations === this.generations() &&
      this.covered !== null &&
      boxContainsBox(this.covered, view);
    if (!this.dirty && !this.incomplete && sameView) {
      // Nothing to build: the frame's budget goes to glyphs for zooming in.
      if (this.prefetch.size > 0) {
        this.spentMs = 0;
        this.spentUnits = 0;
        this.prefetchGlyphs();
      }
      return;
    }
    const startTime = performance.now();
    this.spentMs = 0;
    this.spentUnits = 0;
    if (this.maxTextSize < 0) {
      this.maxTextSize = 0;
      for (const element of scene.all()) this.noteTextSize(element);
    }
    if (!this.dirty && sameView) {
      // Only work left over from earlier frames: add it to what is already built.
      this.resume(scene, zoom, pixelRatio, slotOf);
      this.lastBuildMs = performance.now() - startTime;
      return;
    }
    // An atlas change mid-build invalidates already written UVs (they are normalized by the
    // atlas size): build again. If an atlas had to start over, cap the tier so the visible
    // set fits.
    let tierCap = SDF_TIERS.length - 1;
    let settled = false;
    for (let attempt = 0; attempt < 3 && !settled; attempt++) {
      const before = this.generations();
      const resets = this.resets();
      this.build(scene, view, zoom, pixelRatio, slotOf, tierCap, crispScale);
      settled = this.generations() === before;
      if (this.resets() !== resets) tierCap = Math.max(0, tierCap - 1);
    }
    // The last attempt still changed an atlas: some quads point at stale atlas positions.
    // Build again next frame rather than keep them.
    if (!settled) {
      this.dirty = true;
      this.incomplete = true;
    }
    this.lastBuildMs = performance.now() - startTime;
  }

  /** Changes whenever written atlas UVs become stale: a reset, or growth (UVs are normalized). */
  private generations(): string {
    const { sdfAtlas, colorAtlas } = this;
    return `${sdfAtlas.generation}:${sdfAtlas.size}:${colorAtlas.generation}:${colorAtlas.size}`;
  }

  private resets(): string {
    return `${this.sdfAtlas.generation}:${this.colorAtlas.generation}`;
  }

  private build(
    scene: Scene,
    view: Box,
    zoom: number,
    pixelRatio: number,
    slotOf: (id: string) => number | undefined,
    tierCap: number,
    crispScale: number | null,
  ): void {
    // The viewport and half of it around: small pans need no rebuild.
    const covered = inflateBox(view, (view.maxX - view.minX) * 0.5, (view.maxY - view.minY) * 0.5);
    this.quadCount = 0;
    this.considered.clear();
    this.incomplete = false;
    this.full = false;
    this.pending = [];
    const generations = this.generations();

    // Zoomed out so far that even the largest text on the board is invisible: nothing to visit.
    if (this.maxTextSize * zoom >= this.options.minGreekPx) {
      for (const element of scene.queryBox(covered)) {
        this.place(element, zoom, zoom * pixelRatio, tierCap, crispScale, generations, slotOf);
      }
    }

    this.covered = covered;
    this.builtZoom = zoom;
    this.builtPixelRatio = pixelRatio;
    this.builtTierCap = tierCap;
    this.builtCrispScale = crispScale;
    this.builtGenerations = this.generations();
    this.dirty = false;
    this.changed.markAll();
  }

  /**
   * Finishes text left over by earlier frames: drops its provisional quads (borrowed glyph
   * tiers) and appends new ones. Only the appended and hidden quads are uploaded.
   */
  private resume(
    scene: Scene,
    zoom: number,
    pixelRatio: number,
    slotOf: (id: string) => number | undefined,
  ): void {
    const ids = this.pending;
    this.pending = [];
    this.incomplete = false;
    const generations = this.generations();
    for (let index = 0; index < ids.length; index++) {
      if (!this.canWork()) {
        // This frame's budget is spent: the rest waits for the next one, untouched.
        for (const rest of ids.slice(index)) this.defer(rest);
        break;
      }
      const id = ids[index]!;
      const previous = this.considered.get(id);
      if (previous) {
        this.hideRange(previous);
        this.considered.delete(id);
      }
      const element = scene.get(id);
      if (!element) continue;
      const start = this.quadCount;
      this.place(
        element,
        zoom,
        zoom * pixelRatio,
        this.builtTierCap,
        this.builtCrispScale,
        generations,
        slotOf,
      );
      if (this.quadCount > start) this.changed.mark(start, this.quadCount);
    }
    if (this.generations() !== generations) {
      // An atlas grew or started over: quads written before point at old positions.
      this.dirty = true;
      this.incomplete = true;
    }
    this.builtGenerations = this.generations();
  }

  /** Appends the quads of one element: copied from its cached block, or emitted. */
  private place(
    element: BoardElement,
    zoom: number,
    pixelsPerUnit: number,
    tierCap: number,
    /** Device px per world unit to draw bitmap glyphs for, null for distance fields. */
    crispScale: number | null,
    generations: string,
    slotOf: (id: string) => number | undefined,
  ): void {
    if (!isShape(element)) return;
    const block = element.text;
    if (!block || block.runs.length === 0 || this.hidden.has(element.id)) return;
    const { minGlyphPx, minGreekPx, maxQuads } = this.options;
    const start = this.quadCount;
    const cached = this.blocks.get(element.id);
    const known = cached !== undefined && sameLayoutInputs(cached, element);
    // Cheap rejection before layout: autoFit only shrinks sizes, autoGrow up to its limit.
    const upperSize = block.autoGrow
      ? Math.max(largestSize(block), AUTO_GROW_SHARE * Math.min(element.width, element.height))
      : largestSize(block);
    if (this.full || (known ? cached.maxFontSize : upperSize) * zoom < minGreekPx) {
      this.considered.set(element.id, rangeOf(element, start, start, false));
      return;
    }
    let layout: TextLayout | undefined;
    let maxFontSize: number;
    if (known) maxFontSize = cached.maxFontSize;
    else {
      layout = this.layout(element, block, false);
      if (!layout) return this.defer(element.id); // out of budget: lay it out next frame
      maxFontSize = layout.maxFontSize;
    }
    const screenSize = maxFontSize * zoom;
    if (screenSize < minGreekPx) {
      // Remember its size: next builds skip this text without looking up its layout.
      if (!known)
        this.rememberBlock(element, maxFontSize, false, 0, null, tierCap, null, generations);
      this.considered.set(element.id, rangeOf(element, start, start, false));
      return;
    }
    const slot = slotOf(element.id);
    if (slot === undefined) return;
    const depth = textDepth(slot);
    const greek = screenSize < minGlyphPx;
    // Bitmap glyphs are drawn upright on the pixel grid: rotated text keeps distance fields.
    const elementCrisp = !greek && element.rotation === 0 ? crispScale : null;

    if (
      known &&
      cached.quads !== null &&
      cached.greek === greek &&
      cached.theme === this.theme &&
      (greek ||
        (cached.generations === generations &&
          cached.tierCap === tierCap &&
          cached.crispScale === elementCrisp &&
          (elementCrisp !== null ||
            (pixelsPerUnit > cached.minPx && pixelsPerUnit <= cached.maxPx))))
    ) {
      if (!this.copyBlock(cached, cached.quads, element, depth)) this.full = true;
    } else {
      layout ??= this.layout(element, block, false);
      if (!layout) return this.defer(element.id);
      this.usedFallback = false;
      this.minPx = 0;
      this.maxPx = Infinity;
      const emitted = greek
        ? this.emitGreek(element, layout, depth)
        : this.emitGlyphs(element, layout, depth, pixelsPerUnit, tierCap, elementCrisp);
      if (!emitted) this.full = true;
      else if (this.usedFallback) this.defer(element.id); // drawn with borrowed glyphs for now
      else {
        const quads = this.floats.slice(start * FLOATS, this.quadCount * FLOATS);
        this.rememberBlock(
          element,
          layout.maxFontSize,
          greek,
          depth,
          quads,
          tierCap,
          elementCrisp,
          generations,
        );
      }
    }
    if (this.quadCount >= maxQuads) this.full = true;
    this.considered.set(element.id, rangeOf(element, start, this.quadCount, elementCrisp !== null));
  }

  private defer(id: string): void {
    this.pending.push(id);
    this.incomplete = true;
  }

  /** Copies a cached block into the buffer (patched to where the element is now). */
  private copyBlock(
    block: QuadBlock,
    quads: Float32Array,
    element: ShapeElement,
    depth: number,
  ): boolean {
    const centerX = element.x + element.width / 2;
    const centerY = element.y + element.height / 2;
    if (
      block.centerX !== centerX ||
      block.centerY !== centerY ||
      block.rotation !== element.rotation ||
      block.depth !== depth
    ) {
      for (let offset = 0; offset < quads.length; offset += FLOATS) {
        quads[offset] = centerX;
        quads[offset + 1] = centerY;
        quads[offset + 6] = element.rotation;
        quads[offset + 7] = depth;
      }
      block.centerX = centerX;
      block.centerY = centerY;
      block.rotation = element.rotation;
      block.depth = depth;
    }
    const room = this.options.maxQuads - this.quadCount;
    const count = Math.min(quads.length / FLOATS, room);
    this.ensureCapacity(this.quadCount + count);
    // Same-type typed array copy: bytes are preserved, colours included.
    this.floats.set(
      count * FLOATS === quads.length ? quads : quads.subarray(0, count * FLOATS),
      this.quadCount * FLOATS,
    );
    this.quadCount += count;
    return count * FLOATS === quads.length;
  }

  private rememberBlock(
    element: ShapeElement,
    maxFontSize: number,
    greek: boolean,
    depth: number,
    quads: Float32Array | null,
    tierCap: number,
    crispScale: number | null,
    generations: string,
  ): void {
    this.forgetBlock(element.id);
    this.blocks.set(element.id, {
      text: element.text!,
      width: element.width,
      height: element.height,
      strokeWidth: element.strokeWidth,
      type: element.type,
      sides: element.sides,
      maxFontSize,
      greek,
      minPx: this.minPx,
      maxPx: this.maxPx,
      tierCap,
      crispScale,
      generations,
      theme: this.theme,
      centerX: element.x + element.width / 2,
      centerY: element.y + element.height / 2,
      rotation: element.rotation,
      depth,
      quads,
    });
    this.blockBytes += blockSize(quads);
    for (const [id, oldest] of this.blocks) {
      if (this.blockBytes <= BLOCK_CACHE_BYTES) break;
      this.blocks.delete(id);
      this.blockBytes -= blockSize(oldest.quads);
    }
  }

  private forgetBlock(id: string): void {
    const block = this.blocks.get(id);
    if (!block) return;
    this.blocks.delete(id);
    this.blockBytes -= blockSize(block.quads);
  }

  private noteTextSize(element: BoardElement): void {
    const block = isShape(element) ? element.text : undefined;
    if (block) this.maxTextSize = Math.max(this.maxTextSize, largestSize(block));
  }

  private layout(element: ShapeElement, block: TextBlock, force: boolean): TextLayout | undefined {
    const cached = this.layouts.get(block);
    // Out of budget and nothing cached: no need to measure the text area just to say no.
    if (!cached && !force && !this.canWork()) return undefined;
    const area = textArea(element);
    const width = area.maxX - area.minX;
    const height = area.maxY - area.minY;
    if (cached && cached.width === width && cached.height === height) return cached.layout;
    if (!force && !this.canWork()) return undefined;
    const startTime = performance.now();
    // Auto-width text never wraps: its box may lag behind (e.g. fonts loaded after it was sized).
    const noWrap = element.type === 'text' && block.sizing === 'auto-width';
    const layout = layoutText(block, width, height, this.measurer, noWrap);
    this.spend(startTime, 1);
    this.layouts.delete(block);
    this.layouts.set(block, { width, height, layout });
    if (this.layouts.size > this.options.layoutCacheSize) {
      this.layouts.delete(this.layouts.keys().next().value!);
    }
    return layout;
  }

  /** Returns false when the quad budget is exhausted. */
  private emitGlyphs(
    element: ShapeElement,
    layout: TextLayout,
    depth: number,
    /** Device pixels per world unit. */
    pixelsPerUnit: number,
    tierCap: number,
    /** Device px per world unit to draw bitmap glyphs for, null for distance fields. */
    crispScale: number | null,
  ): boolean {
    const area = textArea(element);
    const centerX = element.x + element.width / 2;
    const centerY = element.y + element.height / 2;
    const offsetX = area.minX - element.width / 2;
    const offsetY = area.minY - element.height / 2;

    for (const laidOut of layout.glyphs) {
      if (this.quadCount >= this.options.maxQuads) return false;
      const color = isColorGlyph(laidOut.cluster);
      if (crispScale !== null && !color) {
        const position = { centerX, centerY, offsetX, offsetY, depth };
        if (this.emitBitmapGlyph(element, laidOut, position, crispScale)) continue;
      }
      const atlas = color ? this.colorAtlas : this.sdfAtlas;
      // Each glyph picks its own raster tier: sizes can differ within one text.
      const tiers = color ? COLOR_TIERS : SDF_TIERS;
      const tier = pickTier(tiers, laidOut.size * pixelsPerUnit, tierCap);
      this.noteTierRange(tiers, tier, tierCap, laidOut.size);
      const glyph = this.glyph(
        atlas,
        tiers,
        tier,
        laidOut.cluster,
        laidOut.variant,
        color ? this.rasterizers.color : this.rasterizers.sdf,
      );
      if (!glyph || glyph.width === 0) continue;
      const scale = laidOut.size / glyph.rasterSize;
      const texel = 1 / atlas.size;
      this.write(
        centerX,
        centerY,
        offsetX + laidOut.x + glyph.left * scale,
        offsetY + laidOut.y - glyph.top * scale,
        glyph.width * scale,
        glyph.height * scale,
        element.rotation,
        depth,
        glyph.x * texel,
        glyph.y * texel,
        (glyph.x + glyph.width) * texel,
        (glyph.y + glyph.height) * texel,
        color ? MODE_COLOR : MODE_SDF,
        // Color glyphs keep their own colors; only the text color's alpha applies.
        color
          ? (0xffffff00 | (laidOut.color & 255)) >>> 0
          : this.theme.of(element.type, laidOut.color),
      );
    }
    for (const decoration of layout.decorations) {
      if (this.quadCount >= this.options.maxQuads) return false;
      this.solid(
        centerX,
        centerY,
        offsetX + decoration.x,
        offsetY + decoration.y - decoration.thickness / 2,
        decoration.width,
        decoration.thickness,
        element.rotation,
        depth,
        this.theme.of(element.type, decoration.color),
      );
    }
    return true;
  }

  /**
   * Emits a glyph rasterized at exactly its size on screen (`MODE_BITMAP`): whole device
   * pixels from its element's anchor, a quarter-pixel step across (baked into the bitmap),
   * the baseline on a whole pixel, as the browser lays out text. False when it can't be
   * rasterized this frame: the caller draws it from the distance field meanwhile.
   */
  private emitBitmapGlyph(
    element: ShapeElement,
    laidOut: LaidOutGlyph,
    position: { centerX: number; centerY: number; offsetX: number; offsetY: number; depth: number },
    scale: number,
  ): boolean {
    // Pen position relative to the element's center, in device pixels.
    const penX = (position.offsetX + laidOut.x) * scale;
    const penY = (position.offsetY + laidOut.y) * scale;
    let pixelX = Math.floor(penX);
    let subpixel = Math.round((penX - pixelX) * SUBPIXEL_STEPS) / SUBPIXEL_STEPS;
    if (subpixel === 1) {
      pixelX += 1;
      subpixel = 0;
    }
    const baseline = Math.round(penY);
    const size = Math.round(laidOut.size * scale * 4) / 4;
    const key = `bitmap|${laidOut.variant}|${size}|${subpixel}|${laidOut.cluster}`;
    let glyph = this.sdfAtlas.peek(key);
    if (!glyph) {
      if (!this.canWork()) {
        this.incomplete = true;
        this.usedFallback = true;
        return false;
      }
      const startTime = performance.now();
      const raster = this.rasterizers.bitmap(laidOut.cluster, laidOut.variant, size, subpixel);
      glyph = this.sdfAtlas.insert(key, raster, size);
      this.spend(startTime, rasterUnits(size));
    }
    if (glyph.width === 0) return true; // nothing to draw (a space)
    const texel = 1 / this.sdfAtlas.size;
    this.write(
      position.centerX,
      position.centerY,
      (pixelX + glyph.left) / scale,
      (baseline - glyph.top) / scale,
      glyph.width / scale,
      glyph.height / scale,
      0,
      position.depth,
      glyph.x * texel,
      glyph.y * texel,
      (glyph.x + glyph.width) * texel,
      (glyph.y + glyph.height) * texel,
      MODE_BITMAP,
      this.theme.of(element.type, laidOut.color),
    );
    return true;
  }

  /**
   * Narrows `minPx..maxPx` to the device-px-per-unit range in which `pickTier` keeps
   * choosing `tier` for a glyph of this size (the mirror image of `pickTier`'s test).
   */
  private noteTierRange(
    tiers: readonly number[],
    tier: number,
    tierCap: number,
    size: number,
  ): void {
    const last = Math.min(tierCap, tiers.length - 1);
    if (tier > 0) this.minPx = Math.max(this.minPx, (tiers[tier - 1]! * MAX_MAGNIFICATION) / size);
    if (tier < last) this.maxPx = Math.min(this.maxPx, (tiers[tier]! * MAX_MAGNIFICATION) / size);
  }

  /** Far away, each line becomes a translucent bar so the board keeps its texture. */
  private emitGreek(element: ShapeElement, layout: TextLayout, depth: number): boolean {
    const area = textArea(element);
    const centerX = element.x + element.width / 2;
    const centerY = element.y + element.height / 2;
    const offsetX = area.minX - element.width / 2;
    const offsetY = area.minY - element.height / 2;
    for (const line of layout.lines) {
      const size = line.size;
      if (this.quadCount >= this.options.maxQuads) return false;
      const drawn = this.theme.of(element.type, line.color);
      const alpha = Math.round((drawn & 255) * 0.35);
      const color = ((drawn & 0xffffff00) | alpha) >>> 0;
      // A bar over the x-height of the line.
      this.solid(
        centerX,
        centerY,
        offsetX + line.x,
        offsetY + line.y - size * 0.6,
        line.width,
        size * 0.5,
        element.rotation,
        depth,
        color,
      );
    }
    return true;
  }

  /**
   * Finds a glyph at the wanted tier, rasterizing it if the frame budget allows.
   * Otherwise falls back to the nearest tier already in the atlas and asks for
   * another frame, so zooming never stalls on rasterization.
   */
  private glyph(
    atlas: GlyphAtlas,
    tiers: readonly number[],
    tier: number,
    cluster: string,
    variant: FontVariant,
    rasterize: GlyphRasterizer,
  ): AtlasGlyph | undefined {
    const key = (tierIndex: number) => glyphKey(tiers[tierIndex]!, variant, cluster);
    const exact = atlas.peek(key(tier));
    if (exact) {
      this.notePrefetch(atlas, tiers, tier + 1, cluster, variant, rasterize);
      return exact;
    }
    if (this.canWork()) {
      const size = tiers[tier]!;
      const startTime = performance.now();
      const inserted = atlas.insert(key(tier), rasterize(cluster, variant, size), size);
      this.spend(startTime, rasterUnits(size));
      this.notePrefetch(atlas, tiers, tier + 1, cluster, variant, rasterize);
      return inserted;
    }
    this.incomplete = true;
    this.usedFallback = true;
    // A bigger tier first: drawn smaller it stays sharp, while a smaller one drawn bigger
    // rounds the corners and smudges the strokes until the wanted tier is rasterized.
    for (let distance = 1; distance < tiers.length; distance++) {
      const higher = tier + distance < tiers.length ? atlas.peek(key(tier + distance)) : undefined;
      if (higher) return higher;
      const lower = tier - distance >= 0 ? atlas.peek(key(tier - distance)) : undefined;
      if (lower) return lower;
    }
    return undefined;
  }

  /** Queues a glyph at `tier` for `prefetchGlyphs`, unless it is there or too big. */
  private notePrefetch(
    atlas: GlyphAtlas,
    tiers: readonly number[],
    tier: number,
    cluster: string,
    variant: FontVariant,
    rasterize: GlyphRasterizer,
  ): void {
    const size = tiers[tier];
    if (size === undefined || size > PREFETCH_MAX_TIER) return;
    if (this.prefetch.size >= PREFETCH_MAX_GLYPHS) return;
    const key = glyphKey(size, variant, cluster);
    const queueKey = `${atlas.channels}|${key}`;
    if (this.prefetch.has(queueKey) || atlas.peek(key)) return;
    this.prefetch.set(queueKey, { atlas, size, cluster, variant, rasterize });
  }

  /**
   * Rasterizes queued glyphs at the tier above the one they are drawn from, within the
   * frame's budget, while nothing else is to be done. Only into the space the atlases have
   * left: growing or starting an atlas over would make the whole visible text build again,
   * which is what this is meant to save. What doesn't fit is dropped.
   */
  private prefetchGlyphs(): void {
    for (const [queueKey, glyph] of this.prefetch) {
      if (!this.canWork()) return;
      this.prefetch.delete(queueKey);
      const { atlas, size, cluster, variant, rasterize } = glyph;
      const key = glyphKey(size, variant, cluster);
      if (atlas.peek(key)) continue;
      // Rough bitmap bound before rasterizing: a glyph with its SDF padding is about a tier
      // square (wide ones, e.g. "W" or emoji, up to twice that).
      if (!atlas.hasRoom(size * 2, size * 2)) continue;
      const startTime = performance.now();
      const raster = rasterize(cluster, variant, size);
      if (atlas.hasRoom(raster.width, raster.height)) atlas.insert(key, raster, size);
      this.spend(startTime, rasterUnits(size));
    }
  }

  private canWork(): boolean {
    return this.spentMs < this.options.budgetMs && this.spentUnits < this.options.budgetUnits;
  }

  private spend(start: number, units: number): void {
    this.spentMs += performance.now() - start;
    this.spentUnits += units;
  }

  private solid(
    centerX: number,
    centerY: number,
    offsetX: number,
    offsetY: number,
    width: number,
    height: number,
    rotation: number,
    depth: number,
    color: number,
  ): void {
    this.write(
      centerX,
      centerY,
      offsetX,
      offsetY,
      width,
      height,
      rotation,
      depth,
      0,
      0,
      0,
      0,
      MODE_SOLID,
      color,
    );
  }

  private write(
    anchorX: number,
    anchorY: number,
    offsetX: number,
    offsetY: number,
    width: number,
    height: number,
    rotation: number,
    depth: number,
    startU: number,
    startV: number,
    endU: number,
    endV: number,
    mode: number,
    color: number,
  ): void {
    this.ensureCapacity(this.quadCount + 1);
    const quad = this.quadCount++;
    const floatOffset = quad * FLOATS;
    const floats = this.floats;
    floats[floatOffset] = anchorX;
    floats[floatOffset + 1] = anchorY;
    floats[floatOffset + 2] = offsetX;
    floats[floatOffset + 3] = offsetY;
    floats[floatOffset + 4] = width;
    floats[floatOffset + 5] = height;
    floats[floatOffset + 6] = rotation;
    floats[floatOffset + 7] = depth;
    floats[floatOffset + 8] = startU;
    floats[floatOffset + 9] = startV;
    floats[floatOffset + 10] = endU;
    floats[floatOffset + 11] = endV;
    floats[floatOffset + 12] = mode;
    writeColorBytes(this.bytes, quad * GLYPH_STRIDE + COLOR_BYTE, color);
  }

  /** Updates anchor and rotation of an element's quads (drag/rotate without relayout). */
  private moveRange(range: Range, element: ShapeElement): void {
    const centerX = element.x + element.width / 2;
    const centerY = element.y + element.height / 2;
    for (let quad = range.start; quad < range.end; quad++) {
      const floatOffset = quad * FLOATS;
      this.floats[floatOffset] = centerX;
      this.floats[floatOffset + 1] = centerY;
      this.floats[floatOffset + 6] = element.rotation;
    }
    this.changed.mark(range.start, range.end);
  }

  private hideRange(range: Range): void {
    for (let quad = range.start; quad < range.end; quad++) {
      const floatOffset = quad * FLOATS;
      this.floats[floatOffset + 4] = 0;
      this.floats[floatOffset + 5] = 0;
    }
    this.changed.mark(range.start, range.end);
  }

  /** Conservative overlap test that works for any rotation. */
  private overlaps(element: ShapeElement, box: Box): boolean {
    const radius = Math.hypot(element.width, element.height) / 2;
    const centerX = element.x + element.width / 2;
    const centerY = element.y + element.height / 2;
    return boxIntersects(box, {
      minX: centerX - radius,
      minY: centerY - radius,
      maxX: centerX + radius,
      maxY: centerY + radius,
    });
  }

  private ensureCapacity(count: number): void {
    if (count * GLYPH_STRIDE <= this.buffer.byteLength) return;
    this.buffer = growBuffer(
      this.buffer,
      Math.max(count * GLYPH_STRIDE, this.buffer.byteLength * 2),
    );
    this.floats = new Float32Array(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }
}

function sameLayoutInputs(inputs: LayoutInputs, element: ShapeElement): boolean {
  return (
    inputs.text === element.text &&
    inputs.width === element.width &&
    inputs.height === element.height &&
    inputs.strokeWidth === element.strokeWidth &&
    inputs.type === element.type &&
    inputs.sides === element.sides
  );
}

function rangeOf(element: ShapeElement, start: number, end: number, crisp: boolean): Range {
  return {
    start,
    end,
    crisp,
    text: element.text!,
    width: element.width,
    height: element.height,
    strokeWidth: element.strokeWidth,
    type: element.type,
    sides: element.sides,
  };
}

/** Largest font size a block can show (its runs may be bigger than its default size). */
function largestSize(block: TextBlock): number {
  let maximum = block.fontSize;
  for (const run of block.runs)
    if (run.size !== undefined && run.size > maximum) maximum = run.size;
  return maximum;
}

/** Atlas key of a glyph rasterized at `size`. */
const glyphKey = (size: number, variant: FontVariant, cluster: string) =>
  `${size}|${variant}|${cluster}`;

/** Share of a frame's rasterization budget one glyph at `size` costs. */
const rasterUnits = (size: number) => Math.max(1, (size * size) / 4096);

/** Smallest tier magnified at most MAX_MAGNIFICATION, capped by `cap`. */
export function pickTier(
  tiers: readonly number[],
  devicePixels: number,
  cap = tiers.length - 1,
): number {
  const last = Math.min(cap, tiers.length - 1);
  for (let tier = 0; tier <= last; tier++)
    if (tiers[tier]! * MAX_MAGNIFICATION >= devicePixels) return tier;
  return last;
}

const blockSize = (quads: Float32Array | null) => (quads ? quads.byteLength : SIZE_ONLY_BYTES);
