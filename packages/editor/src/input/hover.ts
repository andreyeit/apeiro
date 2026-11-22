import {
  boxContainsPoint,
  handleOfSigns,
  hitTestAudio,
  inflateBox,
  isShape,
  resizeCursor,
  type Vec2,
} from '@apeiro/core';
import { ROTATE_CURSOR } from '../overlay/handles';
import {
  ANCHOR_KEEP_PX,
  AUDIO_HIT_PX,
  ERASER_CURSOR,
  ERASER_PX,
  HIT_TOLERANCE_PX,
} from './constants';
import type { InputContext } from './context';
import { cropGrabAt, cropTarget } from './crop';
import {
  connectorHandleAt,
  countHandleAt,
  dotAt,
  radiusHandleAt,
  transformAt,
} from './hit-targets';

/** Cursor while no gesture runs and nothing in particular is under the pointer. */
export function idleCursor(context: InputContext): string {
  const { tools } = context;
  if (context.spaceDown || tools.tool === 'hand') return 'grab';
  const custom = tools.customTool();
  if (custom) return custom.cursor ?? 'crosshair';
  switch (tools.tool) {
    case 'text':
      return 'text';
    case 'eraser':
      return ERASER_CURSOR;
    case 'select':
      return '';
    default:
      return 'crosshair';
  }
}

/** Sets the overlay's hover state; redraws only when something changed. */
function setHover(context: InputContext, hover: string | null, anchorsFor: string | null): void {
  const { overlay } = context;
  if (overlay.hover === hover && overlay.anchorsFor === anchorsFor && !overlay.hoverDot) return;
  overlay.hover = hover;
  overlay.anchorsFor = anchorsFor;
  overlay.hoverDot = null;
  overlay.request();
}

/**
 * Pointer moving with no gesture: hover outlines, connection dots, handle highlights and
 * the cursor for whatever a press at `point` would grab.
 */
export function hover(context: InputContext, point: Vec2): void {
  const { overlay, scene, tools } = context;
  const world = context.world(point);

  const cropping = cropTarget(context);
  if (cropping) {
    // Crop mode: no connection dots or hover outlines, only the crop frame.
    if (overlay.anchorsFor || overlay.hoverDot || overlay.hover) setHover(context, null, null);
    const grab = cropGrabAt(context, cropping, world);
    context.setCursor(
      !grab
        ? idleCursor(context)
        : grab.action === 'pan'
          ? 'grab'
          : resizeCursor(handleOfSigns(grab.signs), cropping.rotation),
    );
    return;
  }

  // Drawing and placing tools don't point at elements: no hover outline, no dots.
  if (tools.tool !== 'select' && tools.tool !== 'connector' && tools.tool !== 'text') {
    const hit =
      tools.tool === 'eraser' ? scene.hitTest(world, context.pixelsToWorld(ERASER_PX)) : null;
    setHover(context, hit?.type === 'ink' ? hit.id : null, null);
    context.setCursor(idleCursor(context));
    return;
  }

  const onCount = countHandleAt(context, point) !== null;
  if (onCount !== overlay.countActive) {
    overlay.countActive = onCount;
    overlay.request();
  }
  if (onCount) {
    context.setCursor('pointer');
    return;
  }
  const onRadius = radiusHandleAt(context, point) !== null;
  if (onRadius !== overlay.radiusActive) {
    overlay.radiusActive = onRadius;
    overlay.request();
  }
  if (onRadius) {
    context.setCursor('pointer');
    return;
  }

  const transform = transformAt(context, world);
  if (transform) {
    const { hit, frame } = transform;
    context.setCursor(
      hit.kind === 'rotate' ? ROTATE_CURSOR : resizeCursor(hit.handle, frame.rotation),
    );
    if (overlay.anchorsFor || overlay.hoverDot) {
      context.clearDots();
      overlay.request();
    }
    return;
  }

  // A connection dot under the pointer wins over anything else: the shape keeps its dots
  // even if the pointer crosses a neighbour on the way to the dot.
  const dot = dotAt(context, point);
  if (dot) {
    if (overlay.hoverDot !== dot.anchor || overlay.hover !== dot.shape.id) {
      overlay.hoverDot = dot.anchor;
      overlay.hover = dot.shape.id;
      overlay.request();
    }
    context.setCursor('crosshair');
    return;
  }

  const handle = connectorHandleAt(context, point);
  const hit = scene.hitTest(world, context.pixelsToWorld(HIT_TOLERANCE_PX));
  const select = tools.tool === 'select';
  // A selected arrow is being worked on: no connection dots on the shapes around it.
  const arrowSelected = overlay.selectedConnector() !== null;
  let anchorsFor =
    hit &&
    isShape(hit) &&
    select &&
    !arrowSelected &&
    !context.overlay.selection.has(hit.id) && // selected: handles instead of connection dots
    context.showsDots(hit) &&
    !context.readOnly()
      ? hit.id
      : null;
  if (
    !anchorsFor &&
    !arrowSelected &&
    overlay.anchorsFor &&
    !overlay.selection.has(overlay.anchorsFor)
  ) {
    // Keep the dots while the pointer travels from the shape out to a dot.
    const bounds = scene.getBounds(overlay.anchorsFor);
    const keep = context.pixelsToWorld(ANCHOR_KEEP_PX);
    if (bounds && boxContainsPoint(inflateBox(bounds, keep), world))
      anchorsFor = overlay.anchorsFor;
  }
  setHover(context, hit?.id ?? null, anchorsFor);

  const onControl =
    hit &&
    isShape(hit) &&
    (hitTestAudio(hit, world, context.pixelsToWorld(AUDIO_HIT_PX)) ||
      (select && context.hooks.linkAt?.(hit.id, world)));
  context.setCursor(
    handle
      ? 'grab'
      : onControl
        ? 'pointer'
        : hit && select && !context.modifiers.deep && !context.readOnly() // Ctrl/⌘: the plain arrow
          ? 'move'
          : idleCursor(context),
  );
}
