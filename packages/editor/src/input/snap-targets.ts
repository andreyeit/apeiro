import { boxUnion, elementBounds, inflateBox, isShape, type Box } from '@apeiro/core';
import { MAX_SNAP_TARGETS } from './constants';
import type { InputContext } from './context';

/** Box of an element for snapping: its geometry, without the stroke (like Figma). */
function geometryBox(context: InputContext, id: string): Box | null {
  const element = context.scene.get(id);
  if (!element) return null;
  return isShape(element)
    ? elementBounds({ ...element, strokeWidth: 0 })
    : (context.scene.getBounds(id) ?? null);
}

/** Box of the elements being moved. */
export function snapBoxOf(context: InputContext, ids: Iterable<string>): Box | null {
  let union: Box | null = null;
  for (const id of ids) {
    const bounds = geometryBox(context, id);
    if (bounds) union = union ? boxUnion(union, bounds) : bounds;
  }
  return union;
}

/**
 * Shapes on and around the screen to snap to (not the moving ones, nor connectors, whose
 * attached ends move along). Taken once per gesture: the others don't move meanwhile.
 */
export function snapTargets(context: InputContext, moving: ReadonlySet<string>): Box[] {
  const view = context.camera.viewportBounds();
  // The view and as much again on every side.
  const area = inflateBox(view, view.maxX - view.minX, view.maxY - view.minY);
  const targets: Box[] = [];
  for (const element of context.scene.queryBox(area)) {
    if (moving.has(element.id) || !isShape(element)) continue;
    const bounds = geometryBox(context, element.id);
    if (bounds) targets.push(bounds);
    if (targets.length >= MAX_SNAP_TARGETS) break;
  }
  return targets;
}
