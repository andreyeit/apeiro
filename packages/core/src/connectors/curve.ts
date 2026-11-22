import { normalize, subtract, vectorLength, type Vec2 } from '../geometry/vector';
import type { ResolvedEnd } from './local-geometry';
import type { ConnectorElement } from './types';

// Curved connectors: cubic Bézier segments through an optional bend point.

/** Control points of the automatic cubic curve between two ends. */
export function autoControls(start: ResolvedEnd, end: ResolvedEnd): [Vec2, Vec2] {
  const distance = vectorLength(subtract(end.point, start.point));
  const reach = Math.min(Math.max(distance * 0.4, 20), 240);
  const startNormal = start.normal ?? normalize(subtract(end.point, start.point));
  const endNormal = end.normal ?? normalize(subtract(start.point, end.point));
  return [
    { x: start.point.x + startNormal.x * reach, y: start.point.y + startNormal.y * reach },
    { x: end.point.x + endNormal.x * reach, y: end.point.y + endNormal.y * reach },
  ];
}

/** Midpoint (parameter 0.5) of a cubic Bézier. */
export const bezierMiddle = (
  start: Vec2,
  startControl: Vec2,
  endControl: Vec2,
  end: Vec2,
): Vec2 => ({
  x: (start.x + 3 * startControl.x + 3 * endControl.x + end.x) / 8,
  y: (start.y + 3 * startControl.y + 3 * endControl.y + end.y) / 8,
});

/** The chord's frame: its unit direction (start → end), left normal and length. */
export interface Chord {
  tangent: Vec2;
  normal: Vec2;
  length: number;
}

/** The frame of the chord from `start` to `end` (bends are stored relative to it). */
export function chord(start: ResolvedEnd, end: ResolvedEnd): Chord {
  const delta = subtract(end.point, start.point);
  const tangent = normalize(delta);
  return {
    tangent,
    normal: { x: -tangent.y, y: tangent.x },
    length: Math.max(vectorLength(delta), 1),
  };
}

/** Where a curve passes at its middle: the automatic curve's midpoint, moved by the bend. */
export function bendPoint(
  start: ResolvedEnd,
  end: ResolvedEnd,
  bend?: ConnectorElement['curve'],
): Vec2 {
  const [startControl, endControl] = autoControls(start, end);
  const middle = bezierMiddle(start.point, startControl, endControl, end.point);
  if (!bend) return middle;
  const { tangent, normal, length } = chord(start, end);
  return {
    x: middle.x + (tangent.x * bend.along + normal.x * bend.across) * length,
    y: middle.y + (tangent.y * bend.along + normal.y * bend.across) * length,
  };
}

/** Appends a flattened cubic Bézier to `points` (without its first point with `skipFirst`). */
function appendCubic(
  points: Vec2[],
  start: Vec2,
  startControl: Vec2,
  endControl: Vec2,
  end: Vec2,
  skipFirst: boolean,
): void {
  const length =
    vectorLength(subtract(startControl, start)) +
    vectorLength(subtract(endControl, startControl)) +
    vectorLength(subtract(end, endControl));
  // ~8 world units per segment: smooth up to a few hundred percent zoom.
  const segments = Math.min(96, Math.max(8, Math.ceil(length / 8)));
  for (let segment = skipFirst ? 1 : 0; segment <= segments; segment++) {
    const fraction = segment / segments;
    const remaining = 1 - fraction;
    const startWeight = remaining * remaining * remaining;
    const startControlWeight = 3 * remaining * remaining * fraction;
    const endControlWeight = 3 * remaining * fraction * fraction;
    const endWeight = fraction * fraction * fraction;
    points.push({
      x:
        startWeight * start.x +
        startControlWeight * startControl.x +
        endControlWeight * endControl.x +
        endWeight * end.x,
      y:
        startWeight * start.y +
        startControlWeight * startControl.y +
        endControlWeight * endControl.y +
        endWeight * end.y,
    });
  }
}

/**
 * Without a bend: one cubic leaving each end along its normal.
 * With a bend: two cubics joined smoothly at the bend point, with the tangent there
 * parallel to the chord, so even strong bends stay round instead of turning into a cusp.
 */
export function curvePoints(start: ResolvedEnd, end: ResolvedEnd, bend?: Vec2): Vec2[] {
  const points: Vec2[] = [];
  if (!bend) {
    const [startControl, endControl] = autoControls(start, end);
    appendCubic(points, start.point, startControl, endControl, end.point, false);
    return points;
  }
  const { tangent } = chord(start, end);
  const startTowardBend = normalize(subtract(bend, start.point));
  const endTowardBend = normalize(subtract(bend, end.point));
  // Leave each end between its side normal and the bend point: pure normals overshoot
  // (and loop) when the ends are close and the bend is large.
  const startNormal = start.normal
    ? normalize({
        x: startTowardBend.x + start.normal.x * 0.5,
        y: startTowardBend.y + start.normal.y * 0.5,
      })
    : startTowardBend;
  const endNormal = end.normal
    ? normalize({
        x: endTowardBend.x + end.normal.x * 0.5,
        y: endTowardBend.y + end.normal.y * 0.5,
      })
    : endTowardBend;
  const startReach = Math.min(Math.max(vectorLength(subtract(bend, start.point)) * 0.4, 8), 240);
  const endReach = Math.min(Math.max(vectorLength(subtract(end.point, bend)) * 0.4, 8), 240);
  appendCubic(
    points,
    start.point,
    {
      x: start.point.x + startNormal.x * startReach,
      y: start.point.y + startNormal.y * startReach,
    },
    { x: bend.x - tangent.x * startReach, y: bend.y - tangent.y * startReach },
    bend,
    false,
  );
  appendCubic(
    points,
    bend,
    { x: bend.x + tangent.x * endReach, y: bend.y + tangent.y * endReach },
    { x: end.point.x + endNormal.x * endReach, y: end.point.y + endNormal.y * endReach },
    end.point,
    true,
  );
  return points;
}
