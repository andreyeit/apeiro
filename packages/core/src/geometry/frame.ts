import type { Box } from './box';
import type { Vec2 } from './vector';

/**
 * Oriented boxes. A shape is stored as its unrotated box (top-left corner and size) plus a
 * rotation around the box center; a `Frame` describes the same thing by its center. Local
 * coordinates are centered on the box and unrotated.
 */

/** A box rotated around its center: what every shape is. */
export interface RotatedBox {
  /** Top-left corner of the unrotated box. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Radians, around the center. */
  rotation: number;
}

/** An oriented box: center, size, rotation (radians, around the center). */
export interface Frame {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotation: number;
}

export const boxCenter = (box: RotatedBox): Vec2 => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/** Local point (centered on the box, unrotated) → world. */
export function localToWorld(box: RotatedBox, local: Vec2): Vec2 {
  const cosine = Math.cos(box.rotation);
  const sine = Math.sin(box.rotation);
  return {
    x: box.x + box.width / 2 + local.x * cosine - local.y * sine,
    y: box.y + box.height / 2 + local.x * sine + local.y * cosine,
  };
}

/** World point → local (centered on the box, unrotated). */
export function worldToLocal(box: RotatedBox, world: Vec2): Vec2 {
  const cosine = Math.cos(-box.rotation);
  const sine = Math.sin(-box.rotation);
  const deltaX = world.x - (box.x + box.width / 2);
  const deltaY = world.y - (box.y + box.height / 2);
  return { x: deltaX * cosine - deltaY * sine, y: deltaX * sine + deltaY * cosine };
}

/** The frame of one shape: its own box and rotation. */
export function shapeFrame(box: RotatedBox): Frame {
  return {
    centerX: box.x + box.width / 2,
    centerY: box.y + box.height / 2,
    width: box.width,
    height: box.height,
    rotation: box.rotation,
  };
}

/** An axis-aligned frame, e.g. around a multi-selection. */
export function boxFrame(bounds: Box): Frame {
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    rotation: 0,
  };
}

/** Frame-local point (centered, unrotated) → world. */
export function frameToWorld(frame: Frame, point: Vec2): Vec2 {
  const cosine = Math.cos(frame.rotation);
  const sine = Math.sin(frame.rotation);
  return {
    x: frame.centerX + point.x * cosine - point.y * sine,
    y: frame.centerY + point.x * sine + point.y * cosine,
  };
}

/** World point → frame-local (centered, unrotated). */
export function worldToFrame(frame: Frame, point: Vec2): Vec2 {
  const cosine = Math.cos(-frame.rotation);
  const sine = Math.sin(-frame.rotation);
  const deltaX = point.x - frame.centerX;
  const deltaY = point.y - frame.centerY;
  return { x: deltaX * cosine - deltaY * sine, y: deltaX * sine + deltaY * cosine };
}
