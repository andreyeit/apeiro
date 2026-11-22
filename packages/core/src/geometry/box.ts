import type { Vec2 } from './vector';

/** Axis-aligned bounding box in world coordinates. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boxIntersects(first: Box, second: Box): boolean {
  return (
    first.minX <= second.maxX &&
    first.maxX >= second.minX &&
    first.minY <= second.maxY &&
    first.maxY >= second.minY
  );
}

export function boxContainsBox(outer: Box, inner: Box): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

/** Whether `point` lies strictly inside `box`. */
export const boxContainsPoint = (box: Box, point: Vec2): boolean =>
  point.x > box.minX && point.x < box.maxX && point.y > box.minY && point.y < box.maxY;

export function boxFromPoints(start: Vec2, end: Vec2): Box {
  return {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  };
}

/** The smallest box around `points`; an empty, inverted box (±Infinity) when there are none. */
export function boxOfPoints(points: Iterable<Vec2>): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

/** The square box of half size `radius` around `point`. */
export const boxAroundPoint = (point: Vec2, radius: number): Box => ({
  minX: point.x - radius,
  minY: point.y - radius,
  maxX: point.x + radius,
  maxY: point.y + radius,
});

export function boxUnion(first: Box, second: Box): Box {
  return {
    minX: Math.min(first.minX, second.minX),
    minY: Math.min(first.minY, second.minY),
    maxX: Math.max(first.maxX, second.maxX),
    maxY: Math.max(first.maxY, second.maxY),
  };
}

/** `box` grown by `marginX` on the left and right and `marginY` (default `marginX`) above and below. */
export const inflateBox = (box: Box, marginX: number, marginY = marginX): Box => ({
  minX: box.minX - marginX,
  minY: box.minY - marginY,
  maxX: box.maxX + marginX,
  maxY: box.maxY + marginY,
});
