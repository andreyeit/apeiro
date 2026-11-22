import {
  anchorPoint,
  boxFrame,
  CORNER_HANDLES,
  HANDLE_SIGNS,
  hasCornerRadius,
  isShape,
  localToWorld,
  MAX_POLYGON_SIDES,
  MIN_POLYGON_SIDES,
  polygonSides,
  polygonVertices,
  radiusHandleLocal,
  rotateVector,
  shapeFrame,
  worldToFrame,
  worldToLocal,
  type Frame,
  type ResizeHandle,
  type Scene,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';

// Where the selection's handles are, in world space, and which one a point grabs. Shared
// by the overlay (which draws them) and the input controls (which hit-test them).

/** Connection dots sit this far outside the shape (screen px) so they don't fight with dragging. */
export const ANCHOR_DOT_OFFSET_PX = 10;
/**
 * Radius of every round handle at full size (screen px): frame corners, line ends and
 * bends, the corner-radius handle, connection dots and magnets. One size for all of them.
 */
export const HANDLE_RADIUS_PX = 5;
/** Radius of an active handle: the hovered connection dot, the magnet a line attaches to. */
export const HANDLE_ACTIVE_RADIUS_PX = 7;
/** From this zoom up handles have their full size; below it they shrink with the zoom. */
export const HANDLE_FULL_SIZE_ZOOM = 0.5;
/** Handles never shrink below this share of their size. */
export const HANDLE_MIN_SCALE = 0.35;

/**
 * Size of all handles at this zoom, as a share of their full size: every handle, its
 * offset and its grab radius use the same factor, so they all look alike at any zoom.
 * Zooming in they keep their screen size; zoomed far out they shrink, so they don't grow
 * over the elements.
 */
export function handleScale(zoom: number): number {
  return Math.min(1, Math.max(HANDLE_MIN_SCALE, zoom / HANDLE_FULL_SIZE_ZOOM));
}

/** Screen-space position of the connection dot for a side anchor. */
export function anchorDot(shape: ShapeElement, anchor: Vec2, zoom: number): Vec2 {
  const point = anchorPoint(shape, anchor);
  const local = { x: anchor.x - 0.5, y: anchor.y - 0.5 };
  const length = Math.hypot(local.x, local.y) || 1;
  const direction = rotateVector({ x: local.x / length, y: local.y / length }, shape.rotation);
  const offset = (ANCHOR_DOT_OFFSET_PX * handleScale(zoom)) / zoom;
  return { x: point.x + direction.x * offset, y: point.y + direction.y * offset };
}

/** Radius handle: never closer than this to the corner (screen px), so it's grabbable at 0. */
export const RADIUS_HANDLE_MIN_PX = 14;
/** Shapes smaller than this on screen get no radius handle (it would cover them). */
export const RADIUS_HANDLE_MIN_SHAPE_PX = 48;

/** World position of the corner-radius handle of a shape at this zoom. */
export function radiusHandlePoint(shape: ShapeElement, zoom: number): Vec2 {
  return localToWorld(
    shape,
    radiusHandleLocal(shape, (RADIUS_HANDLE_MIN_PX * handleScale(zoom)) / zoom),
  );
}

/** The corner-count handle of a polygon sits this far inside the middle of its first side (screen px). */
export const COUNT_HANDLE_INSET_PX = 16;

/**
 * World position of a polygon's corner-count handle: inside the middle of the side
 * between the top vertex and the next one, as Figma's count handle. Dragging it around
 * the center adds or removes corners.
 */
export function countHandlePoint(shape: ShapeElement, zoom: number): Vec2 {
  const vertices = polygonVertices(shape.width, shape.height, polygonSides(shape));
  const middle = {
    x: (vertices[0]!.x + vertices[1]!.x) / 2,
    y: (vertices[0]!.y + vertices[1]!.y) / 2,
  };
  const length = Math.hypot(middle.x, middle.y) || 1;
  const inset = Math.min((COUNT_HANDLE_INSET_PX * handleScale(zoom)) / zoom, length * 0.5);
  return localToWorld(shape, {
    x: middle.x - (middle.x / length) * inset,
    y: middle.y - (middle.y / length) * inset,
  });
}

/**
 * Corner count for a pointer dragged around a polygon's center: the count handle sits at
 * an angle of π / n from the top vertex (measured in the box stretched to a square), so
 * an angle θ means n = π / θ. Clamped to MIN_POLYGON_SIDES..MAX_POLYGON_SIDES.
 */
export function countAtAngle(shape: ShapeElement, world: Vec2): number {
  const local = worldToLocal(shape, world);
  const theta = Math.atan2(
    local.x / Math.max(shape.width / 2, 1e-6),
    -local.y / Math.max(shape.height / 2, 1e-6),
  );
  if (theta <= 0) return MAX_POLYGON_SIDES;
  return Math.min(MAX_POLYGON_SIDES, Math.max(MIN_POLYGON_SIDES, Math.round(Math.PI / theta)));
}

/** The shape that shows a radius handle: the single selected shape with corners, large enough on screen. */
export function radiusHandleShape(
  scene: Scene,
  selection: ReadonlySet<string>,
  zoom: number,
): ShapeElement | null {
  if (selection.size !== 1) return null;
  const element = scene.get(selection.values().next().value!);
  if (!element || !isShape(element) || !hasCornerRadius(element)) return null;
  return Math.min(element.width, element.height) * zoom >= RADIUS_HANDLE_MIN_SHAPE_PX
    ? element
    : null;
}

/**
 * Corner resize handles: drawn size (square handles of the crop frame, round ones of the
 * selection: their diameter) and grab radius, screen px.
 */
export const CORNER_HANDLE_PX = 2 * HANDLE_RADIUS_PX;
const CORNER_HIT_PX = 9;
/** Edges resize within this distance of the frame (screen px). */
const EDGE_HIT_PX = 6;
/** Just outside a corner, up to this far, the pointer rotates (screen px). */
const ROTATE_ZONE_PX = 24;

/**
 * Frame that transforms the selection: one shape gets its own rotated box, several
 * elements an axis-aligned box around them. A lone connector has its own handles instead.
 */
export function selectionFrame(scene: Scene, selection: ReadonlySet<string>): Frame | null {
  if (selection.size === 0) return null;
  if (selection.size === 1) {
    const element = scene.get(selection.values().next().value!);
    if (!element || !isShape(element)) return null;
    return shapeFrame(element);
  }
  const box = scene.bounds(selection);
  return box ? boxFrame(box) : null;
}

/**
 * The transform frame as drawn and grabbed: on the outer edge of what is selected. A lone
 * shape's frame (its geometric box, through the middle of its border) grows by half the
 * border; the bounds of several elements include their borders already. Resizing still
 * works on `selectionFrame`, the geometry.
 */
export function selectionEdgeFrame(scene: Scene, selection: ReadonlySet<string>): Frame | null {
  const frame = selectionFrame(scene, selection);
  if (!frame || selection.size !== 1) return frame;
  const element = scene.get(selection.values().next().value!);
  const border = element && isShape(element) ? element.strokeWidth : 0;
  return border > 0
    ? { ...frame, width: frame.width + border, height: frame.height + border }
    : frame;
}

export type TransformHit =
  | { kind: 'resize'; handle: ResizeHandle }
  | { kind: 'rotate'; corner: ResizeHandle };

/**
 * Which part of the transform frame is under world point `world` at this zoom. The grab
 * zones shrink with the handles when zoomed out (`handleScale`).
 */
export function transformHandleAt(frame: Frame, world: Vec2, zoom: number): TransformHit | null {
  const scale = handleScale(zoom);
  const cornerHit = CORNER_HIT_PX * scale;
  const edgeHit = EDGE_HIT_PX * scale;
  const local = worldToFrame(frame, world);
  const x = local.x * zoom; // screen px in the frame's axes
  const y = local.y * zoom;
  const halfWidth = (frame.width / 2) * zoom;
  const halfHeight = (frame.height / 2) * zoom;
  for (const handle of CORNER_HANDLES) {
    const [signX, signY] = HANDLE_SIGNS[handle];
    if (Math.hypot(x - signX * halfWidth, y - signY * halfHeight) <= cornerHit)
      return { kind: 'resize', handle };
  }
  // Edges, between the corner handles (skipped when the frame is too small on screen).
  if (halfWidth > cornerHit * 1.5 && Math.abs(x) <= halfWidth - cornerHit) {
    if (Math.abs(y + halfHeight) <= edgeHit) return { kind: 'resize', handle: 'n' };
    if (Math.abs(y - halfHeight) <= edgeHit) return { kind: 'resize', handle: 's' };
  }
  if (halfHeight > cornerHit * 1.5 && Math.abs(y) <= halfHeight - cornerHit) {
    if (Math.abs(x + halfWidth) <= edgeHit) return { kind: 'resize', handle: 'w' };
    if (Math.abs(x - halfWidth) <= edgeHit) return { kind: 'resize', handle: 'e' };
  }
  for (const corner of CORNER_HANDLES) {
    const [signX, signY] = HANDLE_SIGNS[corner];
    const out = { x: (x - signX * halfWidth) * signX, y: (y - signY * halfHeight) * signY }; // > 0: outside that side
    if ((out.x > 0 || out.y > 0) && out.x > -cornerHit && out.y > -cornerHit) {
      if (Math.hypot(Math.max(out.x, 0), Math.max(out.y, 0)) <= ROTATE_ZONE_PX * scale)
        return { kind: 'rotate', corner };
    }
  }
  return null;
}

/** A curved-arrow cursor for rotating (data URL SVG with a fallback). */
export const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<path d="M6 15a7 7 0 1 0 2-8.5" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M6 15a7 7 0 1 0 2-8.5" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M3.5 4.5 8.5 6.5 6 11z" fill="black" stroke="white" stroke-width="1"/></svg>',
)}") 12 12, alias`;
