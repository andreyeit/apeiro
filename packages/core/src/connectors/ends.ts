import type { ShapeElement } from '../elements/element';
import {
  closestOutlinePoint,
  hasCustomOutline,
  outlineAlongRay,
  shapeSdf,
} from '../elements/shape-geometry';
import { boxCenter, localToWorld, worldToLocal } from '../geometry/frame';
import { normalize, rotateVector, type Vec2 } from '../geometry/vector';
import {
  anchorBoxPoint,
  anchorLocal,
  outlineNormalAt,
  outlinePoint,
  sideNormal,
  snapToAxis,
  type ResolvedEnd,
} from './local-geometry';
import type { ConnectorElement, ConnectorEnd, ConnectorRoute } from './types';

// Where a connector's ends are: on a shape's outline (floating or at an anchor), at a
// free point, moved clear of the shape's border.

type ShapeLookup = (id: string) => ShapeElement | undefined;

/** Halvings of the search for a border's outer edge (see `caplessDistance`). */
const BISECTION_STEPS = 16;

/** The point the other end aims at: a free point, an anchor's box point or the shape center. */
function referencePoint(end: ConnectorEnd, getShape: ShapeLookup): Vec2 | null {
  if (end.kind === 'point') return { x: end.x, y: end.y };
  const shape = getShape(end.id);
  if (!shape) return null;
  return end.anchor ? localToWorld(shape, anchorBoxPoint(shape, end.anchor)) : boxCenter(shape);
}

export const isFloating = (end: ConnectorEnd): boolean => end.kind === 'element' && !end.anchor;

/** Where an end sits and which way it leaves, aiming at `toward` when it floats. */
export function resolveEnd(
  end: ConnectorEnd,
  toward: Vec2,
  route: ConnectorRoute,
  getShape: ShapeLookup,
): ResolvedEnd | null {
  if (end.kind === 'point') return { point: { x: end.x, y: end.y }, normal: null };
  const shape = getShape(end.id);
  if (!shape) return null;
  const resolved = (local: Vec2, normal: Vec2): ResolvedEnd => ({
    point: localToWorld(shape, local),
    normal: rotateVector(normal, shape.rotation),
  });
  if (end.anchor) {
    const local = anchorLocal(shape, end.anchor);
    return resolved(
      local,
      route === 'elbow' ? sideNormal(shape, local) : outlineNormalAt(shape, local),
    );
  }
  const direction = worldToLocal(shape, toward);
  if (route === 'elbow') {
    // Orthogonal routes leave from the middle of the side facing the other end
    // (for polygons: where the outline crosses the line to that side's middle).
    const normal = sideNormal(shape, direction);
    const middle = { x: (normal.x * shape.width) / 2, y: (normal.y * shape.height) / 2 };
    return resolved(shape.type === 'polygon' ? outlineAlongRay(shape, middle) : middle, normal);
  }
  const local = outlinePoint(shape, normalize(direction));
  // A plain box faces the other end straight from its center.
  const plainBox = shape.type !== 'ellipse' && !hasCustomOutline(shape);
  return resolved(local, plainBox ? normalize(local) : outlineNormalAt(shape, local));
}

/** Point on a shape's (unrotated) outline at the given side, moved along that side to `along`. */
function sidePointAt(shape: ShapeElement, normal: Vec2, along: number): Vec2 {
  const centerX = shape.x + shape.width / 2;
  const centerY = shape.y + shape.height / 2;
  const halfWidth = shape.width / 2;
  const halfHeight = shape.height / 2;
  let point: Vec2;
  if (normal.x !== 0) {
    const fraction = (along - centerY) / halfHeight;
    const reach =
      shape.type === 'ellipse'
        ? halfWidth * Math.sqrt(Math.max(0, 1 - fraction * fraction))
        : halfWidth;
    point = { x: centerX + normal.x * reach, y: along };
  } else {
    const fraction = (along - centerX) / halfWidth;
    const reach =
      shape.type === 'ellipse'
        ? halfHeight * Math.sqrt(Math.max(0, 1 - fraction * fraction))
        : halfHeight;
    point = { x: along, y: centerY + normal.y * reach };
  }
  if (shape.type === 'ellipse' || !hasCustomOutline(shape)) return point;
  // Rounded corners: the box side point may be off the outline near the corner.
  const closest = closestOutlinePoint(shape, { x: point.x - centerX, y: point.y - centerY });
  return { x: centerX + closest.x, y: centerY + closest.y };
}

/**
 * Elbow lines between two floating ends on facing sides: if the sides overlap,
 * attach both at the middle of the overlap so the line is straight instead of
 * making a tiny Z-step (what Miro does). Only for unrotated shapes.
 */
function alignFacingEnds(
  connector: ConnectorElement,
  start: ResolvedEnd,
  end: ResolvedEnd,
  getShape: ShapeLookup,
): void {
  if (!isFloating(connector.start) || !isFloating(connector.end)) return;
  if (connector.start.kind !== 'element' || connector.end.kind !== 'element') return;
  const startShape = getShape(connector.start.id);
  const endShape = getShape(connector.end.id);
  if (
    !startShape ||
    !endShape ||
    startShape.rotation !== 0 ||
    endShape.rotation !== 0 ||
    !start.normal ||
    !end.normal
  )
    return;
  if (startShape.type === 'polygon' || endShape.type === 'polygon') return; // sides aren't the box sides
  const startNormal = snapToAxis(start.normal);
  const endNormal = snapToAxis(end.normal);
  if (startNormal.x + endNormal.x !== 0 || startNormal.y + endNormal.y !== 0) return; // not facing each other
  const horizontal = startNormal.x !== 0;
  const low = horizontal ? Math.max(startShape.y, endShape.y) : Math.max(startShape.x, endShape.x);
  const high = horizontal
    ? Math.min(startShape.y + startShape.height, endShape.y + endShape.height)
    : Math.min(startShape.x + startShape.width, endShape.x + endShape.width);
  if (high - low < 1) return;
  const middle = (low + high) / 2;
  start.point = sidePointAt(startShape, startNormal, middle);
  end.point = sidePointAt(endShape, endNormal, middle);
}

/** Both ends of a connector, clear of the borders; null if an attached shape is missing. */
export function resolveEnds(
  connector: ConnectorElement,
  getShape: ShapeLookup,
): [ResolvedEnd, ResolvedEnd] | null {
  const startReference = referencePoint(connector.start, getShape);
  const endReference = referencePoint(connector.end, getShape);
  if (!startReference || !endReference) return null;
  const start = resolveEnd(connector.start, endReference, connector.route, getShape);
  const end = resolveEnd(connector.end, startReference, connector.route, getShape);
  if (!start || !end) return null;
  if (connector.route === 'elbow') alignFacingEnds(connector, start, end, getShape);
  return [
    clearBorder(connector, connector.start, start, getShape),
    clearBorder(connector, connector.end, end, getShape),
  ];
}

/**
 * How far out along `normal` (from the outline point `local`, shape-local) a capless line of
 * half width `half` ends, so that it joins a border of half width `border` with no notches.
 * On a flat side its end sits on the border's outer edge (further out when the border is
 * thinner than the rounded end is long, so it doesn't reach into the fill). Where the outline
 * falls away across the line's width — a corner of a polygon, a curve — the outer edge is
 * deeper there, and the line goes in by that much more, so its whole width meets the border.
 */
function caplessDistance(
  shape: ShapeElement,
  local: Vec2,
  normal: Vec2,
  border: number,
  half: number,
): number {
  const flat = Math.max(border, half - border);
  const side = { x: -normal.y, y: normal.x };
  const reach = Math.max(shape.width, shape.height) + border + half;
  // Along the normal, at `lateral` across the line: where the border's outer edge is (the
  // outline is the middle of the border), or null if the line passes beside the shape there.
  const outerEdgeAt = (lateral: number): number | null => {
    const outside = (along: number) =>
      shapeSdf(shape, {
        x: local.x + normal.x * along + side.x * lateral,
        y: local.y + normal.y * along + side.y * lateral,
      }) > border;
    let high = border + half + Math.abs(lateral) + 1;
    if (!outside(high)) return null;
    // The first point inside going in: further on the line may leave the shape again (it
    // crosses a corner of a polygon and comes out of its far side).
    const step = Math.max(half, border, 1e-3) / 4;
    let low = Number.NaN;
    for (let along = border; along >= -reach; along -= step) {
      if (!outside(along)) {
        low = along;
        break;
      }
      high = along;
    }
    if (Number.isNaN(low)) return null;
    // The bracket is one step wide: 16 halvings place the edge within a 65536th of a step.
    for (let iteration = 0; iteration < BISECTION_STEPS; iteration++) {
      const middle = (low + high) / 2;
      if (outside(middle)) high = middle;
      else low = middle;
    }
    return high;
  };
  let deepest = border;
  for (const share of [-1, -0.5, 0, 0.5, 1]) {
    const edge = outerEdgeAt(share * half);
    if (edge !== null && edge < deepest) deepest = edge;
  }
  return flat - (border - deepest);
}

/**
 * Moves an attached end out of the shape, as in Miro: the line (and its arrow tip) stops
 * against the outer edge of the shape's border instead of running into it. The outline
 * point is the middle of the border, so the end moves out by half the border plus half
 * the line's own width (its rounded end reaches that far past the point).
 *
 * An end without a cap joins the border instead: the line's full width reaches the outer
 * edge of the border (a rounded end only touching it would leave a notch on each side), and
 * its rounded end goes into the border, at most to its inner edge, never into the fill.
 */
export function clearBorder(
  connector: ConnectorElement,
  end: ConnectorEnd,
  resolved: ResolvedEnd,
  getShape: ShapeLookup,
): ResolvedEnd {
  if (end.kind !== 'element') return resolved;
  const shape = getShape(end.id);
  if (!shape) return resolved;
  const border = shape.strokeWidth / 2;
  const half = connector.strokeWidth / 2;
  const cap = end === connector.start ? connector.startCap : connector.endCap;
  // Straight out of the border at that point (a side of a box, the normal of a curve).
  const local = worldToLocal(shape, resolved.point);
  const normal = outlineNormalAt(shape, local);
  const distance =
    cap === 'none' ? caplessDistance(shape, local, normal, border, half) : border + half;
  if (!(distance > 0)) return resolved;
  const outward = rotateVector(normal, shape.rotation);
  return {
    point: {
      x: resolved.point.x + outward.x * distance,
      y: resolved.point.y + outward.y * distance,
    },
    normal: resolved.normal,
  };
}
