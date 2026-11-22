import {
  audioSeekAt,
  audioVolumeAt,
  bendConnector,
  boxFromPoints,
  cropPan,
  cropResize,
  cropScale,
  expandToGroups,
  imageSize,
  isConnector,
  maxCornerRadius,
  polygonSides,
  radiusAfterDrag,
  rotateElements,
  snapAngle,
  worldToFrame,
  type ConnectorEnd,
  type Vec2,
} from '@apeiro/core';
import { countAtAngle, ROTATE_CURSOR } from '../overlay/handles';
import { CLICK_SLOP_PX, TEXTBOX_DRAG_PX } from './constants';
import type { InputContext } from './context';
import { updateDraggedEnd } from './connect';
import { alongBisector } from './hit-targets';
import { eraseAlong, extendInk } from './ink';
import type { ModeOf } from './modes';
import { dragStep, resizeStep, type SnapContext } from './transform-gestures';

const moveEnd = (end: ConnectorEnd, deltaX: number, deltaY: number): ConnectorEnd =>
  end.kind === 'point' ? { kind: 'point', x: end.x + deltaX, y: end.y + deltaY } : end;

const snapContext = (context: InputContext): SnapContext => ({
  zoom: context.camera.zoom,
  snapping: !!context.hooks.snapping,
  shift: context.modifiers.shift,
  alt: context.modifiers.alt,
  deep: context.modifiers.deep,
});

/** Moves the dragged elements with the pointer, snapping to smart guides and the grid. */
function drag(context: InputContext, mode: ModeOf<'drag'>, point: Vec2): void {
  if (!mode.moved && context.screenDistance(point, mode.start) >= CLICK_SLOP_PX) mode.moved = true;
  // Smart guides and the grid; Ctrl/⌘ held places freely.
  const step = dragStep(
    mode.start,
    context.world(point),
    mode.box,
    mode.targets,
    mode.moved,
    snapContext(context),
  );
  context.overlay.guides = step.guides;
  context.overlay.spacing = step.spacing;
  const { deltaX, deltaY } = step;
  context.scene.transact(() => {
    for (const [id, origin] of mode.origin) {
      // Attached connector ends follow their shapes by themselves; only free ends move.
      if (origin.kind === 'shape')
        context.scene.update(id, { x: origin.x + deltaX, y: origin.y + deltaY });
      else
        context.scene.update(id, {
          start: moveEnd(origin.start, deltaX, deltaY),
          end: moveEnd(origin.end, deltaX, deltaY),
        });
    }
  });
}

function crop(context: InputContext, mode: ModeOf<'crop'>, point: Vec2): void {
  const local = worldToFrame(mode.frame, context.world(point));
  const delta = { x: local.x - mode.start.x, y: local.y - mode.start.y };
  const size = imageSize(mode.original);
  const patch =
    mode.action === 'pan'
      ? cropPan(mode.original, size, delta)
      : mode.action === 'scale'
        ? cropScale(mode.original, size, mode.signs, delta)
        : cropResize(mode.original, size, mode.signs, delta, context.pixelsToWorld(4));
  context.scene.update(mode.original.id, patch);
}

function marquee(context: InputContext, mode: ModeOf<'marquee'>, point: Vec2): void {
  const box = boxFromPoints(mode.start, context.world(point));
  context.overlay.marquee = box;
  const next = new Set(mode.base);
  // Touching one element of a group selects the whole group; with Ctrl/⌘ (deep select)
  // only the elements touched.
  const hits = context.scene.queryBox(box, 'intersect').map((hit) => hit.id);
  for (const id of context.modifiers.deep ? hits : expandToGroups(context.scene, hits))
    if (!context.isLocked(id)) next.add(id);
  context.overlay.selection = next;
}

function radius(context: InputContext, mode: ModeOf<'radius'>, point: Vec2): void {
  const element = context.getShape(mode.id);
  if (!element) return;
  const along = alongBisector(element, context.world(point));
  const radius = radiusAfterDrag(element, mode.startRadius, along - mode.startAlong);
  // Whole units like Figma, but keep fractions on tiny shapes (zoomed in a lot).
  const rounded = maxCornerRadius(element) >= 20 ? Math.round(radius) : radius;
  if (rounded !== element.radius) context.scene.update(mode.id, { radius: rounded });
}

function count(context: InputContext, mode: ModeOf<'count'>, point: Vec2): void {
  const element = context.getShape(mode.id);
  if (!element) return;
  const sides = countAtAngle(element, context.world(point));
  context.overlay.countLabel = sides;
  if (sides !== polygonSides(element)) context.scene.update(mode.id, { sides });
}

function rotate(context: InputContext, mode: ModeOf<'rotate'>, point: Vec2): void {
  const world = context.world(point);
  let angle = Math.atan2(world.y - mode.center.y, world.x - mode.center.x) - mode.startAngle;
  if (context.modifiers.shift) angle = snapAngle(mode.base + angle, Math.PI / 12) - mode.base;
  context.applyPatches(rotateElements(mode.originals, mode.center, angle));
  const degrees = Math.round(((mode.base + angle) * 180) / Math.PI);
  context.overlay.badge = `${((degrees % 360) + 360) % 360}°`;
  context.setCursor(ROTATE_CURSOR);
}

/** Applies the current gesture for a pointer at screen `point`. */
export function moveGesture(context: InputContext, point: Vec2): void {
  const { mode, overlay } = context;
  switch (mode.kind) {
    case 'drag':
      drag(context, mode, point);
      break;
    case 'crop':
      crop(context, mode, point);
      break;
    case 'textbox': {
      // The width of the text box being drawn (its height follows the text).
      const dragged = Math.abs(point.x - mode.down.x) >= TEXTBOX_DRAG_PX;
      overlay.marquee = dragged ? boxFromPoints(mode.start, context.world(point)) : null;
      break;
    }
    case 'marquee':
      marquee(context, mode, point);
      break;
    case 'bend': {
      const connector = context.scene.get(mode.id);
      if (connector && isConnector(connector)) {
        const patch = bendConnector(connector, context.world(point), context.getShape);
        if (patch) context.scene.update(mode.id, patch);
      }
      break;
    }
    case 'seek': {
      const element = context.getShape(mode.id);
      if (element) context.hooks.audio?.seek(mode.id, audioSeekAt(element, context.world(point)));
      return;
    }
    case 'volume': {
      const element = context.getShape(mode.id);
      if (element)
        context.scene.update(mode.id, { volume: audioVolumeAt(element, context.world(point)) });
      return;
    }
    case 'radius':
      radius(context, mode, point);
      break;
    case 'count':
      count(context, mode, point);
      break;
    case 'resize': {
      const step = resizeStep(
        mode,
        worldToFrame(mode.frame, context.world(point)),
        snapContext(context),
        context.hooks.measurer,
      );
      overlay.guides = step.guides;
      overlay.badge = step.badge;
      context.applyPatches(step.patches);
      break;
    }
    case 'rotate':
      rotate(context, mode, point);
      break;
    case 'connect':
      updateDraggedEnd(context, mode, point);
      break;
    case 'place':
      overlay.marquee =
        context.screenDistance(point, mode.start) >= CLICK_SLOP_PX
          ? boxFromPoints(mode.start, context.world(point))
          : null;
      break;
    case 'ink':
      if (!extendInk(context, mode, [point])) return;
      break;
    case 'erase':
      eraseAlong(context, mode, point);
      break;
    default:
      return;
  }
  overlay.request();
}
