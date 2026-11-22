import { compareZ, polygonSides, type BoardElement } from '@apeiro/core';
import { ColorTheme } from '../color-theme';
import { DirtyRanges, type BufferUpload } from './buffer-upload';
import { growBuffer, writeColorBytes, type InstanceLayout } from './instance-layout';

/**
 * Per-instance layout (interleaved, 44 bytes):
 *   0  f32 x, y, width, height
 *   16 f32 rotation, radius, strokeWidth, kind
 *   32 u8x4 fill RGBA
 *   36 u8x4 stroke RGBA
 *   40 f32 stroke style (STROKE_STYLE_CODE)
 */
export const INSTANCE_STRIDE = 44;
const FLOATS_PER_INSTANCE = INSTANCE_STRIDE / 4;
/** Float index of `kind` within an instance. */
const KIND_FLOAT = 7;
const STROKE_STYLE_FLOAT = 10;
const FILL_BYTE = 32;
const STROKE_BYTE = 36;

export const SHAPE_LAYOUT: InstanceLayout = {
  stride: INSTANCE_STRIDE,
  attributes: [
    { format: 'float32', components: 4, offset: 0 },
    { format: 'float32', components: 4, offset: 16 },
    { format: 'unorm8', components: 4, offset: FILL_BYTE },
    { format: 'unorm8', components: 4, offset: STROKE_BYTE },
    { format: 'float32', components: 1, offset: STROKE_STYLE_FLOAT * 4 },
  ],
};

/** Border pattern for the shader. */
export const STROKE_STYLE_CODE = { solid: 0, dashed: 1, dotted: 2 } as const;

/** A slot the shape pass skips. */
export const KIND_HIDDEN = -1;
/** Polygons store this plus their number of corners (no spare attribute for it). */
export const POLYGON_KIND_BASE = 10;

/**
 * Shape kind for the shader. Connectors, images, audio players and pen strokes get a slot
 * too, hidden: it only gives them a depth in paint order; other passes draw them.
 */
export const KIND_CODE: Record<BoardElement['type'], number> = {
  rect: 0,
  ellipse: 1,
  sticky: 2,
  polygon: POLYGON_KIND_BASE, // + the number of corners, see `kindOf`
  text: 0, // a text box's frame is a plain rect (usually transparent)
  connector: KIND_HIDDEN,
  image: KIND_HIDDEN,
  audio: KIND_HIDDEN,
  ink: KIND_HIDDEN,
};

/** Kind value for the shader: polygons carry their corner count. */
export const kindOf = (element: BoardElement): number =>
  element.type === 'polygon' ? POLYGON_KIND_BASE + polygonSides(element) : KIND_CODE[element.type];

/**
 * CPU mirror of the GPU instance buffer. Slots are kept in paint order
 * (bottom to top), so one instanced draw call paints everything correctly.
 *
 * - update: rewrite one slot in place
 * - remove: hide the slot (leaves a hole, compacted later)
 * - add on top: append, no re-sort
 * - anything that changes relative order: full rebuild
 */
export class InstanceStore {
  /** Colors drawn in place of the stored ones (set by the renderer). */
  theme = new ColorTheme();
  private buffer: ArrayBuffer;
  private floats: Float32Array;
  private bytes: Uint8Array;
  private slotOf = new Map<string, number>();
  private top: BoardElement | undefined;
  private used = 0;
  private holes = 0;
  private dirty = new DirtyRanges();

  constructor(initialCapacity = 1024) {
    if (!Number.isSafeInteger(initialCapacity) || initialCapacity < 0)
      throw new RangeError('initialCapacity must be a non-negative safe integer');
    this.buffer = new ArrayBuffer(initialCapacity * INSTANCE_STRIDE);
    this.floats = new Float32Array(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  /** Slots in use, holes included. This is the instance count to draw. */
  get count(): number {
    return this.used;
  }
  get holeCount(): number {
    return this.holes;
  }
  get capacity(): number {
    return this.buffer.byteLength / INSTANCE_STRIDE;
  }
  get data(): ArrayBuffer {
    return this.buffer;
  }

  slot(id: string): number | undefined {
    return this.slotOf.get(id);
  }

  /** Rewrites everything from elements already sorted by z. Compacts holes. */
  rebuild(sorted: readonly BoardElement[]): void {
    this.ensureCapacity(sorted.length);
    this.slotOf.clear();
    for (let slot = 0; slot < sorted.length; slot++) {
      const element = sorted[slot]!;
      this.slotOf.set(element.id, slot);
      this.writeSlot(slot, element);
    }
    this.used = sorted.length;
    this.holes = 0;
    this.top = sorted[sorted.length - 1];
    this.markFull();
  }

  /**
   * Appends elements if all of them belong above the current top element.
   * Returns false (and changes nothing) if a rebuild is required instead.
   */
  tryAppend(added: readonly BoardElement[]): boolean {
    if (added.length === 0) return true;
    const sorted = [...added].sort(compareZ);
    if (this.top && compareZ(sorted[0]!, this.top) <= 0) return false;
    this.ensureCapacity(this.used + sorted.length);
    for (const element of sorted) {
      const slot = this.used++;
      this.slotOf.set(element.id, slot);
      this.writeSlot(slot, element);
      this.markSlot(slot);
    }
    this.top = sorted[sorted.length - 1];
    return true;
  }

  /** Rewrites an existing element in place. Returns false if the id has no slot. */
  update(element: BoardElement): boolean {
    const slot = this.slotOf.get(element.id);
    if (slot === undefined) return false;
    this.writeSlot(slot, element);
    if (this.top?.id === element.id) this.top = element;
    this.markSlot(slot);
    return true;
  }

  remove(id: string): boolean {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return false;
    this.slotOf.delete(id);
    this.floats[slot * FLOATS_PER_INSTANCE + KIND_FLOAT] = KIND_HIDDEN;
    this.holes++;
    // `top` stays as an upper bound: appending above a removed top is still correct.
    this.markSlot(slot);
    return true;
  }

  /** Worth compacting when holes waste a meaningful share of vertex work. */
  needsCompaction(): boolean {
    return this.holes > 1024 && this.holes > this.used * 0.25;
  }

  /**
   * Slots that must be uploaded to the GPU since the last call (`all` after a rebuild,
   * growth or context restore), and resets.
   */
  takeDirty(): BufferUpload {
    return this.dirty.take();
  }

  /** Forces a full upload, e.g. after WebGL context restore. */
  markFull(): void {
    this.dirty.markAll();
  }

  private markSlot(slot: number): void {
    this.dirty.mark(slot, slot + 1);
  }

  private ensureCapacity(count: number): void {
    if (count <= this.capacity) return;
    let capacity = Math.max(1, this.capacity);
    while (capacity < count) capacity *= 2;
    this.buffer = growBuffer(this.buffer, capacity * INSTANCE_STRIDE, this.used * INSTANCE_STRIDE);
    this.floats = new Float32Array(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
    this.markFull(); // GPU buffer must be reallocated
  }

  private writeSlot(slot: number, element: BoardElement): void {
    const floatOffset = slot * FLOATS_PER_INSTANCE;
    const floats = this.floats;
    if (element.type === 'connector') {
      floats.fill(0, floatOffset, floatOffset + FLOATS_PER_INSTANCE);
      floats[floatOffset + KIND_FLOAT] = KIND_HIDDEN;
      return;
    }
    floats[floatOffset] = element.x;
    floats[floatOffset + 1] = element.y;
    floats[floatOffset + 2] = element.width;
    floats[floatOffset + 3] = element.height;
    floats[floatOffset + 4] = element.rotation;
    floats[floatOffset + 5] = element.radius;
    floats[floatOffset + 6] = element.strokeWidth;
    floats[floatOffset + KIND_FLOAT] = kindOf(element);
    const byteOffset = slot * INSTANCE_STRIDE;
    writeColorBytes(this.bytes, byteOffset + FILL_BYTE, this.theme.of(element.type, element.fill));
    writeColorBytes(
      this.bytes,
      byteOffset + STROKE_BYTE,
      this.theme.of(element.type, element.stroke),
    );
    floats[floatOffset + STROKE_STYLE_FLOAT] = STROKE_STYLE_CODE[element.strokeStyle ?? 'solid'];
  }
}
