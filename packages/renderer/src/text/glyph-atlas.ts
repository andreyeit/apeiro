/** A rasterized glyph bitmap (SDF or color), ready to be packed. */
export interface RasterGlyph {
  /** `width * height * channels` bytes; empty for whitespace. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /** Bitmap top-left relative to the pen position at the baseline, in raster px (x right, y up for top). */
  left: number;
  top: number;
}

export interface AtlasGlyph {
  /** Atlas position in texels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Bitmap top-left relative to the pen position, raster px. */
  left: number;
  top: number;
  /** Font size the glyph was rasterized at; display scale = fontSize / rasterSize. */
  rasterSize: number;
}

export interface AtlasUpload {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8Array;
}

export interface AtlasOptions {
  /** 1 for SDF (R8), 4 for color glyphs (RGBA8, premultiplied). */
  channels: 1 | 4;
  initialSize?: number;
  maxSize?: number;
}

const PADDING = 1; // texels between glyphs to avoid bleeding under linear filtering

/**
 * Glyph atlas filled on demand with shelf packing. Grows by doubling up to
 * `maxSize`; when full at max size it is cleared and `generation` changes,
 * so consumers know previously returned positions are stale.
 *
 * Rasterization is done by the caller: the atlas only stores bitmaps. That lets
 * the caller spread expensive rasterization over frames.
 */
export class GlyphAtlas {
  readonly channels: 1 | 4;
  private readonly maxSize: number;
  private glyphs = new Map<string, AtlasGlyph>();
  private _size: number;
  private _data: Uint8Array;
  private _generation = 0;
  private shelfX = 0;
  private shelfY = 0;
  private shelfHeight = 0;
  private uploads: AtlasUpload[] = [];
  private fullUpload = true;

  constructor(options: AtlasOptions) {
    this.channels = options.channels;
    this._size = options.initialSize ?? 1024;
    this.maxSize = options.maxSize ?? 4096;
    this._data = new Uint8Array(this._size * this._size * this.channels);
  }

  get size(): number {
    return this._size;
  }
  get data(): Uint8Array {
    return this._data;
  }
  /** Changes whenever previously returned glyph positions become invalid. */
  get generation(): number {
    return this._generation;
  }
  get glyphCount(): number {
    return this.glyphs.size;
  }

  peek(key: string): AtlasGlyph | undefined {
    return this.glyphs.get(key);
  }

  /**
   * Whether a `width` x `height` bitmap fits in the space left, without growing or resetting
   * the atlas (both make every glyph position written so far stale).
   */
  hasRoom(width: number, height: number): boolean {
    if (width + PADDING > this._size) return false;
    const newShelf = this.shelfX + width + PADDING > this._size;
    const top = newShelf ? this.shelfY + this.shelfHeight + PADDING : this.shelfY;
    return top + height + PADDING <= this._size;
  }

  /**
   * Stores a bitmap under `key`. May grow the atlas, or reset it when full
   * (check `generation`). Returns the stored position.
   */
  insert(key: string, raster: RasterGlyph, rasterSize: number): AtlasGlyph {
    const glyph: AtlasGlyph = {
      x: 0,
      y: 0,
      width: raster.width,
      height: raster.height,
      left: raster.left,
      top: raster.top,
      rasterSize,
    };
    const fits = raster.width + PADDING <= this.maxSize && raster.height + PADDING <= this.maxSize;
    // A cluster that can't fit even an empty atlas (e.g. hundreds of stacked combining marks)
    // is stored as empty: text comes from users, it must never break rendering.
    if (fits && raster.width > 0 && raster.height > 0 && raster.data.length > 0) {
      const position = this.allocate(raster.width, raster.height);
      glyph.x = position.x;
      glyph.y = position.y;
      this.blit(glyph.x, glyph.y, raster.width, raster.height, raster.data);
    } else {
      glyph.width = 0; // whitespace, unsupported or oversized: nothing to draw
      glyph.height = 0;
    }
    this.glyphs.set(key, glyph);
    return glyph;
  }

  /** Drops all glyphs, e.g. after a web font finished loading. */
  reset(): void {
    this.glyphs.clear();
    this._data.fill(0);
    this.shelfX = this.shelfY = this.shelfHeight = 0;
    this._generation++;
    this.uploads = [];
    this.fullUpload = true;
  }

  /** Forces a full texture upload, e.g. after a lost WebGL context. */
  markFullUpload(): void {
    this.fullUpload = true;
    this.uploads = [];
  }

  /** Pending texture updates since the last call. `full` means re-upload the whole texture. */
  takeUploads(): { full: boolean; rectangles: AtlasUpload[] } {
    const result = { full: this.fullUpload, rectangles: this.fullUpload ? [] : this.uploads };
    this.uploads = [];
    this.fullUpload = false;
    return result;
  }

  private allocate(width: number, height: number): { x: number; y: number } {
    if (width + PADDING > this.maxSize || height + PADDING > this.maxSize) {
      throw new Error(`Glyph ${width}x${height} does not fit an atlas of ${this.maxSize}`);
    }
    if (this.shelfX + width + PADDING > this._size) {
      this.shelfY += this.shelfHeight + PADDING;
      this.shelfX = 0;
      this.shelfHeight = 0;
    }
    if (this.shelfY + height + PADDING > this._size) {
      if (this._size < this.maxSize) this.grow();
      else this.reset(); // full at max size: start over, consumers rebuild via `generation`
      return this.allocate(width, height);
    }
    const position = { x: this.shelfX, y: this.shelfY };
    this.shelfX += width + PADDING;
    this.shelfHeight = Math.max(this.shelfHeight, height);
    return position;
  }

  /** Doubles width and height; existing glyph positions stay valid. */
  private grow(): void {
    const channels = this.channels;
    const next = this._size * 2;
    const data = new Uint8Array(next * next * channels);
    const rowBytes = this._size * channels;
    for (let row = 0; row < this._size; row++) {
      data.set(this._data.subarray(row * rowBytes, (row + 1) * rowBytes), row * next * channels);
    }
    this._size = next;
    this._data = data;
    this.fullUpload = true;
    this.uploads = [];
  }

  private blit(
    x: number,
    y: number,
    width: number,
    height: number,
    source: Uint8ClampedArray | Uint8Array,
  ): void {
    const channels = this.channels;
    const rowBytes = width * channels;
    for (let row = 0; row < height; row++) {
      this._data.set(
        source.subarray(row * rowBytes, (row + 1) * rowBytes),
        ((y + row) * this._size + x) * channels,
      );
    }
    if (!this.fullUpload) {
      this.uploads.push({
        x,
        y,
        width: width,
        height: height,
        data: new Uint8Array(source.buffer, source.byteOffset, width * height * channels),
      });
    }
  }
}
