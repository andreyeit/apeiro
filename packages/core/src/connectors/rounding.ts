import { normalize, subtract, vectorLength, type Vec2 } from '../geometry/vector';

// Rounded bends of elbow lines: arcs at the corners of a polyline.

/**
 * How far (world units) the flattened arc may stray from the true circle. Only hit testing
 * and bounds use the flattened points: renderers draw `arcs` exactly.
 */
const ARC_TOLERANCE = 0.05;

/**
 * A rounded bend: a circular arc, and which points of the polyline approximate it
 * (`from`..`to`, inclusive). Renderers draw the arc itself, so it stays smooth at any zoom.
 */
export interface ConnectorArc {
  centerX: number;
  centerY: number;
  radius: number;
  /** Angle of the arc's start, radians (atan2 convention, y down). */
  start: number;
  /** Signed angle from start to end. */
  sweep: number;
  from: number;
  to: number;
}

/**
 * Replaces every bend of a polyline with a circular arc of `radius` tangent to both
 * segments (Miro's rounded elbows). The radius shrinks where a segment is too short for it:
 * each arc takes at most half of either adjacent segment, so arcs never overlap.
 */
export function roundCorners(points: Vec2[], radius: number): Vec2[] {
  return roundCornersWithArcs(points, radius).points;
}

/** `roundCorners`, plus the exact arcs (for drawing) and where they sit in the polyline. */
export function roundCornersWithArcs(
  points: Vec2[],
  cornerRadius: number,
): { points: Vec2[]; arcs: ConnectorArc[] } {
  if (points.length < 3 || cornerRadius <= 0) return { points, arcs: [] };
  const arcs: ConnectorArc[] = [];
  const rounded: Vec2[] = [points[0]!];
  for (let i = 1; i + 1 < points.length; i++) {
    const previous = points[i - 1]!;
    const point = points[i]!;
    const next = points[i + 1]!;
    const lengthIn = vectorLength(subtract(point, previous));
    const lengthOut = vectorLength(subtract(next, point));
    const directionIn = normalize(subtract(point, previous));
    const directionOut = normalize(subtract(next, point));
    const cosine = Math.max(
      -1,
      Math.min(1, directionIn.x * directionOut.x + directionIn.y * directionOut.y),
    );
    const turn = Math.acos(cosine);
    if (lengthIn < 1e-9 || lengthOut < 1e-9 || turn < 1e-3 || turn > Math.PI - 1e-3) {
      rounded.push(point);
      continue;
    }
    // Distance from the corner to where the arc touches each segment.
    const tanHalf = Math.tan(turn / 2);
    const cut = Math.min(cornerRadius * tanHalf, lengthIn / 2, lengthOut / 2);
    const radius = cut / tanHalf;
    const arcStart = { x: point.x - directionIn.x * cut, y: point.y - directionIn.y * cut };
    const arcEnd = { x: point.x + directionOut.x * cut, y: point.y + directionOut.y * cut };
    // Center: from the arc's start, perpendicular to the incoming segment, toward the turn.
    const normal = normalize({
      x: directionOut.x - directionIn.x * cosine,
      y: directionOut.y - directionIn.y * cosine,
    });
    const center = { x: arcStart.x + normal.x * radius, y: arcStart.y + normal.y * radius };
    const startAngle = Math.atan2(arcStart.y - center.y, arcStart.x - center.x);
    let sweep = Math.atan2(arcEnd.y - center.y, arcEnd.x - center.x) - startAngle;
    if (sweep > Math.PI) sweep -= Math.PI * 2;
    if (sweep < -Math.PI) sweep += Math.PI * 2;
    // Chord sagitta ≈ radius · step² / 8: enough steps to stay within the tolerance.
    const maxStep = Math.sqrt((8 * ARC_TOLERANCE) / Math.max(radius, 1e-9));
    const steps = Math.min(64, Math.max(4, Math.ceil(Math.abs(sweep) / maxStep)));
    const from = rounded.length;
    for (let step = 0; step <= steps; step++) {
      const angle = startAngle + (sweep * step) / steps;
      rounded.push({
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      });
    }
    arcs.push({
      centerX: center.x,
      centerY: center.y,
      radius,
      start: startAngle,
      sweep,
      from,
      to: rounded.length - 1,
    });
  }
  rounded.push(points[points.length - 1]!);
  return { points: rounded, arcs };
}
