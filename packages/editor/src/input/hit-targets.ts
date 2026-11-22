import {
  radiusCorner,
  SIDE_MIDPOINTS,
  worldToLocal,
  type Frame,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';
import {
  anchorDot,
  handleScale,
  countHandlePoint,
  HANDLE_RADIUS_PX,
  radiusHandlePoint,
  radiusHandleShape,
  selectionEdgeFrame,
  selectionFrame,
  transformHandleAt,
  type TransformHit,
} from '../overlay/handles';
import { DOT_HIT_PX, HANDLE_HIT_PX } from './constants';
import type { InputContext } from './context';

// What a pointer at a screen point would grab: the handles drawn by the overlay. Each
// returns null when the handle is not shown (another tool, a read-only board…).

/** Handles of the selection are live only with the select tool on an editable board. */
const handlesLive = (context: InputContext): boolean =>
  context.tools.tool === 'select' && !context.readOnly();

/** Transform frame of the selection and the part of it under a world point. */
export function transformAt(
  context: InputContext,
  world: Vec2,
): { frame: Frame; hit: TransformHit } | null {
  if (!handlesLive(context)) return null;
  const frame = selectionFrame(context.scene, context.overlay.selection);
  const edge = selectionEdgeFrame(context.scene, context.overlay.selection);
  if (!frame || !edge) return null;
  // Grabbed where the handles are drawn (the outer edge); resized as geometry.
  const hit = transformHandleAt(edge, world, context.camera.zoom);
  return hit ? { frame, hit } : null;
}

/** The shape whose radius handle (top-left corner, a polygon's top vertex) is under `point`. */
export function radiusHandleAt(context: InputContext, point: Vec2): ShapeElement | null {
  if (!handlesLive(context)) return null;
  const shape = radiusHandleShape(context.scene, context.overlay.selection, context.camera.zoom);
  if (!shape) return null;
  const distance = context.screenDistance(point, radiusHandlePoint(shape, context.camera.zoom));
  return distance <= (HANDLE_RADIUS_PX + 5) * handleScale(context.camera.zoom) ? shape : null;
}

/** The polygon whose corner-count handle is under screen point `point`. */
export function countHandleAt(context: InputContext, point: Vec2): ShapeElement | null {
  if (!handlesLive(context)) return null;
  const shape = radiusHandleShape(context.scene, context.overlay.selection, context.camera.zoom);
  if (!shape || shape.type !== 'polygon') return null;
  const distance = context.screenDistance(point, countHandlePoint(shape, context.camera.zoom));
  return distance <= (HANDLE_RADIUS_PX + 5) * handleScale(context.camera.zoom) ? shape : null;
}

/** How far a world point is from the rounded corner, measured along its bisector (local units). */
export function alongBisector(shape: ShapeElement, world: Vec2): number {
  const corner = radiusCorner(shape);
  const local = worldToLocal(shape, world);
  return (
    (local.x - corner.vertex.x) * corner.inward.x + (local.y - corner.vertex.y) * corner.inward.y
  );
}

/** Connection dot of the shape whose dots are shown, under screen point `point`. */
export function dotAt(
  context: InputContext,
  point: Vec2,
): { shape: ShapeElement; anchor: Vec2 } | null {
  if (!handlesLive(context) || !context.overlay.anchorsFor) return null;
  if (context.isLocked(context.overlay.anchorsFor)) return null;
  if (context.overlay.selection.has(context.overlay.anchorsFor)) return null; // no dots on a selected element
  const shape = context.getShape(context.overlay.anchorsFor);
  if (!shape || !context.showsDots(shape)) return null;
  let best: { shape: ShapeElement; anchor: Vec2 } | null = null;
  let bestDistance = DOT_HIT_PX * handleScale(context.camera.zoom);
  for (const anchor of SIDE_MIDPOINTS) {
    const distance = context.screenDistance(point, anchorDot(shape, anchor, context.camera.zoom));
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = { shape, anchor };
    }
  }
  return best;
}

export type ConnectorHandleHit = { kind: 'end'; which: 'start' | 'end' } | { kind: 'bend' };

/** End or bend handle of the selected connector under screen point `point`. */
export function connectorHandleAt(
  context: InputContext,
  point: Vec2,
): { id: string; hit: ConnectorHandleHit } | null {
  if (context.readOnly()) return null;
  const id = context.overlay.selectedConnector();
  const geometry = id ? context.scene.connectorGeometry(id) : null;
  if (!id || !geometry) return null;
  const reach = HANDLE_HIT_PX * handleScale(context.camera.zoom);
  if (context.screenDistance(point, geometry.points[0]!) <= reach)
    return { id, hit: { kind: 'end', which: 'start' } };
  if (context.screenDistance(point, geometry.points[geometry.points.length - 1]!) <= reach)
    return { id, hit: { kind: 'end', which: 'end' } };
  if (geometry.handle && context.screenDistance(point, geometry.handle.point) <= reach)
    return { id, hit: { kind: 'bend' } };
  return null;
}
