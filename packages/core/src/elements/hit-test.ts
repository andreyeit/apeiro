import { worldToLocal } from '../geometry/frame';
import type { Vec2 } from '../geometry/vector';
import type { ShapeElement } from './element';
import { inkDistance } from './ink';
import { shapeSdf } from './shape-geometry';

/**
 * Precise point-in-element test in world space.
 * `tolerance` (world units) expands the shape, so thin or tiny elements stay clickable
 * when zoomed out. Callers usually pass `screenTolerancePx / camera.zoom`.
 */
export function hitTestElement(element: ShapeElement, point: Vec2, tolerance = 0): boolean {
  // A pen stroke is hit near its line, not anywhere in its box.
  if (element.type === 'ink')
    return inkDistance(element, point) <= element.strokeWidth / 2 + tolerance;
  const local = worldToLocal(element, point);
  const reach = element.strokeWidth / 2 + tolerance;
  if (element.type === 'ellipse') {
    // Exact for the grown ellipse (the distance approximation is only good near the outline).
    const radiusX = element.width / 2 + reach;
    const radiusY = element.height / 2 + reach;
    if (radiusX <= 0 || radiusY <= 0) return false;
    return (
      (local.x * local.x) / (radiusX * radiusX) + (local.y * local.y) / (radiusY * radiusY) <= 1
    );
  }
  // The same distance the fragment shader draws with, so hits match pixels.
  return shapeSdf(element, local) <= reach;
}
