import type { GlyphAtlas } from './text/glyph-atlas';
import type { InstanceStore } from './layers/instance-store';
import type { LineLayer } from './layers/line-layer';
import type { TextLayer } from './layers/text-layer';

/** Which GPU API draws the board. */
export type BackendKind = 'webgpu' | 'webgl';

/** A texture owned by a backend; opaque to everything else. */
export type TextureHandle = object;

export type MediaSource = OffscreenCanvas | HTMLCanvasElement;

/** How the media pass (CPU side) gets its images and audio players onto the GPU. */
export interface MediaTextures {
  /**
   * Uploads `source` as premultiplied RGBA. With `previous`, its contents are replaced
   * (the returned handle may differ when the size changed; the old one is then freed).
   */
  upload(source: MediaSource, mipmaps: boolean, previous?: TextureHandle): TextureHandle;
  release(texture: TextureHandle): void;
  /** Longest texture side the GPU takes (unknown: images stay at the default limit). */
  readonly maxTextureSize?: number;
}

/** One image or audio player: a textured, rounded, rotated quad. */
export interface MediaQuad {
  /** x, y, width, height (world, unrotated box). */
  box: readonly [number, number, number, number];
  rotation: number;
  depth: number;
  radius: number;
  /** Image (u, v) at the box's top-left and the (du, dv) it spans. */
  textureCoordinates: readonly [number, number, number, number];
  /** null: draw the loading placeholder. */
  texture: TextureHandle | null;
}

export interface GridLevel {
  /** World units between lines/dots. */
  spacing: number;
  /** 0..1 */
  fade: number;
}

/** Everything a backend needs for one frame, besides the CPU layers it was given. */
export interface FrameParams {
  x: number;
  y: number;
  zoom: number;
  /** CSS pixels. */
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
  /** Normalized RGB. */
  background: readonly [number, number, number, number];
  /** null: no grid this frame. */
  grid: {
    color: readonly [number, number, number, number];
    lines: boolean;
    levels: GridLevel[];
  } | null;
  media: MediaQuad[];
  /** False when text layout failed this frame: the text pass is skipped. */
  drawText: boolean;
}

/** CPU state shared by the renderer with its backend. */
export interface BackendContext {
  canvas: HTMLCanvasElement;
  store: InstanceStore;
  lineLayer: LineLayer;
  textLayer: TextLayer;
  sdfAtlas: GlyphAtlas;
  colorAtlas: GlyphAtlas;
  /** SDF value at the glyph outline. */
  sdfEdge: number;
  preserveDrawingBuffer: boolean;
  /** The canvas is see-through where nothing is drawn (the background's alpha is kept). */
  transparent: boolean;
  /** GPU resources are gone (context/device lost); nothing may be drawn until restored. */
  onLost(): void;
  /** New GPU resources exist; every CPU layer has been marked for a full upload. */
  onRestored(): void;
}

/**
 * The GPU side of the renderer. It uploads whatever the CPU layers marked dirty and
 * draws one frame, in this order: grid, shapes (color, then depth), media, lines, text.
 */
export interface RenderBackend {
  readonly kind: BackendKind;
  /** False while the context/device is lost. */
  readonly ready: boolean;
  readonly textures: MediaTextures;
  /** Bytes sent to the GPU since the last call. */
  takeUploadedBytes(): number;
  render(frame: FrameParams): void;
  destroy(): void;
}

export type BackendFactory = (context: BackendContext) => RenderBackend;
