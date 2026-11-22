import type { ShapeElement } from '../elements/element';
import {
  closestOutlinePoint,
  hasCustomOutline,
  outlineAlongRay,
  outlineNormal,
} from '../elements/shape-geometry';
import { normalize, type Vec2 } from '../geometry/vector';

// Shape-local geometry shared by the connector modules: points in a shape's centered,
// unrotated frame (see `geometry/frame.ts`), and where rays and sides meet its outline.

/** How far an elbow runs straight out of a shape before its first bend (world units). */
export const ELBOW_STUB = 24;

export interface ResolvedEnd {
  point: Vec2;
  /** Outward direction at the attachment, or null for a free point. */
  normal: Vec2 | null;
}

/** A direction snapped to the closest axis (ties go to x). */
export function snapToAxis(vector: Vec2): Vec2 {
  return Math.abs(vector.x) >= Math.abs(vector.y)
    ? { x: Math.sign(vector.x) || 1, y: 0 }
    : { x: 0, y: Math.sign(vector.y) || 1 };
}

/** Outward normal of the closest box side to a local point, snapped to an axis. */
export function sideNormal(shape: ShapeElement, local: Vec2): Vec2 {
  return snapToAxis({
    x: local.x / Math.max(shape.width / 2, 1e-6),
    y: local.y / Math.max(shape.height / 2, 1e-6),
  });
}

/**
 * Outward normal of the outline at a local point on it: the gradient for an ellipse, the
 * distance gradient of a rounded or polygonal outline, otherwise the side's normal.
 */
export function outlineNormalAt(shape: ShapeElement, local: Vec2): Vec2 {
  if (shape.type === 'ellipse')
    return normalize({
      x: local.x / (shape.width * shape.width || 1),
      y: local.y / (shape.height * shape.height || 1),
    });
  return hasCustomOutline(shape) ? outlineNormal(shape, local) : sideNormal(shape, local);
}

/** Where a ray from the shape center along local `direction` leaves its outline (local coords). */
export function outlinePoint(shape: ShapeElement, direction: Vec2): Vec2 {
  if (hasCustomOutline(shape)) return outlineAlongRay(shape, direction);
  const halfWidth = shape.width / 2;
  const halfHeight = shape.height / 2;
  let fraction: number;
  if (shape.type === 'ellipse') {
    fraction =
      1 /
      Math.sqrt(
        (direction.x * direction.x) / (halfWidth * halfWidth || 1e-9) +
          (direction.y * direction.y) / (halfHeight * halfHeight || 1e-9),
      );
  } else {
    fraction = Math.min(
      Math.abs(direction.x) > 1e-9 ? halfWidth / Math.abs(direction.x) : Infinity,
      Math.abs(direction.y) > 1e-9 ? halfHeight / Math.abs(direction.y) : Infinity,
    );
  }
  return { x: direction.x * fraction, y: direction.y * fraction };
}

/** Local point of an anchor's box position, before it is pulled onto the outline. */
export const anchorBoxPoint = (shape: ShapeElement, anchor: Vec2): Vec2 => ({
  x: (anchor.x - 0.5) * shape.width,
  y: (anchor.y - 0.5) * shape.height,
});

/**
 * Local point of an anchor. On a rounded or polygonal outline a box point (e.g. the
 * middle of a triangle's left side, or a rounded-off corner) may lie outside the shape:
 * it is pulled along the ray from the center onto the outline.
 */
export function anchorLocal(shape: ShapeElement, anchor: Vec2): Vec2 {
  const local = anchorBoxPoint(shape, anchor);
  if (!hasCustomOutline(shape) || Math.hypot(local.x, local.y) < 1e-9) return local;
  return outlineAlongRay(shape, local);
}

/** Closest point on the (local, unrotated) outline. Radial for ellipses. */
export function projectToOutline(shape: ShapeElement, local: Vec2): Vec2 {
  if (hasCustomOutline(shape)) return closestOutlinePoint(shape, local);
  if (shape.type === 'ellipse') return outlinePoint(shape, normalize(local));
  const halfWidth = shape.width / 2;
  const halfHeight = shape.height / 2;
  const clampedX = Math.max(-halfWidth, Math.min(halfWidth, local.x));
  const clampedY = Math.max(-halfHeight, Math.min(halfHeight, local.y));
  // Outside the box, clamping lands on the outline (an edge or a corner).
  if (clampedX !== local.x || clampedY !== local.y) return { x: clampedX, y: clampedY };
  // Inside: push to the nearest side.
  return halfWidth - Math.abs(local.x) < halfHeight - Math.abs(local.y)
    ? { x: Math.sign(local.x || 1) * halfWidth, y: local.y }
    : { x: local.x, y: Math.sign(local.y || 1) * halfHeight };
}
