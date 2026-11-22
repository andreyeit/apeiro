import {
  anchorAt,
  boxIntersects,
  freezeConnectorEnds,
  isConnector,
  isShape,
  isSideMidpoint,
  newId,
  rotateVector,
  type ConnectorEnd,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';
import { CLICK_SLOP_PX, EDGE_PX, QUICK_GAP, SNAP_PX, SNAP_RELEASE } from './constants';
import type { InputContext } from './context';
import type { ModeOf } from './modes';

// Dragging a connector end: attaching it to shapes (with side-midpoint magnets), and the
// quick-create click on a connection dot.

/** Points the dragged end at the shape under the cursor (snapping to side midpoints), or at the cursor. */
export function updateDraggedEnd(
  context: InputContext,
  mode: ModeOf<'connect'>,
  point: Vec2,
): void {
  const { scene, overlay } = context;
  const connector = scene.get(mode.id);
  if (!connector || !isConnector(connector)) return;
  const world = context.world(point);
  const other = mode.which === 'start' ? connector.end : connector.start;
  const otherShape = other.kind === 'element' ? other.id : null;
  // Shapes within the magnet radius count as targets, so the end can snap from outside.
  // While snapped to a side middle, the radius grows so the end doesn't flicker at its edge.
  const holding = overlay.target !== null && overlay.snap !== null && isSideMidpoint(overlay.snap);
  const radius = context.pixelsToWorld(SNAP_PX * (holding ? SNAP_RELEASE : 1));
  const target = scene.hitTestShape(
    world,
    radius,
    (id) => id === otherShape || context.notConnectable(id),
  );
  const held = holding && target?.id === overlay.target;
  const snap = held ? radius : context.pixelsToWorld(SNAP_PX);
  const anchor = target ? anchorAt(target, world, snap, context.pixelsToWorld(EDGE_PX)) : undefined;
  const end: ConnectorEnd = target
    ? anchor
      ? { kind: 'element', id: target.id, anchor }
      : { kind: 'element', id: target.id }
    : { kind: 'point', x: world.x, y: world.y };
  scene.update(mode.id, mode.which === 'start' ? { start: end } : { end });
  overlay.target = target?.id ?? null;
  overlay.snap = anchor ?? null;
}

/**
 * Ends a connector drag at screen point `point`. A click on a connection dot (no drag) removes
 * the new connector and quick-creates a connected copy of the shape instead.
 */
export function finishConnect(context: InputContext, mode: ModeOf<'connect'>, point: Vec2): void {
  const moved = Math.hypot(point.x - mode.down.x, point.y - mode.down.y);
  if (mode.original === null && moved < CLICK_SLOP_PX) {
    context.scene.remove(mode.id); // a click, not a drag
    const source = mode.fromDot ? context.getShape(mode.fromDot.shape) : undefined;
    if (source && mode.fromDot) quickCreate(context, source, mode.fromDot.anchor);
    return;
  }
  // Rigid attachment: ends dropped inside a shape stay where they landed on its outline.
  const connector = context.scene.get(mode.id);
  const frozen =
    connector && isConnector(connector) ? freezeConnectorEnds(connector, context.getShape) : null;
  if (frozen) context.scene.update(mode.id, frozen);
  context.overlay.selection = new Set([mode.id]);
}

/** Click on a connection dot: a copy of the shape next to it, connected by an arrow. */
function quickCreate(context: InputContext, source: ShapeElement, anchor: Vec2): void {
  const { scene } = context;
  const local = { x: (anchor.x - 0.5) * 2, y: (anchor.y - 0.5) * 2 };
  const direction = rotateVector(local, source.rotation);
  const step = (Math.abs(local.x) > 0 ? source.width : source.height) + QUICK_GAP;
  const centerX = source.x + source.width / 2;
  const centerY = source.y + source.height / 2;
  const at = (multiple: number) => ({
    x: centerX + direction.x * step * multiple - source.width / 2,
    y: centerY + direction.y * step * multiple - source.height / 2,
  });
  // Walk further out until the spot is free.
  let multiple = 1;
  for (; multiple < 8; multiple++) {
    const { x, y } = at(multiple);
    const box = { minX: x, minY: y, maxX: x + source.width, maxY: y + source.height };
    const taken = scene
      .queryBox(box)
      .some((element) => isShape(element) && boxIntersects(scene.getBounds(element.id)!, box));
    if (!taken) break;
  }
  const id = newId('s');
  const copy: ShapeElement = {
    ...source,
    id,
    ...at(multiple),
    z: scene.maxZ() + 1,
    text: source.text ? { ...source.text, runs: [{ text: '' }] } : undefined,
    groupId: undefined,
  };
  const opposite = { x: 1 - anchor.x, y: 1 - anchor.y };
  scene.transact(() => {
    scene.add(copy);
    context.createConnector(
      { kind: 'element', id: source.id, anchor },
      { kind: 'element', id, anchor: opposite },
    );
  });
  context.overlay.selection = new Set([id]);
  context.clearDots();
  context.hooks.onQuickCreate?.(id);
}
