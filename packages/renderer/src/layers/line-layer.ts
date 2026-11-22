import {
  capSize,
  inkWorldPoints,
  smoothStroke,
  isConnector,
  isShape,
  type CapKind,
  type ConnectorArc,
  type ConnectorElement,
  type ConnectorGeometry,
  type Scene,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';
import { ColorTheme } from '../color-theme';
import { shapeDepth } from '../depth';
import { DirtyRanges, type BufferUpload } from './buffer-upload';
import {
  growBuffer,
  vec4Attributes,
  writeColorBytes,
  type InstanceLayout,
} from './instance-layout';

/**
 * Per-instance layout (interleaved, 52 bytes):
 *   0  f32 startX, startY, endX, endY  segment ends; for caps: tip and the point `size` behind it;
 *                                  for arcs: center x, y, radius, start angle
 *   16 f32 halfWidth, mode, dash, gap
 *   32 f32 dashOffset, depth, capSize (arcs: sweep), joins
 *   48 u8x4 color
 *
 * `joins`: how a segment or arc meets the previous and the next piece of the same line,
 * `start + end * JOIN_END`, each 0 (a free end, drawn round) or JOIN_FLAG + an 11-bit angle.
 * A joint is split between its two pieces by the line through it along the bisector of
 * their directions (the radius at a rounded bend): each pixel is drawn by one piece only.
 * The angle is that line's normal relative to the piece's own direction, in (-π/2, π/2).
 */
export const LINE_STRIDE = 52;
const FLOATS = LINE_STRIDE / 4;
/** Floats of an instance before its color. */
const ITEM = 12;
/** Float index of `mode` within an instance. */
const MODE_FLOAT = 5;
/** Float index of `joins` within an instance. */
const JOINS_FLOAT = 11;
const COLOR_BYTE = 48;

export const LINE_LAYOUT: InstanceLayout = {
  stride: LINE_STRIDE,
  attributes: [...vec4Attributes(0, 3), { format: 'unorm8', components: 4, offset: COLOR_BYTE }],
};

export const JOIN_FLAG = 2048;
export const JOIN_END = 4096;
/** Beyond this turn (radians) a line doubles back: no useful split, the ends just overlap. */
const MAX_JOIN_TURN = Math.PI * 0.95;

/** Bits of one joined end: the flag and the split line's angle quantized to 11 bits. */
export function joinBits(angle: number): number {
  const turn = Math.max(-1, Math.min(1, angle / (Math.PI / 2)));
  return JOIN_FLAG + Math.round((turn * 0.5 + 0.5) * (JOIN_FLAG - 1));
}

export const LINE_HIDDEN = -1;
export const LINE_SEGMENT = 0;
/** A rounded bend, drawn as an exact circular arc (smooth at any zoom). */
export const LINE_ARC = 5;
export const CAP_MODE: Record<Exclude<CapKind, 'none'>, number> = {
  arrow: 1,
  triangle: 2,
  circle: 3,
  diamond: 4,
};

interface Range {
  start: number;
  capacity: number;
}

export type LineUpload = BufferUpload;

/** Dash pattern in world units: core length of a dash (without round ends) and period gap. */
function dashPattern(connector: ConnectorElement): [number, number] {
  const width = Math.max(connector.strokeWidth, 0.5);
  if (connector.dash === 'dashed') return [width * 4, width * 4];
  if (connector.dash === 'dotted') return [0, width * 2.5];
  return [0, 0];
}

/**
 * CPU side of connector (and pen stroke) rendering. Each line owns a range of instances
 * (segments + caps), rewritten in place when it moves; if it grows beyond its
 * range it moves to the end and leaves a hole, compacted on the next rebuild. A range keeps
 * room to grow by half, so a pen stroke growing point by point moves only now and then.
 */
export class LineLayer {
  /** Colors drawn in place of the stored ones (set by the renderer). */
  theme = new ColorTheme();
  private buffer = new ArrayBuffer(1024 * LINE_STRIDE);
  private floats = new Float32Array(this.buffer);
  private bytes = new Uint8Array(this.buffer);
  private ranges = new Map<string, Range>();
  private used = 0;
  private holes = 0;
  private dirty = new DirtyRanges();
  /** Instances of the line being written (ITEM floats each), copied into its range by `place`. */
  private scratch = new Float32Array(64 * ITEM);
  private items = 0;

  /** Instances to draw (holes included, they are degenerate). */
  get count(): number {
    return this.used;
  }
  get data(): ArrayBuffer {
    return this.buffer;
  }

  takeUpload(): LineUpload {
    return this.dirty.take();
  }

  markUploadAll(): void {
    this.dirty.markAll();
  }

  needsCompaction(): boolean {
    return this.holes > 4096 && this.holes > this.used * 0.3;
  }

  /** Rewrites everything, e.g. after paint order (and therefore depths) changed. */
  rebuild(scene: Scene, slotOf: (id: string) => number | undefined): void {
    this.ranges.clear();
    this.used = 0;
    this.holes = 0;
    for (const element of scene.all()) {
      if (isConnector(element))
        this.set(element, scene.connectorGeometry(element.id), slotOf(element.id));
      else if (element.type === 'ink') this.setInk(element, slotOf(element.id));
    }
    this.dirty.markAll();
  }

  /** Writes (or hides, if geometry is null) a connector. */
  set(
    connector: ConnectorElement,
    geometry: ConnectorGeometry | null,
    slot: number | undefined,
  ): void {
    this.items = 0;
    if (geometry && slot !== undefined) this.instancesFor(connector, geometry, shapeDepth(slot));
    this.place(connector.id, this.theme.of(connector.type, connector.stroke));
  }

  /** Writes a pen stroke: a smooth curve through its points, as round-ended segments. */
  setInk(element: ShapeElement, slot: number | undefined): void {
    this.items = 0;
    if (slot !== undefined && isShape(element) && element.strokeWidth > 0) {
      const depth = shapeDepth(slot);
      const halfWidth = element.strokeWidth / 2;
      // Smoothed, so the stroke has no kinks between the points the pointer reported.
      const points = smoothStroke(inkWorldPoints(element), Math.max(halfWidth, 1.5));
      // A dot (a click without moving) is a zero-length segment: just its round ends.
      if (points.length === 1) points.push({ ...points[0]! });
      const directions: number[] = [];
      for (let index = 0; index + 1 < points.length; index++) {
        const start = points[index]!;
        const end = points[index + 1]!;
        this.item(start.x, start.y, end.x, end.y, halfWidth, LINE_SEGMENT, 0, 0, 0, depth, 0);
        const length = Math.hypot(end.x - start.x, end.y - start.y);
        const deltaX = length > 1e-9 ? (end.x - start.x) / length : 0;
        const deltaY = length > 1e-9 ? (end.y - start.y) / length : 0;
        directions.push(deltaX, deltaY, deltaX, deltaY);
      }
      this.joinPieces(directions);
    }
    this.place(element.id, this.theme.of(element.type, element.stroke));
  }

  /** Appends an instance to `scratch`; the last float of an item is unused. */
  private item(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    halfWidth: number,
    mode: number,
    dash: number,
    gap: number,
    dashOffset: number,
    depth: number,
    size: number,
  ): void {
    let scratch = this.scratch;
    const at = this.items * ITEM;
    if (at + ITEM > scratch.length) {
      const next = new Float32Array(scratch.length * 2);
      next.set(scratch);
      this.scratch = scratch = next;
    }
    scratch[at] = startX;
    scratch[at + 1] = startY;
    scratch[at + 2] = endX;
    scratch[at + 3] = endY;
    scratch[at + 4] = halfWidth;
    scratch[at + 5] = mode;
    scratch[at + 6] = dash;
    scratch[at + 7] = gap;
    scratch[at + 8] = dashOffset;
    scratch[at + 9] = depth;
    scratch[at + 10] = size;
    scratch[at + 11] = 0;
    this.items++;
  }

  /**
   * Splits every joint between consecutive pieces in `scratch` (all of them so far, in path
   * order) between its two pieces; `directions` has each piece's direction in and out (x, y, x, y).
   * Without it, both pieces draw the joint and its translucent edge pixels are blended twice:
   * a knot at every bend, plainly visible once the line is a pixel or two wide on screen.
   */
  private joinPieces(directions: readonly number[]): void {
    const scratch = this.scratch;
    for (let piece = 0; piece + 1 < this.items; piece++) {
      const incomingX = directions[piece * 4 + 2]!;
      const incomingY = directions[piece * 4 + 3]!;
      const outgoingX = directions[piece * 4 + 4]!;
      const outgoingY = directions[piece * 4 + 5]!;
      if ((incomingX === 0 && incomingY === 0) || (outgoingX === 0 && outgoingY === 0)) continue; // a zero-length piece
      // The split line's normal is the bisector of the two directions: half the turn from
      // the first piece's direction, minus half the turn from the second's.
      const turn = Math.atan2(
        incomingX * outgoingY - incomingY * outgoingX,
        incomingX * outgoingX + incomingY * outgoingY,
      );
      if (Math.abs(turn) > MAX_JOIN_TURN) continue;
      // Arcs split at their own end radius (only their flag is read); bends are tangent.
      const arcBefore = scratch[piece * ITEM + MODE_FLOAT] === LINE_ARC;
      const arcAfter = scratch[(piece + 1) * ITEM + MODE_FLOAT] === LINE_ARC;
      const end = piece * ITEM + JOINS_FLOAT;
      const start = (piece + 1) * ITEM + JOINS_FLOAT;
      scratch[end] = scratch[end]! + joinBits(arcBefore ? 0 : turn / 2) * JOIN_END;
      scratch[start] = scratch[start]! + joinBits(arcAfter ? 0 : -turn / 2);
    }
  }

  /** Moves the `scratch` instances into the line's range, growing (moving) it if needed. */
  private place(id: string, color: number): void {
    const count = this.items;
    let range = this.ranges.get(id);
    if (!range || count > range.capacity) {
      if (range) this.release(range);
      // Slack: a line switching between e.g. 3 and 5 elbow segments stays in place, and a
      // stroke being drawn moves O(log n) times instead of on almost every point.
      const capacity = count === 0 ? 0 : count + Math.max(4, count >> 1);
      range = { start: this.used, capacity };
      this.ensureCapacity(this.used + capacity);
      this.used += capacity;
      this.ranges.set(id, range);
    }
    for (let item = 0; item < count; item++) {
      const slot = range.start + item;
      this.floats.set(this.scratch.subarray(item * ITEM, item * ITEM + ITEM), slot * FLOATS);
      writeColorBytes(this.bytes, slot * LINE_STRIDE + COLOR_BYTE, color);
    }
    for (let item = count; item < range.capacity; item++)
      this.floats[(range.start + item) * FLOATS + MODE_FLOAT] = LINE_HIDDEN;
    this.mark(range.start, range.start + range.capacity);
  }

  remove(id: string): void {
    const range = this.ranges.get(id);
    if (!range) return;
    this.release(range);
    this.ranges.delete(id);
  }

  /** Hides a range for good: it becomes a hole until the next rebuild. */
  private release(range: Range): void {
    for (let item = 0; item < range.capacity; item++)
      this.floats[(range.start + item) * FLOATS + MODE_FLOAT] = LINE_HIDDEN;
    this.holes += range.capacity;
    this.mark(range.start, range.start + range.capacity);
  }

  /** Writes a connector's segments, arcs and caps into `scratch`. */
  private instancesFor(
    connector: ConnectorElement,
    geometry: ConnectorGeometry,
    depth: number,
  ): void {
    const halfWidth = connector.strokeWidth / 2;
    const size = capSize(connector.strokeWidth);
    const [dash, gap] = dashPattern(connector);
    const points = geometry.points.map((point) => ({ ...point }));

    // Filled caps cover the line end: stop the line inside them so it doesn't poke out of the tip.
    const shorten = (cap: CapKind, index: number, nextIndex: number, direction: Vec2) => {
      if (cap === 'none' || cap === 'arrow') return;
      const end = points[index]!;
      const neighbour = points[nextIndex]!;
      const segmentLength = Math.hypot(end.x - neighbour.x, end.y - neighbour.y);
      const shortening = Math.min(size * 0.7, segmentLength);
      end.x -= direction.x * shortening;
      end.y -= direction.y * shortening;
    };
    shorten(connector.startCap, 0, 1, geometry.startDirection);
    shorten(connector.endCap, points.length - 1, points.length - 2, geometry.endDirection);

    // Rounded bends are one exact arc each instead of their flattened points.
    const arcAt = new Map<number, ConnectorArc>();
    for (const arc of geometry.arcs ?? []) arcAt.set(arc.from, arc);
    let offset = 0;
    // Direction in and out of every piece, for the joints between them.
    const directions: number[] = [];
    for (let index = 0; index + 1 < points.length;) {
      const arc = arcAt.get(index);
      if (arc) {
        this.item(
          arc.centerX,
          arc.centerY,
          arc.radius,
          arc.start,
          halfWidth,
          LINE_ARC,
          dash,
          gap,
          offset,
          depth,
          arc.sweep,
        );
        // Tangents at the ends: the radius turned a quarter in the direction of travel.
        const sign = arc.sweep < 0 ? -1 : 1;
        const endAngle = arc.start + arc.sweep;
        directions.push(
          -Math.sin(arc.start) * sign,
          Math.cos(arc.start) * sign,
          -Math.sin(endAngle) * sign,
          Math.cos(endAngle) * sign,
        );
        offset += arc.radius * Math.abs(arc.sweep); // dashes continue along the arc's true length
        index = arc.to;
        continue;
      }
      const from = points[index]!;
      const to = points[index + 1]!;
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      index++;
      if (length < 1e-6) continue;
      this.item(
        from.x,
        from.y,
        to.x,
        to.y,
        halfWidth,
        LINE_SEGMENT,
        dash,
        gap,
        offset,
        depth,
        size,
      );
      const deltaX = (to.x - from.x) / length;
      const deltaY = (to.y - from.y) / length;
      directions.push(deltaX, deltaY, deltaX, deltaY);
      offset += length;
    }
    this.joinPieces(directions);
    const cap = (kind: CapKind, tip: Vec2, direction: Vec2) => {
      if (kind === 'none') return;
      this.item(
        tip.x,
        tip.y,
        tip.x - direction.x * size,
        tip.y - direction.y * size,
        halfWidth,
        CAP_MODE[kind],
        0,
        0,
        0,
        depth,
        size,
      );
    };
    cap(connector.startCap, geometry.points[0]!, geometry.startDirection);
    cap(connector.endCap, geometry.points[geometry.points.length - 1]!, geometry.endDirection);
  }

  private mark(from: number, to: number): void {
    this.dirty.mark(from, to);
  }

  private ensureCapacity(count: number): void {
    if (count * LINE_STRIDE <= this.buffer.byteLength) return;
    this.buffer = growBuffer(
      this.buffer,
      Math.max(count * LINE_STRIDE, this.buffer.byteLength * 2),
    );
    this.floats = new Float32Array(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
    this.dirty.markAll();
  }
}
