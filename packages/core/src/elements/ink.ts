import { boxOfPoints } from '../geometry/box';
import { distanceToSegment, type Vec2 } from '../geometry/vector';
import type { ShapeElement } from './element';

/**
 * Freehand pen strokes (`ink` elements). The polyline is stored as fractions of the box,
 * so the usual move / resize / rotate of the box reshapes the stroke for free; these
 * helpers convert between that form and world points.
 */

/** Box of a stroke this thin in one direction still gets this size (world units). */
const MIN_EXTENT = 1e-3;

/** World points of an ink stroke (rotation included). */
export function inkWorldPoints(element: ShapeElement): Vec2[] {
  const points = element.points ?? [];
  const centerX = element.x + element.width / 2;
  const centerY = element.y + element.height / 2;
  const cosine = Math.cos(element.rotation);
  const sine = Math.sin(element.rotation);
  const world: Vec2[] = [];
  for (let index = 0; index + 1 < points.length; index += 2) {
    const localX = (points[index]! - 0.5) * element.width;
    const localY = (points[index + 1]! - 0.5) * element.height;
    world.push({
      x: centerX + localX * cosine - localY * sine,
      y: centerY + localX * sine + localY * cosine,
    });
  }
  return world;
}

/** Box and normalized points of an unrotated stroke through `worldPoints`. */
export function inkGeometry(
  worldPoints: readonly Vec2[],
): Pick<ShapeElement, 'x' | 'y' | 'width' | 'height'> & { points: number[] } {
  if (worldPoints.length === 0)
    return { x: 0, y: 0, width: MIN_EXTENT, height: MIN_EXTENT, points: [] };
  const { minX, minY, maxX, maxY } = boxOfPoints(worldPoints);
  const width = Math.max(maxX - minX, MIN_EXTENT);
  const height = Math.max(maxY - minY, MIN_EXTENT);
  // A straight horizontal (or vertical) stroke has no height: center it in the minimal box.
  const x = maxX - minX < MIN_EXTENT ? minX - width / 2 : minX;
  const y = maxY - minY < MIN_EXTENT ? minY - height / 2 : minY;
  const points: number[] = [];
  for (const point of worldPoints) points.push((point.x - x) / width, (point.y - y) / height);
  return { x, y, width, height, points };
}

/**
 * Ramer–Douglas–Peucker: drops points closer than `tolerance` to the line through
 * their neighbours. Keeps the first and last point.
 */
export function simplifyStroke(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = -1;
    let worstDistance = tolerance;
    for (let index = first + 1; index < last; index++) {
      const distance = distanceToSegment(points[index]!, points[first]!, points[last]!);
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = index;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

/**
 * Pen stabilizer ("lazy brush"): the drawn point hangs on a string of `length` behind the
 * pointer and moves only when the pointer pulls the string tight. Hand tremor shorter than
 * the string is dropped and sharp jerks turn into smooth arcs, as with the pen in Miro.
 * Returns where the drawn point moves to, or null while the string is slack.
 */
export function pullString(drawn: Vec2, pointer: Vec2, length: number): Vec2 | null {
  const distance = Math.hypot(pointer.x - drawn.x, pointer.y - drawn.y);
  if (distance <= length) return null;
  const pulled = (distance - length) / distance;
  return {
    x: drawn.x + (pointer.x - drawn.x) * pulled,
    y: drawn.y + (pointer.y - drawn.y) * pulled,
  };
}

/**
 * Smooths a pen stroke: resamples it every `spacing` (so the result doesn't depend on how
 * fast the hand moved) and then evens out each point with its neighbours (1-2-1 weights)
 * `passes` times. The ends stay where they are. A circle shrinks a little, by about
 * `spacing * passes / 8`.
 */
export function relaxStroke(points: readonly Vec2[], spacing: number, passes: number): Vec2[] {
  if (points.length < 3 || !(spacing > 0)) return [...points];
  const even: Vec2[] = [points[0]!];
  let carried = 0; // length since the last resampled point
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    let along = spacing - carried;
    while (along <= length) {
      const fraction = along / length;
      even.push({ x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction });
      along += spacing;
    }
    carried = length - (along - spacing);
  }
  const last = points[points.length - 1]!;
  const tail = even[even.length - 1]!;
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > spacing * 0.25) even.push(last);
  else even[even.length - 1] = last;
  let current = even;
  for (let pass = 0; pass < passes && current.length > 2; pass++) {
    const next = current.slice();
    for (let index = 1; index < current.length - 1; index++) {
      const before = current[index - 1]!;
      const point = current[index]!;
      const after = current[index + 1]!;
      next[index] = {
        x: (before.x + 2 * point.x + after.x) / 4,
        y: (before.y + 2 * point.y + after.y) / 4,
      };
    }
    current = next;
  }
  return current;
}

/** Distance from a world point to the stroke's center line. */
export function inkDistance(element: ShapeElement, point: Vec2): number {
  const points = inkWorldPoints(element);
  if (points.length === 1) return Math.hypot(point.x - points[0]!.x, point.y - points[0]!.y);
  let best = Infinity;
  for (let index = 0; index + 1 < points.length; index++) {
    const distance = distanceToSegment(point, points[index]!, points[index + 1]!);
    if (distance < best) best = distance;
  }
  return best;
}

/** Most pieces a stroke segment is split into when smoothed. */
const MAX_SMOOTH_STEPS = 24;

/**
 * A smooth curve through the stroke's points (centripetal Catmull–Rom: no loops or
 * overshoot at sharp turns), as a polyline with pieces about `step` long. The points
 * themselves stay on the curve, so it looks like the hand drew it, without the kinks of
 * a straight line from point to point.
 */
export function smoothStroke(points: readonly Vec2[], step: number): Vec2[] {
  if (points.length < 3) return [...points];
  const smooth: Vec2[] = [points[0]!];
  const count = points.length;
  for (let index = 0; index + 1 < count; index++) {
    const start = points[index]!;
    const end = points[index + 1]!;
    // Mirrored neighbours at the ends, so the curve starts and ends along the stroke.
    const before = points[index - 1] ?? { x: 2 * start.x - end.x, y: 2 * start.y - end.y };
    const after = points[index + 2] ?? { x: 2 * end.x - start.x, y: 2 * end.y - start.y };
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.min(MAX_SMOOTH_STEPS, Math.max(1, Math.ceil(length / Math.max(step, 1e-6))));
    for (let step = 1; step <= steps; step++)
      smooth.push(catmullRom(before, start, end, after, step / steps));
  }
  return smooth;
}

/** Centripetal Catmull–Rom from `start` to `end` at `fraction` (0..1), after Barry–Goldman. */
function catmullRom(before: Vec2, start: Vec2, end: Vec2, after: Vec2, fraction: number): Vec2 {
  const knot = (from: Vec2, to: Vec2) =>
    Math.max(Math.sqrt(Math.hypot(to.x - from.x, to.y - from.y)), 1e-6);
  const knotBefore = 0;
  const knotStart = knotBefore + knot(before, start);
  const knotEnd = knotStart + knot(start, end);
  const knotAfter = knotEnd + knot(end, after);
  const parameter = knotStart + (knotEnd - knotStart) * fraction;
  const lerp = (from: Vec2, to: Vec2, knotFrom: number, knotTo: number): Vec2 => {
    const weight = (parameter - knotFrom) / (knotTo - knotFrom);
    return { x: from.x + (to.x - from.x) * weight, y: from.y + (to.y - from.y) * weight };
  };
  const firstBefore = lerp(before, start, knotBefore, knotStart);
  const firstMiddle = lerp(start, end, knotStart, knotEnd);
  const firstAfter = lerp(end, after, knotEnd, knotAfter);
  const secondStart = lerp(firstBefore, firstMiddle, knotBefore, knotEnd);
  const secondEnd = lerp(firstMiddle, firstAfter, knotStart, knotAfter);
  return lerp(secondStart, secondEnd, knotStart, knotEnd);
}

/**
 * Erases the part of a stroke (world points) inside the circle `center`, `radius`: the
 * stroke is cut exactly at the circle and falls apart into the pieces left outside it.
 * Returns those pieces (empty: nothing is left), or null if the circle doesn't touch it.
 */
export function eraseStroke(
  points: readonly Vec2[],
  center: Vec2,
  radius: number,
): Vec2[][] | null {
  const inside = (point: Vec2) => Math.hypot(point.x - center.x, point.y - center.y) <= radius;
  if (points.length === 1) return inside(points[0]!) ? [] : null;
  // Fine enough that no stretch of the stroke can cross the circle unseen.
  const dense = densify(points, radius / 2);
  if (!dense.some(inside)) return null;
  const pieces: Vec2[][] = [];
  let current: Vec2[] = [];
  for (let index = 0; index < dense.length; index++) {
    const point = dense[index]!;
    const previous = dense[index - 1];
    if (!inside(point)) {
      // Leaving the circle: start the piece right on it.
      if (current.length === 0 && previous && inside(previous))
        current.push(circleCrossing(previous, point, center, radius));
      current.push(point);
    } else if (current.length > 0) {
      // Entering it: end the piece right on it.
      current.push(circleCrossing(previous!, point, center, radius));
      pieces.push(current);
      current = [];
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces.filter((piece) => piece.length >= 2);
}

/** The stroke with extra points so no segment is longer than `step`. */
function densify(points: readonly Vec2[], step: number): Vec2[] {
  const dense: Vec2[] = [points[0]!];
  for (let index = 0; index + 1 < points.length; index++) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / Math.max(step, 1e-6)),
    );
    for (let step = 1; step <= steps; step++)
      dense.push({
        x: start.x + ((end.x - start.x) * step) / steps,
        y: start.y + ((end.y - start.y) * step) / steps,
      });
  }
  return dense;
}

/** Where the segment from `start` to `end` (one inside the circle, one outside) crosses it. */
function circleCrossing(start: Vec2, end: Vec2, center: Vec2, radius: number): Vec2 {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const offsetX = start.x - center.x;
  const offsetY = start.y - center.y;
  const squaredTerm = deltaX * deltaX + deltaY * deltaY;
  const linearTerm = 2 * (offsetX * deltaX + offsetY * deltaY);
  const constantTerm = offsetX * offsetX + offsetY * offsetY - radius * radius;
  const root = Math.sqrt(Math.max(0, linearTerm * linearTerm - 4 * squaredTerm * constantTerm));
  // The root within the segment.
  let fraction = (-linearTerm - root) / (2 * squaredTerm || 1);
  if (fraction < 0 || fraction > 1) fraction = (-linearTerm + root) / (2 * squaredTerm || 1);
  fraction = Math.min(1, Math.max(0, fraction));
  return { x: start.x + deltaX * fraction, y: start.y + deltaY * fraction };
}
