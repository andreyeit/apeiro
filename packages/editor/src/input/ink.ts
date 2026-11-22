import {
  boxAroundPoint,
  eraseStroke,
  newId,
  hitTestElement,
  inkGeometry,
  inkWorldPoints,
  isShape,
  pullString,
  relaxStroke,
  simplifyStroke,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';
import {
  ERASER_PX,
  INK_RELAX_PASSES,
  INK_RELAX_SPACING_PX,
  INK_SIMPLIFY_PX,
  INK_FULL_STRING_SPEED,
  INK_SPEED_BLEND,
  INK_STEP_PX,
  INK_STRING_PX,
} from './constants';
import type { InputContext } from './context';
import type { ModeOf } from './modes';

// Pen and eraser.

/** Starts a pen stroke at `world` (screen point `point`) in the current pen style. */
export function startInk(context: InputContext, world: Vec2, point: Vec2): void {
  const id = newId('i');
  context.scene.add({
    id,
    type: 'ink',
    ...inkGeometry([world]),
    rotation: 0,
    z: context.scene.maxZ() + 1,
    fill: 0,
    stroke: context.tools.pen.stroke,
    strokeWidth: context.tools.pen.strokeWidth,
    radius: 0,
  });
  context.mode = {
    kind: 'ink',
    id,
    points: [world],
    last: point,
    drawn: point,
    pointer: point,
    speed: 0,
    time: performance.now(),
  };
}

/**
 * Extends the stroke through screen points `points` (the browser's coalesced positions since
 * the last event, then the current one, seen at `times`) with one scene update. The line
 * follows a stabilized pen tip on a string behind the pointer (`pullString`), so hand tremor
 * doesn't show. The string shortens as the pointer slows down, so by the time the hand stops
 * the line has caught up with it. False if the tip barely moved.
 */
export function extendInk(
  context: InputContext,
  mode: ModeOf<'ink'>,
  points: readonly Vec2[],
  times?: readonly number[],
): boolean {
  let added = false;
  points.forEach((point, index) => {
    const time = times?.[index] ?? performance.now();
    const elapsed = time - mode.time;
    // A repeated sample (same moment) says nothing about the speed.
    if (elapsed > 0) {
      const moved = Math.hypot(point.x - mode.pointer.x, point.y - mode.pointer.y);
      mode.speed += (moved / elapsed - mode.speed) * INK_SPEED_BLEND;
      mode.time = time;
    }
    mode.pointer = point;
    const string = INK_STRING_PX * Math.min(1, mode.speed / INK_FULL_STRING_SPEED);
    const drawn = pullString(mode.drawn, point, string);
    if (!drawn) return;
    mode.drawn = drawn;
    if (Math.hypot(drawn.x - mode.last.x, drawn.y - mode.last.y) < INK_STEP_PX) return;
    mode.last = drawn;
    mode.points.push(context.world(drawn));
    added = true;
  });
  if (added) context.scene.update(mode.id, inkGeometry(relaxed(context, mode.points)));
  return added;
}

/** The stroke as drawn: the stabilized points, relaxed (see `relaxStroke`). */
function relaxed(context: InputContext, points: readonly Vec2[]): Vec2[] {
  return relaxStroke(points, context.pixelsToWorld(INK_RELAX_SPACING_PX), INK_RELAX_PASSES);
}

/**
 * Ends the stroke where the stabilized tip is (nothing is added after the button is let go:
 * the tip has caught up while the hand slowed down), then keeps its look with fewer points,
 * dropping the ones that add nothing.
 */
export function finishInk(context: InputContext, mode: ModeOf<'ink'>): void {
  if (mode.points.length < 2) return;
  const stroke = relaxed(context, mode.points);
  context.scene.update(
    mode.id,
    inkGeometry(simplifyStroke(stroke, context.pixelsToWorld(INK_SIMPLIFY_PX))),
  );
}

/**
 * Erases the ink under the eraser around screen point `point`: only the part it covers. A
 * stroke cut in the middle falls apart into separate strokes; one covered completely
 * goes away.
 */
export function eraseAt(context: InputContext, point: Vec2): void {
  const { scene, overlay } = context;
  const world = context.world(point);
  const radius = context.pixelsToWorld(ERASER_PX);
  const near = scene.queryBox(boxAroundPoint(world, radius));
  const hits = near.filter(
    (element): element is ShapeElement =>
      isShape(element) && element.type === 'ink' && hitTestElement(element, world, radius),
  );
  if (hits.length === 0) return;
  scene.transact(() => {
    for (const element of hits) {
      // Where the eraser touches the drawn line, not just its center line.
      const pieces = eraseStroke(inkWorldPoints(element), world, radius + element.strokeWidth / 2);
      if (!pieces) continue;
      if (pieces.length === 0) {
        scene.remove(element.id);
        overlay.selection.delete(element.id);
        continue;
      }
      // Fewer points: the cut added some along the stroke.
      const tidy = pieces.map((piece) =>
        simplifyStroke(piece, context.pixelsToWorld(INK_SIMPLIFY_PX)),
      );
      scene.update(element.id, { ...inkGeometry(tidy[0]!), rotation: 0 });
      for (const piece of tidy.slice(1)) {
        scene.add({ ...element, id: newId('i'), ...inkGeometry(piece), rotation: 0 });
      }
    }
  });
}

/** Erases along the whole way from the last position: a fast stroke must not skip a line. */
export function eraseAlong(context: InputContext, mode: ModeOf<'erase'>, point: Vec2): void {
  const from = mode.last;
  const steps = Math.max(1, Math.ceil(Math.hypot(point.x - from.x, point.y - from.y) / ERASER_PX));
  for (let step = 1; step <= steps; step++) {
    eraseAt(context, {
      x: from.x + ((point.x - from.x) * step) / steps,
      y: from.y + ((point.y - from.y) * step) / steps,
    });
  }
  mode.last = point;
}
