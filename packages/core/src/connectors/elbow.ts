import { boxOfPoints, inflateBox, type Box } from '../geometry/box';
import { lerp } from '../geometry/numbers';
import { subtract, type Vec2 } from '../geometry/vector';
import { ELBOW_STUB, snapToAxis, type ResolvedEnd } from './local-geometry';
import { directionOf, routeOrthogonal } from './orthogonal-router';
import type { ConnectorHandle } from './types';

// Elbow (orthogonal) routes: the default layout between two ends, and detours around
// other shapes.

/** What the elbow's bend handle moves: one coordinate, as a fraction between `from` and `to`. */
interface ElbowBend {
  axis: 'x' | 'y';
  from: number;
  to: number;
}

interface ElbowLayout {
  points: Vec2[];
  handle: ConnectorHandle | null;
  bend: ElbowBend | null;
}

const transpose = (vector: Vec2): Vec2 => ({ x: vector.y, y: vector.x });
const otherAxis = (axis: 'x' | 'y'): 'x' | 'y' => (axis === 'x' ? 'y' : 'x');

/**
 * Orthogonal route. Every case keeps two invariants: the line leaves each shape
 * along its side normal, and it never runs back over itself.
 *
 * Written for a horizontal first end; a vertical first end is handled by
 * transposing x/y in and out.
 */
export function elbowLayout(
  resolvedStart: ResolvedEnd,
  resolvedEnd: ResolvedEnd,
  at = 0.5,
): ElbowLayout {
  const startNormal = snapToAxis(
    resolvedStart.normal ?? subtract(resolvedEnd.point, resolvedStart.point),
  );
  if (startNormal.x === 0) {
    const layout = elbowLayout(
      {
        point: transpose(resolvedStart.point),
        normal: resolvedStart.normal && transpose(resolvedStart.normal),
      },
      {
        point: transpose(resolvedEnd.point),
        normal: resolvedEnd.normal && transpose(resolvedEnd.normal),
      },
      at,
    );
    return {
      points: layout.points.map(transpose),
      handle: layout.handle && {
        ...layout.handle,
        point: transpose(layout.handle.point),
        axis: otherAxis(layout.handle.axis ?? 'y'),
      },
      bend: layout.bend && { ...layout.bend, axis: otherAxis(layout.bend.axis) },
    };
  }
  const endNormal = snapToAxis(
    resolvedEnd.normal ?? subtract(resolvedStart.point, resolvedEnd.point),
  );
  // Free points have no stub: the line starts turning right there.
  const startStubLength = resolvedStart.normal ? ELBOW_STUB : 0;
  const endStubLength = resolvedEnd.normal ? ELBOW_STUB : 0;
  const stubEnd = (end: ResolvedEnd, normal: Vec2, length: number): Vec2 => ({
    x: end.point.x + normal.x * length,
    y: end.point.y + normal.y * length,
  });

  if (endNormal.x !== 0) {
    // Both ends horizontal.
    if (
      startNormal.x === -endNormal.x &&
      startNormal.x * (resolvedEnd.point.x - resolvedStart.point.x) > 0
    ) {
      // Facing each other with a gap: a Z through the middle. Stubs shrink to fit the gap,
      // otherwise in a narrow gap they would cross and the line would run backwards.
      const gap = Math.abs(resolvedEnd.point.x - resolvedStart.point.x) / 2;
      const startStub = stubEnd(resolvedStart, startNormal, Math.min(startStubLength, gap));
      const endStub = stubEnd(resolvedEnd, endNormal, Math.min(endStubLength, gap));
      // Clamped: a middle segment outside the gap would run back over the stubs.
      const middleX = lerp(startStub.x, endStub.x, Math.min(1, Math.max(0, at)));
      const handle: ConnectorHandle | null =
        Math.abs(endStub.y - startStub.y) >= 1
          ? { point: { x: middleX, y: (startStub.y + endStub.y) / 2 }, kind: 'elbow', axis: 'x' }
          : null;
      return {
        points: [
          resolvedStart.point,
          startStub,
          { x: middleX, y: startStub.y },
          { x: middleX, y: endStub.y },
          endStub,
          resolvedEnd.point,
        ],
        handle,
        bend: handle && { axis: 'x', from: startStub.x, to: endStub.x },
      };
    }
    const startStub = stubEnd(resolvedStart, startNormal, startStubLength);
    const endStub = stubEnd(resolvedEnd, endNormal, endStubLength);
    if (startNormal.x === endNormal.x) {
      // Same direction (e.g. both from right sides): go out past both, then across.
      const x =
        startNormal.x > 0 ? Math.max(startStub.x, endStub.x) : Math.min(startStub.x, endStub.x);
      return {
        points: [
          resolvedStart.point,
          startStub,
          { x, y: startStub.y },
          { x, y: endStub.y },
          endStub,
          resolvedEnd.point,
        ],
        handle: null,
        bend: null,
      };
    }
    // Facing, but each is behind the other: step out, cross over between them, step in.
    // On the same level the crossing would run back over the stubs, so detour above.
    const from = startStub.y;
    const to = Math.abs(endStub.y - startStub.y) < 1 ? startStub.y - ELBOW_STUB * 4 : endStub.y;
    const middleY = lerp(from, to, at);
    return {
      points: [
        resolvedStart.point,
        startStub,
        { x: startStub.x, y: middleY },
        { x: endStub.x, y: middleY },
        endStub,
        resolvedEnd.point,
      ],
      handle: { point: { x: (startStub.x + endStub.x) / 2, y: middleY }, kind: 'elbow', axis: 'y' },
      bend: { axis: 'y', from, to },
    };
  }

  // First end horizontal, second vertical: an L if its corner lies in front of both ends.
  const inFront = (corner: Vec2, fromStart: Vec2, fromEnd: Vec2) =>
    (corner.x - fromStart.x) * startNormal.x >= 0 && (corner.y - fromEnd.y) * endNormal.y >= 0;
  const startStub = stubEnd(resolvedStart, startNormal, startStubLength);
  const endStub = stubEnd(resolvedEnd, endNormal, endStubLength);
  const corner = { x: endStub.x, y: startStub.y };
  if (inFront(corner, startStub, endStub))
    return {
      points: [resolvedStart.point, startStub, corner, endStub, resolvedEnd.point],
      handle: null,
      bend: null,
    };
  const tight = { x: resolvedEnd.point.x, y: resolvedStart.point.y }; // without stubs, for shapes that are close
  if (inFront(tight, resolvedStart.point, resolvedEnd.point))
    return { points: [resolvedStart.point, tight, resolvedEnd.point], handle: null, bend: null };
  // Otherwise: out of the first, along to the second's stub level, across, into the second.
  return {
    points: [
      resolvedStart.point,
      startStub,
      { x: startStub.x, y: endStub.y },
      endStub,
      resolvedEnd.point,
    ],
    handle: null,
    bend: null,
  };
}

/** True if an axis-aligned segment runs through the inside of a box (edges don't count). */
function segmentCrossesBox(segmentStart: Vec2, segmentEnd: Vec2, box: Box): boolean {
  const half = 0.5; // edges and a hair inside them don't count
  if (Math.abs(segmentStart.y - segmentEnd.y) < 1e-6) {
    return (
      segmentStart.y > box.minY + half &&
      segmentStart.y < box.maxY - half &&
      Math.max(segmentStart.x, segmentEnd.x) > box.minX + half &&
      Math.min(segmentStart.x, segmentEnd.x) < box.maxX - half
    );
  }
  return (
    segmentStart.x > box.minX + half &&
    segmentStart.x < box.maxX - half &&
    Math.max(segmentStart.y, segmentEnd.y) > box.minY + half &&
    Math.min(segmentStart.y, segmentEnd.y) < box.maxY - half
  );
}

/**
 * Whether a route cuts through the shapes it connects. The first/last segments are
 * skipped: they leave/enter the shape by construction (and for points on rounded
 * outlines they necessarily clip the box corner).
 */
function routeCrossesEnds(points: Vec2[], startBox?: Box, endBox?: Box): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    const segmentStart = points[i]!;
    const segmentEnd = points[i + 1]!;
    if (startBox && i > 0 && segmentCrossesBox(segmentStart, segmentEnd, startBox)) return true;
    if (endBox && i < points.length - 2 && segmentCrossesBox(segmentStart, segmentEnd, endBox))
      return true;
  }
  return false;
}

/** Moves from `point` along axis direction `normal` until outside `box` (and at least `minimum` away). */
function exitPoint(point: Vec2, normal: Vec2, minimum: number, box?: Box): Vec2 {
  let candidate = minimum;
  if (box) {
    if (normal.x > 0) candidate = Math.max(candidate, box.maxX - point.x);
    else if (normal.x < 0) candidate = Math.max(candidate, point.x - box.minX);
    else if (normal.y > 0) candidate = Math.max(candidate, box.maxY - point.y);
    else candidate = Math.max(candidate, point.y - box.minY);
  }
  return { x: point.x + normal.x * candidate, y: point.y + normal.y * candidate };
}

/**
 * Finds shapes (other than the connected ones) whose boxes intersect `area`:
 * the obstacles an elbow route should go around. Provided by the scene's spatial index.
 */
export type ObstacleQuery = (area: Box) => Box[];

/** Clearance around other shapes; smaller than the stub so lines fit between close shapes. */
const OBSTACLE_MARGIN = 12;
/** Re-route at most this many times when a detour runs into shapes it didn't know about. */
const MAX_ROUTE_PASSES = 3;
/** Obstacles per search: keeps one route in the low milliseconds on any board. */
const MAX_OBSTACLES = 48;

export function routeCrossesAny(points: Vec2[], boxes: Box[]): boolean {
  // Every segment counts here (a straight line is a single segment); only the connected
  // shapes get the exemption for the segments leaving/entering them.
  for (let i = 0; i + 1 < points.length; i++) {
    for (const box of boxes) if (segmentCrossesBox(points[i]!, points[i + 1]!, box)) return true;
  }
  return false;
}

const boxKey = (box: Box) => `${box.minX},${box.minY},${box.maxX},${box.maxY}`;

/** Distance between a box and an axis-aligned segment (0 if they touch). */
function boxSegmentDistance(box: Box, segmentStart: Vec2, segmentEnd: Vec2): number {
  const deltaX = Math.max(
    box.minX - Math.max(segmentStart.x, segmentEnd.x),
    Math.min(segmentStart.x, segmentEnd.x) - box.maxX,
    0,
  );
  const deltaY = Math.max(
    box.minY - Math.max(segmentStart.y, segmentEnd.y),
    Math.min(segmentStart.y, segmentEnd.y) - box.maxY,
    0,
  );
  return Math.hypot(deltaX, deltaY);
}

/** Up to `limit` boxes closest to any of the polylines (all of them if there are few). */
function closestBoxes(boxes: Box[], paths: Vec2[][], limit: number): Box[] {
  if (boxes.length <= limit) return boxes;
  const scored = boxes.map((box) => {
    let distance = Infinity;
    for (const path of paths)
      for (let i = 0; i + 1 < path.length; i++)
        distance = Math.min(distance, boxSegmentDistance(box, path[i]!, path[i + 1]!));
    return { box, distance };
  });
  scored.sort((first, second) => first.distance - second.distance);
  return scored.slice(0, limit).map((scoredBox) => scoredBox.box);
}

/** Orthogonal path around the connected shapes and `others`, or null if there is none. */
function routeAround(
  start: ResolvedEnd,
  end: ResolvedEnd,
  startBox: Box | undefined,
  endBox: Box | undefined,
  others: Box[],
): Vec2[] | null {
  const startNormal = snapToAxis(start.normal ?? subtract(end.point, start.point));
  const endNormal = snapToAxis(end.normal ?? subtract(start.point, end.point));
  const stub = ELBOW_STUB;
  const startArea = startBox && inflateBox(startBox, stub);
  const endArea = endBox && inflateBox(endBox, stub);
  const from = exitPoint(start.point, startNormal, start.normal ? stub : 0, startArea);
  const to = exitPoint(end.point, endNormal, end.normal ? stub : 0, endArea);
  const ends = [startBox, endBox].filter((box): box is Box => !!box);
  const path = routeOrthogonal({
    from,
    fromDirection: directionOf(startNormal),
    to,
    toDirection: directionOf({ x: -endNormal.x, y: -endNormal.y }),
    obstacles: [
      ...ends.map((box) => ({ box, margin: stub })),
      ...others.map((box) => ({ box, margin: OBSTACLE_MARGIN })),
    ],
    centered: [startArea, endArea].filter((box): box is Box => !!box),
    bendCost: stub * 2,
    margin: stub,
  });
  return path && simplify([start.point, ...path, end.point]);
}

export function elbowPoints(
  start: ResolvedEnd,
  end: ResolvedEnd,
  at = 0.5,
  startBox?: Box,
  endBox?: Box,
  findObstacles?: ObstacleQuery,
): { points: Vec2[]; handle: ConnectorHandle | null; routed: boolean } {
  const layout = elbowLayout(start, end, at);
  const simple = simplify(layout.points);
  const known = new Map<string, Box>();
  const discover = (points: Vec2[]): Box[] => {
    if (!findObstacles) return [];
    const fresh: Box[] = [];
    for (const box of findObstacles(inflateBox(boxOfPoints(points), OBSTACLE_MARGIN))) {
      const key = boxKey(box);
      if (!known.has(key)) {
        known.set(key, box);
        fresh.push(box);
      }
    }
    return fresh;
  };
  const nearby = discover(simple);
  if (!routeCrossesEnds(simple, startBox, endBox) && !routeCrossesAny(simple, nearby)) {
    return { points: simple, handle: layout.handle, routed: false };
  }
  // The template route cuts through a shape: search a path around everything in the way.
  // A detour can reach shapes outside the first search area, so look again along it.
  // The search grid grows with the square of the obstacle count, so on a dense board only
  // the shapes closest to the paths tried so far take part (those it crosses come first).
  let best: Vec2[] | null = null;
  const tried = [simple];
  for (let pass = 0; pass < MAX_ROUTE_PASSES; pass++) {
    const obstacles = closestBoxes([...known.values()], tried, MAX_OBSTACLES);
    const routed = routeAround(start, end, startBox, endBox, obstacles);
    if (!routed) break;
    best = routed;
    tried.push(routed);
    const more = discover(routed);
    if (!routeCrossesAny(routed, more)) break;
  }
  return best
    ? { points: best, handle: null, routed: true }
    : { points: simple, handle: layout.handle, routed: false };
}

/** Drops duplicate and collinear points (keeps the ends). */
export function simplify(points: Vec2[]): Vec2[] {
  const kept: Vec2[] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (last && Math.abs(last.x - point.x) < 1e-6 && Math.abs(last.y - point.y) < 1e-6) continue;
    if (kept.length >= 2) {
      const previous = kept[kept.length - 2]!;
      const cross =
        (last!.x - previous.x) * (point.y - previous.y) -
        (last!.y - previous.y) * (point.x - previous.x);
      const dot =
        (last!.x - previous.x) * (point.x - last!.x) + (last!.y - previous.y) * (point.y - last!.y);
      if (Math.abs(cross) < 1e-6 && dot >= 0) kept[kept.length - 1] = point;
      else kept.push(point);
    } else kept.push(point);
  }
  if (kept.length === 1) kept.push({ ...kept[0]! });
  return kept;
}
