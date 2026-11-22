import type { Box } from './box';

/**
 * Snapping while moving and resizing, like Figma's smart guides: edges and centers of
 * the moving box stick to edges and centers of other elements within a threshold, and
 * the alignment is shown as guide lines. Where no element is near, the box snaps to the
 * board grid.
 */

/** Spacing of the board grid at zoom 1, world units. */
export const GRID_BASE = 24;
/** Finer grid levels are hidden below this on-screen spacing, px. */
export const GRID_MIN_PX = 12;

/** Spacing of the finest visible grid level at a zoom (4× coarser per level, like the drawn grid). */
export function gridStep(zoom: number): number {
  let spacing = GRID_BASE;
  if (!(zoom > 0) || !Number.isFinite(zoom)) return spacing;
  for (let level = 0; level < 64 && spacing * zoom < GRID_MIN_PX; level++) spacing *= 4;
  return spacing;
}

export type SnapAxis = 'x' | 'y';
/** Which line of a box along an axis: its start, its middle or its end. */
export type SnapEdge = 'min' | 'center' | 'max';

/**
 * A guide line: vertical (`axis: 'x'`, the line x = `at` from y = `from` to `to`) or
 * horizontal (`axis: 'y'`, y = `at` from x = `from` to `to`). `marks` are the aligned
 * points along it (drawn as small crosses).
 */
export interface SnapGuide {
  axis: SnapAxis;
  at: number;
  from: number;
  to: number;
  marks: number[];
}

/** One gap of a `SpacingGuide`: across the gap from `from` to `to`, at `at` on the other axis. */
export interface SpacingSegment {
  from: number;
  to: number;
  at: number;
}

/**
 * Equal spacing (Figma's distance guides): the gaps along `axis` that are all
 * `distance` wide.
 */
export interface SpacingGuide {
  axis: SnapAxis;
  distance: number;
  segments: SpacingSegment[];
}

export interface SnapOptions {
  /** How close counts as aligned, world units (usually a few screen px / zoom). */
  threshold: number;
  /** Grid step to fall back to (world units); 0 or absent: no grid snapping. */
  grid?: number;
  /** Which edges of the box move: all (a move), or the dragged sides of a resize. */
  edges?: { x: readonly SnapEdge[]; y: readonly SnapEdge[] };
  /** Axes that must not change (Shift's axis lock, a resize along one side). */
  lockX?: boolean;
  lockY?: boolean;
}

export interface SnapResult {
  /** Correction to add to the box's position (or to the dragged edges). */
  deltaX: number;
  deltaY: number;
  guides: SnapGuide[];
  /** Equal gaps the box now forms with its neighbours (moves only). */
  spacing: SpacingGuide[];
}

const ALL_EDGES = ['min', 'center', 'max'] as const;
const EPSILON = 1e-6;
/** Gaps that differ by less than this count as equal (world units). */
const GAP_EPSILON = 0.01;

const minimumOf = (box: Box, axis: SnapAxis) => (axis === 'x' ? box.minX : box.minY);
const maximumOf = (box: Box, axis: SnapAxis) => (axis === 'x' ? box.maxX : box.maxY);
const crossAxisOf = (axis: SnapAxis): SnapAxis => (axis === 'x' ? 'y' : 'x');

const lineOf = (box: Box, axis: SnapAxis, edge: SnapEdge): number => {
  const minimum = minimumOf(box, axis);
  const maximum = maximumOf(box, axis);
  return edge === 'min' ? minimum : edge === 'max' ? maximum : (minimum + maximum) / 2;
};

/** Boxes in the same row (`axis` x) or column (y) as `box`: they overlap it across the axis. */
const rowOf = (box: Box, targets: readonly Box[], axis: SnapAxis): Box[] => {
  const crossAxis = crossAxisOf(axis);
  return targets.filter(
    (target) =>
      minimumOf(target, crossAxis) < maximumOf(box, crossAxis) &&
      maximumOf(target, crossAxis) > minimumOf(box, crossAxis),
  );
};

/** Nearest of `neighbours` entirely before `box` along the axis (largest end), or null. */
const nearestBefore = (box: Box, neighbours: readonly Box[], axis: SnapAxis): Box | null => {
  let nearest: Box | null = null;
  for (const target of neighbours) {
    if (target === box || maximumOf(target, axis) > minimumOf(box, axis) + EPSILON) continue;
    if (!nearest || maximumOf(target, axis) > maximumOf(nearest, axis)) nearest = target;
  }
  return nearest;
};

/** Nearest of `neighbours` entirely after `box` along the axis (smallest start), or null. */
const nearestAfter = (box: Box, neighbours: readonly Box[], axis: SnapAxis): Box | null => {
  let nearest: Box | null = null;
  for (const target of neighbours) {
    if (target === box || minimumOf(target, axis) < maximumOf(box, axis) - EPSILON) continue;
    if (!nearest || minimumOf(target, axis) < minimumOf(nearest, axis)) nearest = target;
  }
  return nearest;
};

/**
 * Positions (the box's start along the axis) where it would make equal gaps, as in
 * Figma: centered between its two neighbours, or continuing the gap of the pair next to it.
 */
function spacingCandidates(moving: Box, targets: readonly Box[], axis: SnapAxis): number[] {
  const neighbours = rowOf(moving, targets, axis);
  if (neighbours.length === 0) return [];
  const size = maximumOf(moving, axis) - minimumOf(moving, axis);
  // Neighbours relative to the box's center, so they don't flip while it is snapped.
  const middle = (minimumOf(moving, axis) + maximumOf(moving, axis)) / 2;
  const probe: Box =
    axis === 'x'
      ? { minX: middle, maxX: middle, minY: moving.minY, maxY: moving.maxY }
      : { minY: middle, maxY: middle, minX: moving.minX, maxX: moving.maxX };
  const left = nearestBefore(probe, neighbours, axis);
  const right = nearestAfter(probe, neighbours, axis);
  const candidates: number[] = [];
  if (left && right) {
    const room = minimumOf(right, axis) - maximumOf(left, axis) - size;
    if (room > 0) candidates.push(maximumOf(left, axis) + room / 2);
  }
  if (left) {
    const previous = nearestBefore(left, neighbours, axis);
    const gap = previous ? minimumOf(left, axis) - maximumOf(previous, axis) : 0;
    if (gap > 0) candidates.push(maximumOf(left, axis) + gap);
  }
  if (right) {
    const next = nearestAfter(right, neighbours, axis);
    const gap = next ? minimumOf(next, axis) - maximumOf(right, axis) : 0;
    if (gap > 0) candidates.push(minimumOf(right, axis) - gap - size);
  }
  return candidates;
}

/** Segment across the gap between `first` and `second` (first before second), in the middle of their overlap. */
const gapSegment = (first: Box, second: Box, axis: SnapAxis): SpacingSegment => {
  const crossAxis = crossAxisOf(axis);
  const low = Math.max(minimumOf(first, crossAxis), minimumOf(second, crossAxis));
  const high = Math.min(maximumOf(first, crossAxis), maximumOf(second, crossAxis));
  return { from: maximumOf(first, axis), to: minimumOf(second, axis), at: (low + high) / 2 };
};

/** Equal gaps around the (snapped) box: chains of neighbours spaced like its own gaps. */
function spacingGuides(box: Box, targets: readonly Box[], axis: SnapAxis): SpacingGuide[] {
  const neighbours = [...rowOf(box, targets, axis), box];
  const chain = (gap: number, direction: 'before' | 'after'): SpacingSegment[] => {
    const segments: SpacingSegment[] = [];
    let current = box;
    for (let link = 0; link < 64; link++) {
      const before = direction === 'before';
      const neighbour = before
        ? nearestBefore(current, neighbours, axis)
        : nearestAfter(current, neighbours, axis);
      if (!neighbour) break;
      const gapSize = before
        ? minimumOf(current, axis) - maximumOf(neighbour, axis)
        : minimumOf(neighbour, axis) - maximumOf(current, axis);
      if (Math.abs(gapSize - gap) > GAP_EPSILON) break;
      segments.push(
        before ? gapSegment(neighbour, current, axis) : gapSegment(current, neighbour, axis),
      );
      current = neighbour;
    }
    return segments;
  };
  const left = nearestBefore(box, neighbours, axis);
  const right = nearestAfter(box, neighbours, axis);
  const gapLeft = left ? minimumOf(box, axis) - maximumOf(left, axis) : -1;
  const gapRight = right ? minimumOf(right, axis) - maximumOf(box, axis) : -1;
  if (gapLeft > 0 && gapRight > 0 && Math.abs(gapLeft - gapRight) <= GAP_EPSILON) {
    return [
      {
        axis,
        distance: gapLeft,
        segments: [...chain(gapLeft, 'before'), ...chain(gapRight, 'after')],
      },
    ];
  }
  const guides: SpacingGuide[] = [];
  for (const [gap, direction] of [
    [gapLeft, 'before'],
    [gapRight, 'after'],
  ] as const) {
    if (gap <= 0) continue;
    const segments = chain(gap, direction);
    if (segments.length >= 2) guides.push({ axis, distance: gap, segments });
  }
  return guides;
}

interface AxisSnap {
  delta: number;
  /** Snapped to an element line (not the grid): guides are drawn. */
  matched: boolean;
}

const NO_SNAP: AxisSnap = { delta: 0, matched: false };

/** Best correction along one axis: to an element line within the threshold, else the grid. */
function snapAxis(
  moving: Box,
  targets: readonly Box[],
  axis: SnapAxis,
  edges: readonly SnapEdge[],
  threshold: number,
  grid: number,
  spacing: boolean,
): AxisSnap {
  let best = Infinity;
  const consider = (distance: number) => {
    if (Math.abs(distance) <= threshold && Math.abs(distance) < Math.abs(best)) best = distance;
  };
  if (spacing) {
    const low = lineOf(moving, axis, 'min');
    for (const position of spacingCandidates(moving, targets, axis)) consider(position - low);
  }
  for (const edge of edges) {
    const movingLine = lineOf(moving, axis, edge);
    for (const target of targets)
      for (const targetEdge of ALL_EDGES) consider(lineOf(target, axis, targetEdge) - movingLine);
  }
  if (best !== Infinity) return { delta: best, matched: true };
  if (grid > 0) {
    // The first moving edge (the box's corner for a move, the dragged side for a resize).
    const movingLine = lineOf(moving, axis, edges[0]!);
    return { delta: Math.round(movingLine / grid) * grid - movingLine, matched: false };
  }
  return NO_SNAP;
}

/** Guide lines for the element lines the (already snapped) box now lines up with. */
function guidesFor(
  box: Box,
  targets: readonly Box[],
  axis: SnapAxis,
  edges: readonly SnapEdge[],
): SnapGuide[] {
  const crossAxis = crossAxisOf(axis);
  const byLine = new Map<number, SnapGuide>();
  for (const edge of edges) {
    const at = lineOf(box, axis, edge);
    for (const target of targets) {
      const aligned = ALL_EDGES.some(
        (targetEdge) => Math.abs(lineOf(target, axis, targetEdge) - at) < EPSILON,
      );
      if (!aligned) continue;
      const key = Math.round(at * 1e4) / 1e4;
      let guide = byLine.get(key);
      if (!guide) {
        const low = lineOf(box, crossAxis, 'min');
        const high = lineOf(box, crossAxis, 'max');
        guide = { axis, at, from: low, to: high, marks: [low, high] };
        byLine.set(key, guide);
      }
      const low = lineOf(target, crossAxis, 'min');
      const high = lineOf(target, crossAxis, 'max');
      guide.from = Math.min(guide.from, low);
      guide.to = Math.max(guide.to, high);
      guide.marks.push(low, high);
    }
  }
  return [...byLine.values()];
}

/** The box after the corrections: a move shifts it, a resize moves only the dragged edges. */
function snappedBox(
  moving: Box,
  x: AxisSnap,
  y: AxisSnap,
  edges: SnapOptions['edges'] | undefined,
): Box {
  if (!edges) {
    return {
      minX: moving.minX + x.delta,
      maxX: moving.maxX + x.delta,
      minY: moving.minY + y.delta,
      maxY: moving.maxY + y.delta,
    };
  }
  const moved = (value: number, delta: number, axisEdges: readonly SnapEdge[], edge: SnapEdge) =>
    axisEdges.includes(edge) ? value + delta : value;
  return {
    minX: moved(moving.minX, x.delta, edges.x, 'min'),
    maxX: moved(moving.maxX, x.delta, edges.x, 'max'),
    minY: moved(moving.minY, y.delta, edges.y, 'min'),
    maxY: moved(moving.maxY, y.delta, edges.y, 'max'),
  };
}

/**
 * Snaps a box being moved or resized. `moving` is where the pointer would put it,
 * `targets` the boxes of the other elements nearby. Returns the correction and the guides
 * to draw.
 */
export function snapBox(moving: Box, targets: readonly Box[], options: SnapOptions): SnapResult {
  const grid = options.grid ?? 0;
  const resize = !!options.edges;
  const edgesX = options.edges?.x ?? ALL_EDGES;
  const edgesY = options.edges?.y ?? ALL_EDGES;
  const x =
    options.lockX || edgesX.length === 0
      ? NO_SNAP
      : snapAxis(moving, targets, 'x', edgesX, options.threshold, grid, !resize);
  const y =
    options.lockY || edgesY.length === 0
      ? NO_SNAP
      : snapAxis(moving, targets, 'y', edgesY, options.threshold, grid, !resize);
  // Guides are computed on the box after both corrections, so their extents are final.
  const snapped = snappedBox(moving, x, y, options.edges);
  const guides = [
    ...(x.matched ? guidesFor(snapped, targets, 'x', edgesX) : []),
    ...(y.matched ? guidesFor(snapped, targets, 'y', edgesY) : []),
  ];
  const spacing = resize
    ? []
    : [
        ...(x.matched ? spacingGuides(snapped, targets, 'x') : []),
        ...(y.matched ? spacingGuides(snapped, targets, 'y') : []),
      ];
  return { deltaX: x.delta, deltaY: y.delta, guides, spacing };
}
