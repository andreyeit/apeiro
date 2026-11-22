import type { ShapeElement } from '../elements/element';
import { localToWorld, worldToLocal } from '../geometry/frame';
import type { Vec2 } from '../geometry/vector';
import { anchorLocal, projectToOutline } from './local-geometry';

// Anchors: fixed attachment points of connector ends, in 0..1 box coordinates of a shape.

/** Middles of the four sides, in 0..1 box coords: the magnets for connector ends. */
export const SIDE_MIDPOINTS: readonly Vec2[] = [
  { x: 0.5, y: 0 },
  { x: 1, y: 0.5 },
  { x: 0.5, y: 1 },
  { x: 0, y: 0.5 },
];

export const isSideMidpoint = (anchor: Vec2): boolean =>
  SIDE_MIDPOINTS.some((midpoint) => midpoint.x === anchor.x && midpoint.y === anchor.y);

/** Along a side, the midpoint magnet reaches at least this share of the side's length. */
const MAGNET_ALONG_SHARE = 0.2;

/**
 * Anchor (0..1 box coords) for a world point on/near a shape:
 * - a side midpoint wins when the point is within `snap` world units across that side
 *   and within `snap` or 20% of the side's length along it (a strip, not a circle:
 *   aiming "roughly at the middle of the edge" is enough);
 * - otherwise a point within `edge` units of the outline is projected onto it;
 * - otherwise (deep inside) undefined, i.e. floating.
 */
export function anchorAt(
  shape: ShapeElement,
  world: Vec2,
  snap: number,
  edge = 0,
): Vec2 | undefined {
  const local = worldToLocal(shape, world);
  let best: Vec2 | undefined;
  let bestDistance = Infinity;
  for (const midpoint of SIDE_MIDPOINTS) {
    const localX = (midpoint.x - 0.5) * shape.width;
    const localY = (midpoint.y - 0.5) * shape.height;
    const horizontalSide = midpoint.x === 0.5; // top or bottom
    const along = horizontalSide ? Math.abs(local.x - localX) : Math.abs(local.y - localY);
    const across = horizontalSide ? Math.abs(local.y - localY) : Math.abs(local.x - localX);
    const reach = Math.max(
      snap,
      (horizontalSide ? shape.width : shape.height) * MAGNET_ALONG_SHARE,
    );
    if (across > snap || along > reach) continue;
    const distance = Math.hypot(along, across);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = midpoint;
    }
  }
  if (best) return best;
  if (edge <= 0) return undefined;
  const projected = projectToOutline(shape, local);
  if (Math.hypot(local.x - projected.x, local.y - projected.y) > edge) return undefined;
  return {
    x: projected.x / (shape.width || 1) + 0.5,
    y: projected.y / (shape.height || 1) + 0.5,
  };
}

/** Exact anchor (0..1 box coords) of a world point, no snapping. Values snap to 0/0.5/1 within float noise. */
export function anchorOf(shape: ShapeElement, world: Vec2): Vec2 {
  const local = worldToLocal(shape, world);
  const clean = (value: number) => {
    for (const snapped of [0, 0.5, 1]) if (Math.abs(value - snapped) < 1e-6) return snapped;
    return value;
  };
  return {
    x: clean(local.x / (shape.width || 1) + 0.5),
    y: clean(local.y / (shape.height || 1) + 0.5),
  };
}

/** World position of a fixed anchor, e.g. to draw snap handles. */
export function anchorPoint(shape: ShapeElement, anchor: Vec2): Vec2 {
  return localToWorld(shape, anchorLocal(shape, anchor));
}
