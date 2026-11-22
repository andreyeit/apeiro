import {
  canHoldText,
  effectiveRadius,
  HANDLE_SIGNS,
  hitTestAudio,
  isShape,
  polygonSides,
  shapeFrame,
  worldToFrame,
  type ConnectorElement,
  type ConnectorEnd,
  type Vec2,
} from '@apeiro/core';
import { selectionAfterPress } from '../selection/grouping';
import { isPlaceTool, type Tool } from '../tools/tool-state';
import { AUDIO_HIT_PX, HIT_TOLERANCE_PX } from './constants';
import type { InputContext } from './context';
import { cropGrabAt, cropTarget, stopCrop } from './crop';
import { eraseAt, startInk } from './ink';
import {
  alongBisector,
  connectorHandleAt,
  countHandleAt,
  dotAt,
  radiusHandleAt,
  transformAt,
} from './hit-targets';
import type { DragOrigin } from './modes';
import { snapBoxOf, snapTargets } from './snap-targets';

/** The press that starts a gesture: where (screen and world) and which modifiers were held. */
export interface Press {
  point: Vec2;
  world: Vec2;
  shift: boolean;
  /** Ctrl/⌘: deep select. */
  deep: boolean;
}

/**
 * Crop mode: a press on its frame's sides or the image starts a crop gesture (true); a
 * press elsewhere ends crop mode.
 */
export function pressCrop(context: InputContext, { world }: Press): boolean {
  const cropping = cropTarget(context);
  if (!cropping) {
    if (context.overlay.cropping) stopCrop(context); // the image is gone
    return false;
  }
  const grab = cropGrabAt(context, cropping, world);
  if (!grab) {
    stopCrop(context);
    return false;
  }
  const frame = shapeFrame(cropping);
  context.mode = {
    kind: 'crop',
    action: grab.action,
    signs: grab.signs,
    original: cropping,
    frame,
    start: worldToFrame(frame, world),
  };
  if (grab.action === 'pan') context.setCursor('grabbing');
  return true;
}

/** Tools that create (or erase) right where the press is, without selecting. True if handled. */
export function pressCreatingTool(
  context: InputContext,
  tool: Tool,
  { point, world }: Press,
): boolean {
  if (isPlaceTool(tool)) {
    context.mode = { kind: 'place', shape: tool, down: point, start: world };
  } else if (tool === 'pen') {
    startInk(context, world, point);
  } else if (tool === 'eraser') {
    context.mode = { kind: 'erase', last: point };
    eraseAt(context, point);
    context.overlay.request();
  } else if (tool === 'comment') {
    context.tools.complete();
    context.hooks.addComment?.(world);
  } else {
    return false;
  }
  return true;
}

/**
 * Handles of the selection, in the order they are drawn on top of each other: a polygon's
 * corner count, the corner radius, the transform frame, a connector's ends and bend, and
 * the connection dots. True if one was grabbed.
 */
export function pressHandles(context: InputContext, { point, world }: Press): boolean {
  const { overlay, scene } = context;

  const counted = countHandleAt(context, point);
  if (counted) {
    context.mode = { kind: 'count', id: counted.id, original: counted.sides };
    overlay.countActive = true;
    overlay.countLabel = polygonSides(counted);
    overlay.request();
    return true;
  }

  const rounded = radiusHandleAt(context, point);
  if (rounded) {
    context.mode = {
      kind: 'radius',
      id: rounded.id,
      original: rounded.radius,
      startRadius: effectiveRadius(rounded),
      startAlong: alongBisector(rounded, world),
    };
    overlay.radiusActive = true;
    overlay.request();
    return true;
  }

  // Transform frame: resize handles and edges, rotation just outside the corners.
  const transform = transformAt(context, world);
  if (transform) {
    const originals = context.selectedElements();
    const { frame, hit } = transform;
    if (hit.kind === 'resize') {
      context.mode = {
        kind: 'resize',
        handle: hit.handle,
        frame,
        originals,
        start: worldToFrame(frame, world),
        // Text scaled from a corner keeps its proportions too, like in Miro. Images in
        // crop and fit modes too (the frame hugs the picture); fill never distorts, so
        // it resizes freely (Figma).
        lockAspect: originals.some(
          (element) =>
            (element.type === 'image' &&
              (element.imageFit === 'crop' || element.imageFit === 'fit')) ||
            element.type === 'text',
        ),
        scaleText: HANDLE_SIGNS[hit.handle].every((sign) => sign !== 0),
        targets: snapTargets(context, new Set(originals.map((original) => original.id))),
      };
    } else {
      const center = { x: frame.centerX, y: frame.centerY };
      const only = originals.length === 1 ? originals[0]! : null;
      context.mode = {
        kind: 'rotate',
        center,
        originals,
        startAngle: Math.atan2(world.y - center.y, world.x - center.x),
        base: only && isShape(only) ? only.rotation : 0,
      };
    }
    context.clearDots();
    return true;
  }

  const handle = connectorHandleAt(context, point);
  if (handle) {
    const connector = scene.get(handle.id) as ConnectorElement;
    if (handle.hit.kind === 'end') {
      const { which } = handle.hit;
      context.mode = {
        kind: 'connect',
        id: handle.id,
        which,
        down: point,
        original: connector[which],
        fromDot: null,
      };
    } else {
      const { route, curve, elbowAt } = connector;
      context.mode = { kind: 'bend', id: handle.id, original: { route, curve, elbowAt } };
    }
    return true;
  }

  // Connection dots: drag out a new connector (a click quick-creates a shape on release).
  const dot = dotAt(context, point);
  if (dot) {
    const id = context.createConnector(
      { kind: 'element', id: dot.shape.id, anchor: dot.anchor },
      { kind: 'point', x: world.x, y: world.y },
    );
    context.clearDots();
    context.mode = {
      kind: 'connect',
      id,
      which: 'end',
      down: point,
      original: null,
      fromDot: { shape: dot.shape.id, anchor: dot.anchor },
    };
    return true;
  }
  return false;
}

/** Connector tool: a new connector from the shape under the press, or from a free point. */
export function pressConnectorTool(context: InputContext, { point, world }: Press): void {
  const shape = context.scene.hitTestShape(
    world,
    context.pixelsToWorld(HIT_TOLERANCE_PX),
    context.notConnectable,
  );
  const start: ConnectorEnd = shape
    ? { kind: 'element', id: shape.id }
    : { kind: 'point', x: world.x, y: world.y };
  const id = context.createConnector(start, { kind: 'point', x: world.x, y: world.y });
  context.mode = { kind: 'connect', id, which: 'end', down: point, original: null, fromDot: null };
}

/** Text tool: type into the shape under the press, or start a new text box on the empty board. */
export function pressTextTool(context: InputContext, { point, world }: Press): void {
  const shape = context.scene.hitTestShape(world, context.pixelsToWorld(HIT_TOLERANCE_PX));
  if (canHoldText(shape)) {
    context.overlay.selection = new Set([shape.id]);
    context.tools.complete();
    context.hooks.editText?.(shape.id);
  } else {
    context.mode = { kind: 'textbox', down: point, start: world };
  }
  context.overlay.request();
}

/**
 * Select tool: audio player controls act right away; a press on an element selects it
 * and starts moving the selection; on the empty board it starts a marquee.
 */
export function pressSelect(context: InputContext, press: Press, readOnly: boolean): void {
  const { overlay, scene } = context;
  const { world } = press;
  const hit = scene.hitTest(world, context.pixelsToWorld(HIT_TOLERANCE_PX));

  // Audio player controls act right away and don't change the selection.
  const control =
    hit && isShape(hit) ? hitTestAudio(hit, world, context.pixelsToWorld(AUDIO_HIT_PX)) : null;
  if (hit && isShape(hit) && control) {
    if (control.part === 'play') {
      context.hooks.audio?.toggle(hit.id);
    } else if (control.part === 'wave') {
      context.hooks.audio?.seek(hit.id, control.fraction);
      context.mode = { kind: 'seek', id: hit.id };
    } else if (!readOnly) {
      context.mode = { kind: 'volume', id: hit.id, original: hit.volume };
      scene.update(hit.id, { volume: control.value });
    }
    return;
  }

  if (hit) {
    const pressed = selectionAfterPress(scene, overlay.selection, hit.id, press.shift, press.deep);
    overlay.selection = pressed.selection;
    // Read-only: a press selects (and a click opens a link) but moves nothing.
    const origin = new Map<string, DragOrigin>();
    for (const id of readOnly ? [] : overlay.selection) {
      const shape = scene.get(id);
      if (!shape) continue;
      origin.set(
        id,
        isShape(shape)
          ? { kind: 'shape', x: shape.x, y: shape.y }
          : { kind: 'connector', start: shape.start, end: shape.end },
      );
    }
    const link =
      !press.shift && isShape(hit) ? (context.hooks.linkAt?.(hit.id, world) ?? null) : null;
    context.mode = {
      kind: 'drag',
      start: world,
      origin,
      link,
      onClick: pressed.onClick,
      box: snapBoxOf(context, origin.keys()),
      targets: snapTargets(context, new Set(origin.keys())),
      moved: false,
    };
    context.setCursor(press.deep || readOnly ? '' : 'move');
  } else {
    const base = press.shift ? new Set(overlay.selection) : new Set<string>();
    if (!press.shift) overlay.selection = new Set();
    context.mode = { kind: 'marquee', start: world, base };
  }
  context.clearDots();
  overlay.request();
}
