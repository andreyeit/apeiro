import {
  boxFromPoints,
  CameraAnimator,
  HANDLE_SIGNS,
  hugTextPatch,
  isConnector,
  resetBend,
  reverseConnector,
  type BoardElement,
  type Camera,
  type Scene,
  type Vec2,
} from '@apeiro/core';
import type { Overlay } from '../overlay/overlay';
import { VIEW_TOOLS, type ToolState } from '../tools/tool-state';
import { AutoPan } from './autopan';
import { CLICK_SLOP_PX, FLING_WINDOW_MS, HIT_TOLERANCE_PX, TEXTBOX_DRAG_PX } from './constants';
import { InputContext, type ControlsHooks } from './context';
import { finishConnect } from './connect';
import { startCrop, stopCrop, toggleCrop } from './crop';
import { connectorHandleAt, transformAt } from './hit-targets';
import { hover, idleCursor } from './hover';
import { extendInk, finishInk } from './ink';
import { handleShortcut, isTypingTarget } from './keyboard';
import { completesTool, type ModeOf } from './modes';
import { moveGesture } from './move';
import {
  pressConnectorTool,
  pressCreatingTool,
  pressCrop,
  pressHandles,
  pressSelect,
  pressTextTool,
  type Press,
} from './press';
import { revertGesture } from './revert';

export { cropControls, type ControlsHooks, type CropControls } from './context';

type CustomHandler = 'onPointerDown' | 'onPointerMove' | 'onPointerUp';

/**
 * Pointer and keyboard handling of a board: tools, selection, handles and every gesture.
 * Listens on `element` (pointer) and the window (keyboard); returns a function that detaches.
 *
 * Each pointer gesture becomes one undo step (see `ControlsHooks.history`). Gestures are
 * modules of this folder: `press.ts` starts one, `move.ts` applies it as the pointer
 * moves, `revert.ts` puts things back on Esc.
 */
export function attachControls(
  element: HTMLElement,
  scene: Scene,
  camera: Camera,
  overlay: Overlay,
  tools: ToolState,
  animator: CameraAnimator = new CameraAnimator(camera),
  hooks: ControlsHooks = {},
): () => void {
  const context = new InputContext(element, scene, camera, overlay, tools, animator, hooks);
  const autoPan = new AutoPan(context, (point) => moveGesture(context, point));
  /** Pointer that owns the current gesture: a second finger/pen must not hijack it. */
  let activePointer: number | null = null;
  /** True while the current pointer gesture is being recorded as one undo step. */
  let grouping = false;

  const beginGroup = () => {
    if (grouping || !hooks.history) return;
    grouping = true;
    hooks.history.beginGroup();
  };
  const endGroup = () => {
    if (!grouping) return;
    grouping = false;
    hooks.history?.endGroup();
  };

  if (hooks.crop) {
    hooks.crop.start = (id) => startCrop(context, id);
    hooks.crop.stop = () => stopCrop(context);
  }

  /** Element-local screen point of an event. Pass `rectangle` to reuse one layout read for several events. */
  const local = (
    position: { clientX: number; clientY: number },
    rectangle: DOMRect = element.getBoundingClientRect(),
  ): Vec2 => ({ x: position.clientX - rectangle.left, y: position.clientY - rectangle.top });

  // --- Modifiers ----------------------------------------------------------------------

  /** Records Shift/Alt/Ctrl; true if Shift or Alt changed (a transform re-applies then). */
  const readModifiers = (event: {
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  }): boolean => {
    const changed =
      context.modifiers.shift !== event.shiftKey || context.modifiers.alt !== event.altKey;
    context.modifiers.shift = event.shiftKey;
    context.modifiers.alt = event.altKey;
    setDeep(event.ctrlKey || event.metaKey);
    return changed;
  };
  /** Ctrl/⌘ pressed or released: hover and a running marquee switch between groups and elements. */
  const setDeep = (deep: boolean) => {
    if (context.modifiers.deep === deep) return;
    context.modifiers.deep = deep;
    overlay.deep = deep;
    if (context.mode.kind === 'marquee' && context.pointer) moveGesture(context, context.pointer);
    // The cursor follows Ctrl/⌘ right away, without waiting for the pointer to move.
    else if (context.mode.kind === 'idle' && context.pointer) hover(context, context.pointer);
    overlay.request();
  };

  // --- Gesture lifecycle --------------------------------------------------------------

  /** Clears the transient overlay state of a gesture and goes idle. */
  const endGesture = () => {
    autoPan.stop();
    overlay.marquee = null;
    overlay.guides = [];
    overlay.spacing = [];
    overlay.target = null;
    overlay.snap = null;
    overlay.radiusActive = false;
    overlay.countActive = false;
    overlay.countLabel = null;
    overlay.badge = null;
    context.mode = { kind: 'idle' };
    context.setCursor(idleCursor(context));
    overlay.request();
  };

  /** Esc during a gesture: put everything back as it was. False if no gesture runs. */
  const cancelGesture = (): boolean => {
    const mode = context.mode;
    if (mode.kind === 'custom') {
      mode.unsubscribe();
      // End the mode first: a user's cancellation handler may activate another tool.
      endGesture();
      try {
        mode.definition.onCancel?.();
      } finally {
        scene.transact(() => {
          for (const [id, previous] of mode.before) {
            if (scene.has(id)) scene.remove(id);
            if (previous) scene.add(previous);
          }
        });
        endGroup();
      }
      return true;
    }
    if (!revertGesture(context)) return false;
    endGesture();
    return true;
  };

  /** Starts a custom tool's gesture; its changes are recorded so a cancel can undo them. */
  const startCustom = (name: string, definition: ModeOf<'custom'>['definition']) => {
    const before = new Map<string, BoardElement | undefined>();
    const unsubscribe = scene.subscribe((changes) => {
      for (const [id, previous] of changes.previous) {
        if (changes.origin !== undefined) before.delete(id); // Never undo a remote edit.
        else if (!before.has(id)) before.set(id, previous);
      }
    });
    context.mode = { kind: 'custom', name, definition, before, unsubscribe };
  };

  /** Calls a custom tool's handler; a throwing tool cancels its gesture. False if it threw. */
  const customPointer = (handler: CustomHandler, event: PointerEvent, point: Vec2): boolean => {
    if (context.mode.kind !== 'custom') return false;
    try {
      context.mode.definition[handler]?.({ point: context.world(point), event });
      return true;
    } catch (error) {
      cancelGesture();
      if (hooks.onToolError) hooks.onToolError(error);
      else throw error;
      return false;
    }
  };

  // --- Finishing gestures -------------------------------------------------------------

  const finishTextBox = (mode: ModeOf<'textbox'>, point: Vec2) => {
    const end = context.world(point);
    tools.complete();
    if (Math.abs(point.x - mode.down.x) >= TEXTBOX_DRAG_PX) {
      const x = Math.min(mode.start.x, end.x);
      hooks.createText?.({ x, y: Math.min(mode.start.y, end.y) }, Math.abs(end.x - mode.start.x));
    } else {
      hooks.createText?.(mode.start);
    }
  };

  const finishPlace = (mode: ModeOf<'place'>, point: Vec2) => {
    const end = context.world(point);
    tools.complete();
    const dragged = context.screenDistance(point, mode.start) >= CLICK_SLOP_PX;
    hooks.place?.(mode.shape, mode.start, dragged ? boxFromPoints(mode.start, end) : null);
  };

  /** A press on an element that ended without a drag: open a link or apply the click selection. */
  const finishClick = (mode: ModeOf<'drag'>, point: Vec2) => {
    if (context.screenDistance(point, mode.start) >= CLICK_SLOP_PX) return;
    if (mode.link) {
      // A click on a link opens it; a drag that started on one just moves the shape.
      const link = mode.link;
      cancelGesture(); // put back the sub-threshold move
      hooks.openLink?.(link);
    } else if (mode.onClick) {
      // A click, not a drag: go inside a group, or Shift-deselect.
      const next = mode.onClick;
      cancelGesture(); // put back the sub-threshold move
      overlay.selection = next;
    }
  };

  // --- Pointer handlers ---------------------------------------------------------------

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      // Pinch on trackpads arrives as ctrl+wheel with small deltas.
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.01));
      animator.zoomAt(local(event), factor);
    } else {
      const lineHeight = event.deltaMode === 1 ? 16 : 1; // lines → px
      animator.panBy(-event.deltaX * lineHeight, -event.deltaY * lineHeight);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (activePointer !== null && activePointer !== event.pointerId) return; // one gesture at a time
    element.setPointerCapture(event.pointerId);
    activePointer = event.pointerId;
    readModifiers(event);
    beginGroup();
    const point = local(event);
    context.pointer = point;
    if (
      event.button === 1 ||
      (event.button === 0 && (context.spaceDown || tools.tool === 'hand'))
    ) {
      animator.stop(); // grabbing the board stops any camera animation
      context.mode = {
        kind: 'pan',
        last: point,
        lastTime: event.timeStamp,
        velocityX: 0,
        velocityY: 0,
      };
      context.setCursor('grabbing');
      return;
    }
    if (event.button !== 0) return;
    animator.stop();
    const press: Press = {
      point,
      world: context.world(point),
      shift: event.shiftKey,
      deep: event.ctrlKey || event.metaKey,
    };
    if (pressCrop(context, press)) return;

    // A read-only board only selects (and pins comments) whatever tool is set.
    const readOnly = context.readOnly();
    const tool = readOnly && !VIEW_TOOLS.has(tools.tool) ? 'select' : tools.tool;
    const custom = tools.customTool(tool);
    if (custom) {
      startCustom(tool, custom);
      customPointer('onPointerDown', event, point);
      return;
    }
    if (pressCreatingTool(context, tool, press)) return;
    if (pressHandles(context, press)) return;
    if (tool === 'connector') pressConnectorTool(context, press);
    else if (tool === 'text') pressTextTool(context, press);
    else pressSelect(context, press, readOnly);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (activePointer !== null && activePointer !== event.pointerId) return;
    readModifiers(event);
    const rectangle = element.getBoundingClientRect();
    const point = local(event, rectangle);
    context.pointer = point;
    const mode = context.mode;
    if (mode.kind === 'custom') {
      customPointer('onPointerMove', event, point);
      return;
    }
    if (mode.kind === 'pan') {
      const deltaX = point.x - mode.last.x;
      const deltaY = point.y - mode.last.y;
      camera.panBy(deltaX, deltaY);
      // Smoothed velocity (px/s) for the fling on release.
      const elapsed = Math.max(1, event.timeStamp - mode.lastTime) / 1000;
      mode.velocityX = mode.velocityX * 0.6 + (deltaX / elapsed) * 0.4;
      mode.velocityY = mode.velocityY * 0.6 + (deltaY / elapsed) * 0.4;
      mode.last = point;
      mode.lastTime = event.timeStamp;
      return;
    }
    if (mode.kind === 'idle') {
      hover(context, point);
      return;
    }
    // Drawing: every position the browser saw between frames, not just the last one,
    // so a fast stroke keeps its shape. One scene update for all of them.
    if (mode.kind === 'ink' && typeof event.getCoalescedEvents === 'function') {
      const coalesced = event.getCoalescedEvents();
      const points = coalesced.map((sample) => local(sample, rectangle));
      const times = coalesced.map((sample) => sample.timeStamp);
      points.push(point);
      times.push(event.timeStamp);
      if (extendInk(context, mode, points, times)) overlay.request();
    } else {
      moveGesture(context, point);
    }
    autoPan.maybeStart(point);
  };

  const releasePointer = (event: PointerEvent): boolean => {
    if (activePointer !== null && activePointer !== event.pointerId) return false;
    activePointer = null;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    return true;
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!releasePointer(event)) return;
    const point = local(event);
    const completed = context.mode.kind;
    if (context.mode.kind === 'custom') {
      if (!customPointer('onPointerUp', event, point)) return;
      if (context.mode.kind === 'custom') context.mode.unsubscribe();
    }
    const mode = context.mode;
    if (mode.kind === 'connect') finishConnect(context, mode, point);
    else if (mode.kind === 'textbox') finishTextBox(mode, point);
    else if (mode.kind === 'place') finishPlace(mode, point);
    else if (mode.kind === 'ink') finishInk(context, mode);
    else if (mode.kind === 'drag') finishClick(mode, point);
    else if (mode.kind === 'pan' && event.timeStamp - mode.lastTime < FLING_WINDOW_MS) {
      animator.fling(mode.velocityX, mode.velocityY);
    }
    endGesture();
    endGroup();
    if (completesTool(completed)) tools.complete();
    hover(context, point);
  };

  /** The system took the pointer away (OS gesture, scroll, palm rejection): undo, don't commit. */
  const onPointerCancel = (event: PointerEvent) => {
    if (!releasePointer(event)) return;
    if (!cancelGesture()) endGesture();
    endGroup();
  };

  /** Keys released while the window is in the background never send keyup. */
  const onBlur = () => {
    context.spaceDown = false;
    setDeep(false);
    if (context.mode.kind === 'idle') context.setCursor(idleCursor(context));
  };

  const onDoubleClick = (event: MouseEvent) => {
    if (context.readOnly()) return; // everything below changes the board
    const point = local(event);
    const world = context.world(point);
    // Figma: a double click on a resize handle of a text box makes it hug its text —
    // a corner or a left/right side fits the width (auto width), top/bottom the height.
    const only =
      overlay.selection.size === 1
        ? context.getShape(overlay.selection.values().next().value!)
        : undefined;
    const handle = only?.type === 'text' && hooks.measurer ? transformAt(context, world) : null;
    if (only && hooks.measurer && handle?.hit.kind === 'resize') {
      const [signX] = HANDLE_SIGNS[handle.hit.handle];
      const patch = hugTextPatch(only, hooks.measurer, signX !== 0 ? 'auto-width' : 'auto-height');
      if (patch) scene.update(only.id, patch);
      event.stopImmediatePropagation(); // not a text-edit double click
      overlay.request();
      return;
    }
    // An image: crop mode on (or off, double clicking it again), as in Figma.
    const picture =
      tools.tool === 'select'
        ? scene.hitTest(world, context.pixelsToWorld(HIT_TOLERANCE_PX))
        : undefined;
    if (picture?.type === 'image') {
      toggleCrop(context, picture.id);
      return;
    }
    // The bend handle of a connector: remove the manual bend.
    const bendHandle = connectorHandleAt(context, point);
    if (!bendHandle || bendHandle.hit.kind !== 'bend') return;
    event.stopImmediatePropagation(); // not a text-edit double click
    scene.update(bendHandle.id, resetBend());
    overlay.request();
  };

  // --- Keyboard -----------------------------------------------------------------------

  /** Shift/Alt pressed or released mid-transform: re-apply at the current pointer. */
  const liveModifiers = (event: KeyboardEvent) => {
    const kind = context.mode.kind;
    if (
      readModifiers(event) &&
      context.pointer &&
      (kind === 'resize' || kind === 'rotate' || kind === 'drag')
    ) {
      moveGesture(context, context.pointer);
      if (event.key === 'Alt') event.preventDefault(); // keep the browser menu bar from taking focus
    }
  };

  const acceptsKeys = (event: KeyboardEvent) =>
    !isTypingTarget(event.target) && (hooks.acceptsKeys?.() ?? true);

  const onKeyDown = (event: KeyboardEvent) => {
    liveModifiers(event);
    if (acceptsKeys(event)) handleShortcut(context, event, cancelGesture);
  };

  const onKeyUp = (event: KeyboardEvent) => {
    liveModifiers(event);
    if (event.code === 'Space') {
      context.spaceDown = false;
      if (context.mode.kind === 'idle') context.setCursor(idleCursor(context));
    }
  };

  const onLeave = () => {
    if (context.mode.kind !== 'idle') return;
    overlay.hover = null;
    overlay.hoverDot = null;
    overlay.request();
  };

  const previousOnChange = tools.onChange;
  tools.onChange = () => {
    if (context.mode.kind === 'custom' && context.mode.name !== tools.tool) cancelGesture();
    previousOnChange();
    overlay.transformEnabled = tools.tool === 'select';
    context.setCursor(idleCursor(context));
    context.clearDots();
    overlay.request();
  };

  const listeners: Array<[EventTarget, string, (event: never) => void, AddEventListenerOptions?]> =
    [
      [element, 'wheel', onWheel, { passive: false }],
      [element, 'pointerdown', onPointerDown],
      [element, 'pointermove', onPointerMove],
      [element, 'pointerup', onPointerUp],
      [element, 'pointercancel', onPointerCancel],
      [element, 'pointerleave', onLeave],
      [element, 'dblclick', onDoubleClick],
      [window, 'keydown', onKeyDown],
      [window, 'keyup', onKeyUp],
      [window, 'blur', onBlur],
    ];
  for (const [target, type, listener, options] of listeners) {
    target.addEventListener(type, listener as EventListener, options);
  }
  return () => {
    if (context.mode.kind === 'custom') cancelGesture();
    tools.onChange = previousOnChange;
    autoPan.stop();
    for (const [target, type, listener] of listeners) {
      target.removeEventListener(type, listener as EventListener);
    }
  };
}

/** Swaps start and end of every selected connector (arrows then point the other way). */
export function reverseSelected(scene: Scene, selection: Iterable<string>): void {
  scene.transact(() => {
    for (const id of selection) {
      const element = scene.get(id);
      if (element && isConnector(element)) scene.update(id, reverseConnector(element));
    }
  });
}
