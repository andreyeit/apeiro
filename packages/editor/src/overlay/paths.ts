import {
  capSize,
  effectiveRadius,
  midpoint,
  polygonSides,
  polygonVertices,
  rotateVector,
  type CapKind,
  type ConnectorArc,
  type ConnectorGeometry,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';

// Canvas 2D paths of board elements, shaped as the GPU renderer draws them, for the overlay
// to outline (selection, hover) and cut out (connector halos).

/**
 * Fills or strokes an arrowhead with the current composite operation, shaped as the board
 * draws it (see the line shader): `tip` is the line's end, `direction` points outwards,
 * `strokeWidth` is the line's, `tuck` how much narrower to stroke an open arrow (see the halo).
 */
export function traceCap(
  context: CanvasRenderingContext2D,
  kind: CapKind,
  tip: Vec2,
  direction: Vec2,
  strokeWidth: number,
  tuck: number,
): void {
  if (kind === 'none') return;
  const size = capSize(strokeWidth);
  // `along`: from the tip back along the line, `across`: across it.
  const at = (along: number, across: number) => ({
    x: tip.x - direction.x * along - direction.y * across,
    y: tip.y - direction.y * along + direction.x * across,
  });
  const polygon = (points: Vec2[]) => {
    context.beginPath();
    context.moveTo(points[0]!.x, points[0]!.y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  };
  if (kind === 'arrow') {
    polygon([at(size, size / 2), tip, at(size, -size / 2)]);
    context.lineWidth = strokeWidth - tuck;
    context.stroke();
    return;
  }
  if (kind === 'circle') {
    const center = at(size / 2, 0);
    context.beginPath();
    context.arc(center.x, center.y, size / 2, 0, Math.PI * 2);
  } else if (kind === 'triangle') {
    polygon([tip, at(size, size / 2), at(size, -size / 2)]);
  } else {
    polygon([tip, at(size / 2, size * 0.35), at(size, 0), at(size / 2, -size * 0.35)]);
  }
  context.closePath();
  context.fill();
}

/**
 * Adds a connector's line to the path (a subpath of its own) as the board draws it: straight pieces through its
 * points, rounded elbow bends as exact arcs (`points` only approximates them).
 */
export function traceConnector(
  context: CanvasRenderingContext2D,
  geometry: ConnectorGeometry,
): void {
  const arcAt = new Map<number, ConnectorArc>();
  for (const arc of geometry.arcs ?? []) arcAt.set(arc.from, arc);
  const points = geometry.points;
  context.moveTo(points[0]!.x, points[0]!.y);
  for (let index = 0; index + 1 < points.length;) {
    const arc = arcAt.get(index);
    if (arc) {
      context.arc(
        arc.centerX,
        arc.centerY,
        arc.radius,
        arc.start,
        arc.start + arc.sweep,
        arc.sweep < 0,
      );
      index = arc.to;
    } else {
      index++;
      context.lineTo(points[index]!.x, points[index]!.y);
    }
  }
}

/**
 * A convex polygon (around the origin) with every side moved `distance` outwards: each
 * corner where its two moved sides meet.
 */
function growPolygon(vertices: readonly Vec2[], distance: number): Vec2[] {
  if (distance === 0) return [...vertices];
  const count = vertices.length;
  const normal = (from: Vec2, to: Vec2) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const normalX = (to.y - from.y) / length;
    const normalY = -(to.x - from.x) / length;
    // Away from the center, whichever way the vertices turn.
    return normalX * (from.x + to.x) + normalY * (from.y + to.y) >= 0
      ? { x: normalX, y: normalY }
      : { x: -normalX, y: -normalY };
  };
  return vertices.map((point, index) => {
    const before = normal(vertices[(index + count - 1) % count]!, point);
    const after = normal(point, vertices[(index + 1) % count]!);
    const miter = distance / (1 + before.x * after.x + before.y * after.y || 1);
    return { x: point.x + (before.x + after.x) * miter, y: point.y + (before.y + after.y) * miter };
  });
}

/**
 * Adds the shape's outline (rounded corners, polygon, ellipse) to the path, in its local
 * coordinates (centered, unrotated), grown by `grow` on every side.
 */
export function traceShape(context: CanvasRenderingContext2D, shape: ShapeElement, grow = 0): void {
  const halfWidth = shape.width / 2 + grow;
  const halfHeight = shape.height / 2 + grow;
  if (shape.type === 'ellipse') {
    context.moveTo(halfWidth, 0); // a subpath of its own, not joined to the previous one
    context.ellipse(0, 0, halfWidth, halfHeight, 0, 0, Math.PI * 2);
    return;
  }
  const radius = effectiveRadius(shape);
  if (shape.type === 'polygon') {
    const vertices = growPolygon(
      polygonVertices(shape.width, shape.height, polygonSides(shape)),
      grow,
    );
    const count = vertices.length;
    // Tangent arcs at every corner: the same rounding the shader draws (grown with the sides).
    const start = midpoint(vertices[count - 1]!, vertices[0]!);
    context.moveTo(start.x, start.y);
    for (let index = 0; index < count; index++) {
      const point = vertices[index]!;
      const next = vertices[(index + 1) % count]!;
      context.arcTo(point.x, point.y, next.x, next.y, radius > 0 ? radius + grow : 0);
    }
    context.closePath();
    return;
  }
  if (radius > 0)
    context.roundRect(-halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2, radius + grow);
  else context.rect(-halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2);
}

/**
 * Adds the shape's box, grown by `grow` on every side, to the path in world coordinates
 * (rotated with the shape): a cheap outline for shapes too small on screen to show theirs.
 */
export function traceBox(context: CanvasRenderingContext2D, shape: ShapeElement, grow: number) {
  const left = shape.x - grow;
  const top = shape.y - grow;
  const width = shape.width + grow * 2;
  const height = shape.height + grow * 2;
  if (shape.rotation === 0) {
    context.rect(left, top, width, height);
    return;
  }
  const center = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
  const corner = (x: number, y: number) => {
    const turned = rotateVector({ x: x - center.x, y: y - center.y }, shape.rotation);
    return { x: center.x + turned.x, y: center.y + turned.y };
  };
  const corners = [
    corner(left, top),
    corner(left + width, top),
    corner(left + width, top + height),
    corner(left, top + height),
  ];
  context.moveTo(corners[0]!.x, corners[0]!.y);
  for (const point of corners.slice(1)) context.lineTo(point.x, point.y);
  context.closePath();
}
