import {
  audioLayout,
  cssColor,
  effectiveRadius,
  imageSize,
  imageUv,
  isAllowedMediaSource,
  isMedia,
  type MediaFile,
  type ShapeElement,
} from '@apeiro/core';
import type { MediaQuad, MediaSource, MediaTextures, TextureHandle } from '../backend';
import {
  DEFAULT_AUDIO_STYLE,
  drawAudioWidget,
  type AudioCard,
  type AudioVisualState,
  type AudioWidgetStyle,
  type Context2D,
} from './audio-widget';

type MediaElement = ShapeElement & { media: MediaFile };

/**
 * Longest side of an image texture; bigger images are downscaled on load (and never past
 * what the GPU takes). 4096 keeps photos sharp when zoomed in; with mipmaps one is ~90 MB
 * of GPU memory at most, and the texture budget below evicts what is off screen.
 */
const MAX_IMAGE_SIZE = 4096;
/** Files larger than this are not downloaded at all. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
/** Longest side of an audio player texture, px. */
const MAX_AUDIO_TEXTURE = 4096;
/** Textures beyond this many bytes get evicted, least recently used first. */
const TEXTURE_BUDGET = 256 * 1024 * 1024;
/** Retry delays after a failed load: doubles from the first to the last. */
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 60_000;

export interface MediaPassOptions {
  /** Origins (e.g. `https://cdn.example.com`) media may be loaded from, besides the page's own. */
  allowedOrigins?: readonly string[];
  /** Full control over which `src` may be loaded; overrides `allowedOrigins`. */
  isAllowedSource?: (source: string) => boolean;
}

export interface MediaDrawItem {
  element: ShapeElement;
  /** Depth of the element's slot (see depth.ts). */
  depth: number;
}

interface ImageEntry {
  /** `decoded`: bitmap ready, waiting for its turn to be uploaded (one per frame). */
  state: 'loading' | 'decoded' | 'ready' | 'error' | 'blocked';
  texture: TextureHandle | null;
  bitmap: ImageBitmap | null;
  /** Decoded size: the image's proportions when the element doesn't store them. */
  width: number;
  height: number;
  bytes: number;
  lastUsed: number;
  failures: number;
  retryAt: number;
}

interface AudioEntry {
  canvas: MediaSource;
  texture: TextureHandle;
  signature: string;
  bytes: number;
  lastUsed: number;
}

function createCanvas(width: number, height: number): MediaSource {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * CPU side of images and audio players. Images load in the background (fetch → decode →
 * downscale), are uploaded with mipmaps at most one per frame, and show a placeholder
 * meanwhile. Audio players are drawn with Canvas 2D into a texture, redrawn only when what
 * they show changes, at a resolution that follows the zoom.
 *
 * The owner reports when an image source or audio element is no longer used
 * (`releaseImage`, `releaseAudio`), so their textures are freed right away. Textures are
 * created by the backend (`MediaTextures`): this class decides what to upload and when,
 * and turns the visible elements into quads for the backend to draw.
 */
export class MediaPass {
  /** False while the GPU is lost: textures can be neither created nor freed. */
  private alive = false;
  private images = new Map<string, ImageEntry>();
  private audio = new Map<string, AudioEntry>();
  private audioState = new Map<string, AudioVisualState>();
  private audioStyle: AudioWidgetStyle = DEFAULT_AUDIO_STYLE;
  private audioStyleVersion = 0;
  /** Drawn colour of a stored element colour (the renderer's colour theme). */
  colorOf: (type: string, color: number) => number = (_type, color) => color;
  private frame = 0;
  private generation = 0;
  private errorLogged = false;
  private readonly allowed: (source: string) => boolean;

  constructor(
    private readonly textures: MediaTextures,
    private readonly requestRender: () => void,
    options: MediaPassOptions = {},
  ) {
    this.allowed =
      options.isAllowedSource ??
      ((source) => isAllowedMediaSource(source, options.allowedOrigins ?? []));
  }

  /** True while any image is still loading, or decoded and visible but not uploaded yet. */
  get pending(): boolean {
    for (const entry of this.images.values()) {
      if (entry.state === 'loading') return true;
      if (entry.state === 'decoded' && entry.lastUsed >= this.frame - 1) return true;
    }
    return false;
  }

  /** The GPU is (again) available. */
  initialize(): void {
    this.alive = true;
    // Textures from a previous context are gone: everything reloads/redraws on demand.
    for (const entry of this.images.values()) entry.bitmap?.close();
    this.images.clear();
    this.audio.clear();
    this.generation++;
  }

  lose(): void {
    this.alive = false;
    this.generation++;
  }

  dispose(): void {
    for (const entry of this.images.values()) {
      if (entry.texture && this.alive) this.textures.release(entry.texture);
      entry.bitmap?.close();
    }
    if (this.alive) for (const entry of this.audio.values()) this.textures.release(entry.texture);
    this.images.clear();
    this.audio.clear();
    this.audioState.clear();
    this.alive = false;
  }

  setAudioState(id: string, state: AudioVisualState): void {
    this.audioState.set(id, state);
  }

  /** Colours of the audio players (e.g. on a theme switch); every player redraws. */
  setAudioStyle(style: Partial<AudioWidgetStyle>): void {
    this.audioStyle = { ...this.audioStyle, ...style };
    this.audioStyleVersion++;
  }

  /** No element uses this image any more: free its texture (an in-flight load is dropped). */
  releaseImage(source: string): void {
    const entry = this.images.get(source);
    if (!entry) return;
    if (entry.texture && this.alive) this.textures.release(entry.texture);
    entry.bitmap?.close();
    this.images.delete(source);
  }

  /** The audio element is gone (or no longer audio): free its texture and playback state. */
  releaseAudio(id: string): void {
    const entry = this.audio.get(id);
    if (entry && this.alive) this.textures.release(entry.texture);
    this.audio.delete(id);
    this.audioState.delete(id);
  }

  /** Quads for the visible media, in the given order; uploads what they need first. */
  prepare(
    items: MediaDrawItem[],
    x: number,
    y: number,
    zoom: number,
    pixelRatio: number,
  ): MediaQuad[] {
    if (!this.alive || items.length === 0) return [];
    this.frame++;
    this.uploadOneDecoded();
    const quads: MediaQuad[] = [];
    const devicePixelsPerUnit = zoom * pixelRatio;
    for (const { element, depth } of items) {
      if (!isMedia(element)) continue;
      try {
        quads.push(this.quad(element, depth, x, y, devicePixelsPerUnit));
      } catch (error) {
        // Element data (from other participants, eventually) must not stop the frame:
        // this element shows the placeholder, everything else is drawn as usual.
        if (!this.errorLogged) {
          this.errorLogged = true;
          console.error('apeiro: a media element could not be drawn, showing a placeholder', error);
        }
        quads.push({
          box: [element.x, element.y, element.width, element.height],
          rotation: element.rotation,
          depth,
          radius: 0,
          textureCoordinates: [0, 0, 1, 1],
          texture: null,
        });
      }
    }
    this.evict();
    return quads;
  }

  private quad(
    element: MediaElement,
    depth: number,
    x: number,
    y: number,
    devicePixelsPerUnit: number,
  ): MediaQuad {
    let texture: TextureHandle | null;
    let box: MediaQuad['box'] = [element.x, element.y, element.width, element.height];
    let textureCoordinates: MediaQuad['textureCoordinates'];
    if (element.type === 'image') {
      texture = this.imageTexture(element.media.source);
      const decoded = this.images.get(element.media.source);
      const fit = imageUv(
        element,
        imageSize(
          element,
          decoded?.width ? { width: decoded.width, height: decoded.height } : null,
        ),
      );
      textureCoordinates = [fit.u, fit.v, fit.spanU, fit.spanV];
    } else {
      // Audio textures are drawn 1:1 to device pixels: the box is snapped to the pixel
      // grid and sized to the texture, so the thin controls stay sharp (no resampling).
      const audio = this.audioTexture(element, devicePixelsPerUnit);
      texture = audio.texture;
      textureCoordinates = [0, 0, 1, 1]; // the player texture is the box
      if (element.rotation === 0 && audio.scale === devicePixelsPerUnit) {
        const snappedX =
          Math.round((element.x - x) * devicePixelsPerUnit) / devicePixelsPerUnit + x;
        const snappedY =
          Math.round((element.y - y) * devicePixelsPerUnit) / devicePixelsPerUnit + y;
        box = [
          snappedX,
          snappedY,
          audio.width / devicePixelsPerUnit,
          audio.height / devicePixelsPerUnit,
        ];
      }
    }
    return {
      box,
      rotation: element.rotation,
      depth,
      radius: element.type === 'image' ? effectiveRadius(element) : 0,
      textureCoordinates,
      // An image without one shows the placeholder: loading, failed or not allowed.
      texture,
    };
  }

  // --- Images -------------------------------------------------------------------

  private imageTexture(source: string): TextureHandle | null {
    let entry = this.images.get(source);
    if (!entry) {
      entry = {
        state: 'loading',
        texture: null,
        bitmap: null,
        width: 0,
        height: 0,
        bytes: 0,
        lastUsed: this.frame,
        failures: 0,
        retryAt: 0,
      };
      this.images.set(source, entry);
      if (this.allowed(source)) void this.load(source, entry, this.generation);
      else entry.state = 'blocked';
    } else if (entry.state === 'error' && performance.now() >= entry.retryAt) {
      entry.state = 'loading';
      void this.load(source, entry, this.generation);
    }
    entry.lastUsed = this.frame;
    return entry.state === 'ready' ? entry.texture : null;
  }

  private async load(source: string, entry: ImageEntry, generation: number): Promise<void> {
    const current = () => generation === this.generation && this.images.get(source) === entry;
    try {
      const response = await fetch(source, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_IMAGE_BYTES) throw new Error('image too large');
      const blob = await response.blob();
      if (blob.size > MAX_IMAGE_BYTES) throw new Error('image too large');
      let bitmap = await createImageBitmap(blob);
      const limit = Math.min(MAX_IMAGE_SIZE, this.textures.maxTextureSize ?? MAX_IMAGE_SIZE);
      const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
      if (scale < 1) {
        const width = Math.round(bitmap.width * scale) || 1;
        const height = Math.round(bitmap.height * scale) || 1;
        bitmap.close();
        bitmap = await createImageBitmap(blob, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: 'high',
        });
      }
      if (!current()) {
        bitmap.close();
        return; // context was lost/restored, or the image was released meanwhile
      }
      entry.bitmap = bitmap;
      entry.width = bitmap.width;
      entry.height = bitmap.height;
      entry.state = 'decoded';
      entry.failures = 0;
    } catch {
      if (!current()) return;
      entry.failures++;
      entry.state = 'error';
      // Retried when it's drawn again after a growing delay (network may come back).
      entry.retryAt =
        performance.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (entry.failures - 1));
      setTimeout(() => this.requestRender(), entry.retryAt - performance.now() + 1);
    }
    this.requestRender();
  }

  /**
   * Uploads one decoded image: the canvas round-trip, upload and mipmap generation of a
   * 4096² image take noticeable time, so several images arriving at once are spread over frames.
   */
  private uploadOneDecoded(): void {
    let found: ImageEntry | null = null;
    let more = false;
    for (const entry of this.images.values()) {
      if (entry.state !== 'decoded') continue;
      if (found) {
        more = true;
        break;
      }
      found = entry;
    }
    if (!found || !found.bitmap) return;
    const bitmap = found.bitmap;
    // Go through a 2D canvas so every backend premultiplies it the same way in every browser.
    const canvas = createCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d') as Context2D;
    context.drawImage(bitmap, 0, 0);
    found.texture = this.textures.upload(canvas, true);
    found.bytes = Math.round(bitmap.width * bitmap.height * 4 * 1.33);
    found.state = 'ready';
    found.bitmap = null;
    bitmap.close();
    if (more) this.requestRender();
  }

  // --- Audio players --------------------------------------------------------------

  private audioTexture(
    element: ShapeElement & { media: { peaks?: number[]; duration?: number } },
    devicePixelsPerUnit: number,
  ): { texture: TextureHandle; scale: number; width: number; height: number } {
    // Drawn at the exact device resolution (players are few and cheap to redraw), so
    // hairlines and text stay crisp at any zoom; very large ones are capped.
    const scale = Math.min(
      Math.max(devicePixelsPerUnit, 1e-3),
      MAX_AUDIO_TEXTURE / Math.max(element.width, element.height, 1e-3),
    );
    const state = this.audioState.get(element.id) ?? { playing: false, progress: 0 };
    const volume = element.volume ?? 1;
    const pixelWidth = Math.max(1, Math.round(element.width * scale));
    const pixelHeight = Math.max(1, Math.round(element.height * scale));
    const duration = element.media.duration ?? 0;
    // The time label changes once per second, the waveform at bar granularity.
    const card = this.audioCard(element);
    const signature = `${pixelWidth}x${pixelHeight}|${card.fill}|${card.stroke}|${card.strokeWidth}|${card.radius}|${volume.toFixed(3)}|${state.playing}|${Math.floor(state.progress * 400)}|${Math.floor(state.progress * duration)}|${duration}|${this.audioStyleVersion}|${element.media.peaks?.length ?? 0}:${element.media.peaks?.[0] ?? ''}`;
    let entry = this.audio.get(element.id);
    if (entry && entry.signature === signature) {
      entry.lastUsed = this.frame;
      return { texture: entry.texture, scale, width: pixelWidth, height: pixelHeight };
    }
    const canvas = entry?.canvas ?? createCanvas(pixelWidth, pixelHeight);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext('2d') as Context2D;
    drawAudioWidget(
      context,
      element.width,
      element.height,
      scale,
      element.media.peaks,
      volume,
      state,
      this.audioStyle,
      duration,
      card,
    );
    if (entry) {
      entry.texture = this.textures.upload(canvas, false, entry.texture);
      entry.signature = signature;
      entry.bytes = pixelWidth * pixelHeight * 4;
      entry.lastUsed = this.frame;
    } else {
      entry = {
        canvas,
        texture: this.textures.upload(canvas, false),
        signature,
        bytes: pixelWidth * pixelHeight * 4,
        lastUsed: this.frame,
      };
      this.audio.set(element.id, entry);
    }
    return { texture: entry.texture, scale, width: pixelWidth, height: pixelHeight };
  }

  /** Background and border of a player: the element's own fill and stroke, none by default. */
  private audioCard(element: ShapeElement): AudioCard {
    const css = (color: number) => ((color & 255) === 0 ? null : cssColor(color));
    return {
      fill: css(this.colorOf(element.type, element.fill)),
      stroke: element.strokeWidth > 0 ? css(this.colorOf(element.type, element.stroke)) : null,
      strokeWidth: element.strokeWidth,
      radius:
        element.radius > 0
          ? element.radius
          : audioLayout(element.width, element.height).card.radius,
    };
  }

  /** Frees least recently used textures (not used this frame) while over budget. */
  private evict(): void {
    let total = 0;
    for (const entry of this.images.values()) total += entry.bytes;
    for (const entry of this.audio.values()) total += entry.bytes;
    if (total <= TEXTURE_BUDGET) return;
    const candidates: Array<{
      key: string;
      kind: 'image' | 'audio';
      lastUsed: number;
      bytes: number;
    }> = [];
    for (const [key, entry] of this.images)
      if (entry.state === 'ready' && entry.lastUsed < this.frame)
        candidates.push({ key, kind: 'image', lastUsed: entry.lastUsed, bytes: entry.bytes });
    for (const [key, entry] of this.audio)
      if (entry.lastUsed < this.frame)
        candidates.push({ key, kind: 'audio', lastUsed: entry.lastUsed, bytes: entry.bytes });
    candidates.sort((first, second) => first.lastUsed - second.lastUsed);
    for (const candidate of candidates) {
      if (total <= TEXTURE_BUDGET) break;
      const texture =
        candidate.kind === 'image'
          ? this.images.get(candidate.key)!.texture
          : this.audio.get(candidate.key)!.texture;
      if (texture) this.textures.release(texture);
      if (candidate.kind === 'image') this.images.delete(candidate.key);
      else this.audio.delete(candidate.key);
      total -= candidate.bytes;
    }
  }
}
