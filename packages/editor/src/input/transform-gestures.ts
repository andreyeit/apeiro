/**
 * The math of the two heaviest pointer gestures, moving and resizing the selection: pure
 * functions of the gesture's start, the pointer and the modifier keys, so `controls.ts`
 * only applies their result (and they can be tested without a DOM).
 */
import {
  fitTextPatch,
  gridStep,
  isShape,
  HANDLE_SIGNS,
  resizeFrame,
  scaleElements,
  snapBox,
  type BoardElement,
  type Box,
  type ElementPatch,
  type FontMeasurer,
  type Frame,
  type ResizeHandle,
  type ShapeElement,
  type SnapGuide,
  type SpacingGuide,
  type Vec2,
} from '@apeiro/core';

/** Smart guides catch an edge this close, screen px. */
export const GUIDE_SNAP_PX = 6;

/** What snapping depends on besides the gesture itself. */
export interface SnapContext {
  zoom: number;
  /** Snapping is on for the board. */
  snapping: boolean;
  /** Modifier keys: Shift locks an axis (moves) or the aspect (resizes) and snaps to the grid. */
  shift: boolean;
  /** Alt resizes from the center. */
  alt: boolean;
  /** Ctrl/⌘: no snapping. */
  deep: boolean;
}

/** The offset of a move and the guides to draw. */
export interface DragStep {
  deltaX: number;
  deltaY: number;
  guides: SnapGuide[];
  spacing: SpacingGuide[];
}

/**
 * Offset of the selection being moved from world point `start` to `world`. Shift keeps the
 * dominant axis only, as in Figma; past the click slop (`moved`) the moved `box` snaps to
 * the `targets` (smart guides), and to the grid with Shift.
 */
export function dragStep(
  start: Vec2,
  world: Vec2,
  box: Box | null,
  targets: readonly Box[],
  moved: boolean,
  snapContext: SnapContext,
): DragStep {
  let deltaX = world.x - start.x;
  let deltaY = world.y - start.y;
  let lockX = false;
  let lockY = false;
  if (snapContext.shift) {
    if (Math.abs(deltaX) >= Math.abs(deltaY)) lockY = true;
    else lockX = true;
    if (lockY) deltaY = 0;
    else deltaX = 0;
  }
  if (!snapContext.snapping || !box || !moved || snapContext.deep)
    return { deltaX, deltaY, guides: [], spacing: [] };
  const snap = snapBox(
    {
      minX: box.minX + deltaX,
      minY: box.minY + deltaY,
      maxX: box.maxX + deltaX,
      maxY: box.maxY + deltaY,
    },
    targets,
    {
      threshold: GUIDE_SNAP_PX / snapContext.zoom,
      // The grid only with Shift; otherwise the move is free between guides.
      grid: snapContext.shift ? gridStep(snapContext.zoom) : 0,
      lockX,
      lockY,
    },
  );
  return {
    deltaX: deltaX + snap.deltaX,
    deltaY: deltaY + snap.deltaY,
    guides: snap.guides,
    spacing: snap.spacing,
  };
}

/** A resize as it started. */
export interface ResizeStart {
  handle: ResizeHandle;
  /** The selection's frame and the elements when the drag started. */
  frame: Frame;
  originals: readonly BoardElement[];
  /** Pointer at the start, frame-local. */
  start: Vec2;
  /** Corners keep the aspect ratio by default; Shift inverts it. */
  lockAspect: boolean;
  /** Corners scale the font of text boxes; sides rewrap it. */
  scaleText: boolean;
  /** Boxes of the other elements, for snapping the dragged sides. */
  targets: readonly Box[];
}

/** The elements' patches of a resize step, the guides and the size badge. */
export interface ResizeStep {
  patches: Map<string, ElementPatch>;
  guides: SnapGuide[];
  badge: string;
}

/**
 * The selection resized by the pointer at frame-local point `local`: the frame follows the
 * handle (aspect, from the center), its dragged sides snap (unrotated frames), and the
 * elements are scaled into it; auto-sized text refits with `measurer`.
 */
export function resizeStep(
  start: ResizeStart,
  local: Vec2,
  snapContext: SnapContext,
  measurer?: FontMeasurer,
): ResizeStep {
  const [signX, signY] = HANDLE_SIGNS[start.handle];
  const corner = signX !== 0 && signY !== 0;
  const options = {
    keepAspect: snapContext.shift !== (start.lockAspect && corner),
    fromCenter: snapContext.alt,
    minSize: 2 / snapContext.zoom,
  };
  const delta = { x: local.x - start.start.x, y: local.y - start.start.y };
  const frame = start.frame;
  let next = resizeFrame(frame, start.handle, delta, options);
  let guides: SnapGuide[] = [];
  // With a locked aspect only the side that drives the size snaps: the other one follows.
  if (snapContext.snapping && frame.rotation === 0 && !snapContext.deep) {
    const xDrives =
      !options.keepAspect ||
      signY === 0 ||
      (signX !== 0 && next.width / frame.width >= next.height / frame.height);
    const side = (sign: number) => (sign > 0 ? ['max' as const] : sign < 0 ? ['min' as const] : []);
    const snap = snapBox(
      {
        minX: next.centerX - next.width / 2,
        maxX: next.centerX + next.width / 2,
        minY: next.centerY - next.height / 2,
        maxY: next.centerY + next.height / 2,
      },
      start.targets,
      {
        threshold: GUIDE_SNAP_PX / snapContext.zoom,
        grid: snapContext.shift ? gridStep(snapContext.zoom) : 0, // the grid only with Shift
        edges: {
          x: xDrives ? side(signX) : [],
          y: !options.keepAspect || !xDrives ? side(signY) : [],
        },
      },
    );
    if (snap.deltaX !== 0 || snap.deltaY !== 0)
      next = resizeFrame(
        frame,
        start.handle,
        { x: delta.x + snap.deltaX, y: delta.y + snap.deltaY },
        options,
      );
    guides = snap.guides;
  }
  const patches = scaleElements(start.originals, frame, next, {
    scaleText: start.scaleText,
  });
  if (measurer) {
    // Auto-sized text follows its text: e.g. a narrower box wraps and grows taller.
    for (const original of start.originals) {
      const patch = patches.get(original.id);
      if (!patch || original.type !== 'text' || !isShape(original)) continue;
      const fit = fitTextPatch({ ...original, ...patch } as ShapeElement, measurer);
      if (fit) Object.assign(patch, fit);
    }
  }
  return { patches, guides, badge: `${Math.round(next.width)} × ${Math.round(next.height)}` };
}
