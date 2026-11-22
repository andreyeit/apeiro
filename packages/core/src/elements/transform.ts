import type { ConnectorElement, ConnectorEnd } from '../connectors/types';
import { frameToWorld, worldToFrame, type Frame } from '../geometry/frame';
import type { Vec2 } from '../geometry/vector';
import type { TextBlock } from '../text/text-block';
import { isShape, type BoardElement, type ElementPatch, type ShapeElement } from './element';

/**
 * Transforming the selection like in Figma/Miro: an oriented frame around it with resize
 * handles, rotation around its center. Pure functions: the UI feeds pointer positions in,
 * gets patches out (applied in one batch per pointer move).
 */

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Which side each handle moves: -1 left/top, 1 right/bottom, 0 that axis stays. */
export const HANDLE_SIGNS: Readonly<Record<ResizeHandle, readonly [number, number]>> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

export const CORNER_HANDLES: readonly ResizeHandle[] = ['nw', 'ne', 'se', 'sw'];
export const EDGE_HANDLES: readonly ResizeHandle[] = ['n', 'e', 's', 'w'];

/** The resize handle whose signs these are. */
export const handleOfSigns = (signs: readonly [number, number]): ResizeHandle =>
  (Object.keys(HANDLE_SIGNS) as ResizeHandle[]).find(
    (handle) => HANDLE_SIGNS[handle][0] === signs[0] && HANDLE_SIGNS[handle][1] === signs[1],
  )!;

/** World position of a resize handle. */
export function handlePoint(frame: Frame, handle: ResizeHandle): Vec2 {
  const [signX, signY] = HANDLE_SIGNS[handle];
  return frameToWorld(frame, { x: (signX * frame.width) / 2, y: (signY * frame.height) / 2 });
}

export interface ResizeOptions {
  /** Keep the width/height ratio (Shift in Figma). */
  keepAspect?: boolean;
  /** Resize symmetrically around the center (Alt in Figma). */
  fromCenter?: boolean;
  /** Smallest width/height, world units. */
  minSize?: number;
}

/**
 * The frame after dragging `handle` by `delta` (frame-local units: the pointer movement
 * since the grab, rotated into the frame). The opposite handle stays put, or the center
 * with `fromCenter`. The size never goes below `minSize` (no flipping).
 */
export function resizeFrame(
  frame: Frame,
  handle: ResizeHandle,
  delta: Vec2,
  options: ResizeOptions = {},
): Frame {
  const [signX, signY] = HANDLE_SIGNS[handle];
  const minimum = Math.max(options.minSize ?? 1, 1e-6);
  const halfWidth = frame.width / 2;
  const halfHeight = frame.height / 2;
  const handleX = signX * halfWidth + delta.x; // where the dragged handle is now (frame-local)
  const handleY = signY * halfHeight + delta.y;
  let width = frame.width;
  let height = frame.height;
  // Distance from the fixed side (or twice the distance from the center).
  if (signX !== 0) width = options.fromCenter ? 2 * signX * handleX : signX * handleX + halfWidth;
  if (signY !== 0) height = options.fromCenter ? 2 * signY * handleY : signY * handleY + halfHeight;
  width = Math.max(minimum, width);
  height = Math.max(minimum, height);
  if (options.keepAspect && frame.width > 0 && frame.height > 0) {
    if (signX !== 0 && signY !== 0) {
      // Corners follow whichever axis the pointer pulled further, like Figma.
      const scale = Math.max(width / frame.width, height / frame.height);
      width = frame.width * scale;
      height = frame.height * scale;
    } else if (signX !== 0) {
      height = (width * frame.height) / frame.width;
    } else {
      width = (height * frame.width) / frame.height;
    }
    const grow = Math.max(1, minimum / width, minimum / height);
    width *= grow;
    height *= grow;
  }
  let centerX = 0;
  let centerY = 0;
  if (!options.fromCenter) {
    if (signX !== 0) centerX = -signX * halfWidth + (signX * width) / 2;
    if (signY !== 0) centerY = -signY * halfHeight + (signY * height) / 2;
  }
  const center = frameToWorld(frame, { x: centerX, y: centerY });
  return { centerX: center.x, centerY: center.y, width, height, rotation: frame.rotation };
}

export interface ScaleOptions {
  /**
   * Scale the font of `text` elements with their box (Miro's corner handles). Otherwise
   * their text rewraps: a width change turns auto-width text into auto-height, a height
   * change makes the box fixed (Figma).
   */
  scaleText?: boolean;
}

/**
 * Patches that move `originals` (the elements as they were when the gesture started)
 * from frame `from` to frame `to`.
 *
 * One shape in its own frame gets exactly the new box. Several elements (an axis-aligned
 * group frame) are scaled around it: centers and free connector ends move proportionally,
 * and each shape's size scales along its own axes (exact for unrotated shapes).
 */
export function scaleElements(
  originals: readonly BoardElement[],
  from: Frame,
  to: Frame,
  options: ScaleOptions = {},
): Map<string, ElementPatch> {
  const patches = scaleBoxes(originals, from, to);
  for (const element of originals) {
    if (!isShape(element) || element.type !== 'text' || !element.text) continue;
    const patch = patches.get(element.id)!;
    const text = textAfterScale(
      element,
      element.text,
      patch.width ?? element.width,
      patch.height ?? element.height,
      options.scaleText ?? false,
    );
    if (text !== element.text) patch.text = text;
  }
  return patches;
}

/** Size changes smaller than this (world units) leave the sizing of text as it is. */
const SIZE_EPSILON = 1e-6;

function textAfterScale(
  element: ShapeElement,
  block: TextBlock,
  width: number,
  height: number,
  scaleText: boolean,
): TextBlock {
  if (scaleText) {
    const scale =
      element.width > 0 && element.height > 0
        ? Math.sqrt((width / element.width) * (height / element.height))
        : 1;
    return Math.abs(scale - 1) < 1e-9 ? block : { ...block, fontSize: block.fontSize * scale };
  }
  const sizing = block.sizing ?? 'fixed';
  if (sizing !== 'fixed' && Math.abs(height - element.height) > SIZE_EPSILON)
    return { ...block, sizing: 'fixed' };
  if (sizing === 'auto-width' && Math.abs(width - element.width) > SIZE_EPSILON)
    return { ...block, sizing: 'auto-height' };
  return block;
}

function scaleBoxes(
  originals: readonly BoardElement[],
  from: Frame,
  to: Frame,
): Map<string, ElementPatch> {
  const patches = new Map<string, ElementPatch>();
  const only = originals.length === 1 ? originals[0]! : null;
  if (only && isShape(only) && only.rotation === from.rotation) {
    patches.set(only.id, {
      x: to.centerX - to.width / 2,
      y: to.centerY - to.height / 2,
      width: to.width,
      height: to.height,
    });
    return patches;
  }
  const scaleX = from.width > 0 ? to.width / from.width : 1;
  const scaleY = from.height > 0 ? to.height / from.height : 1;
  // Group frames are axis-aligned; map world points through the frame anyway.
  const map = (point: Vec2): Vec2 => {
    const local = worldToFrame(from, point);
    return frameToWorld(to, { x: local.x * scaleX, y: local.y * scaleY });
  };
  for (const element of originals) {
    if (!isShape(element)) {
      patches.set(element.id, connectorPatch(element, map));
      continue;
    }
    const center = map({ x: element.x + element.width / 2, y: element.y + element.height / 2 });
    const relativeRotation = element.rotation - from.rotation;
    const cosine = Math.cos(relativeRotation);
    const sine = Math.sin(relativeRotation);
    const width = element.width * Math.hypot(scaleX * cosine, scaleY * sine);
    const height = element.height * Math.hypot(scaleX * sine, scaleY * cosine);
    patches.set(element.id, {
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
    });
  }
  return patches;
}

/** Free connector ends moved by `map`; attached ends follow their shapes by themselves. */
const mapEnd = (end: ConnectorEnd, map: (point: Vec2) => Vec2): ConnectorEnd => {
  if (end.kind !== 'point') return end;
  const point = map(end);
  return { kind: 'point', x: point.x, y: point.y };
};

function connectorPatch(connector: ConnectorElement, map: (point: Vec2) => Vec2): ElementPatch {
  return { start: mapEnd(connector.start, map), end: mapEnd(connector.end, map) };
}

/** Angle in (-π, π]. */
export function normalizeAngle(angle: number): number {
  const turn = Math.PI * 2;
  let normalized = ((angle % turn) + turn) % turn;
  if (normalized > Math.PI) normalized -= turn;
  return normalized;
}

/** Rounds an angle to the nearest multiple of `step` (radians). */
export const snapAngle = (angle: number, step: number): number => Math.round(angle / step) * step;

/** Patches that rotate `originals` by `angle` around `center`. */
export function rotateElements(
  originals: readonly BoardElement[],
  center: Vec2,
  angle: number,
): Map<string, ElementPatch> {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const map = (point: Vec2): Vec2 => {
    const deltaX = point.x - center.x;
    const deltaY = point.y - center.y;
    return {
      x: center.x + deltaX * cosine - deltaY * sine,
      y: center.y + deltaX * sine + deltaY * cosine,
    };
  };
  const patches = new Map<string, ElementPatch>();
  for (const element of originals) {
    if (!isShape(element)) {
      patches.set(element.id, connectorPatch(element, map));
      continue;
    }
    const middle = map({ x: element.x + element.width / 2, y: element.y + element.height / 2 });
    patches.set(element.id, {
      x: middle.x - element.width / 2,
      y: middle.y - element.height / 2,
      rotation: normalizeAngle(element.rotation + angle),
    });
  }
  return patches;
}

/** Patches that move `originals` by (`deltaX`, `deltaY`). */
export function translateElements(
  originals: readonly BoardElement[],
  deltaX: number,
  deltaY: number,
): Map<string, ElementPatch> {
  const patches = new Map<string, ElementPatch>();
  const map = (point: Vec2): Vec2 => ({ x: point.x + deltaX, y: point.y + deltaY });
  for (const element of originals) {
    if (isShape(element)) patches.set(element.id, { x: element.x + deltaX, y: element.y + deltaY });
    else patches.set(element.id, connectorPatch(element, map));
  }
  return patches;
}

/**
 * CSS resize cursor for a handle of a frame rotated by `rotation`: the handle's direction
 * snapped to the four cursor axes.
 */
export function resizeCursor(handle: ResizeHandle, rotation: number): string {
  const [signX, signY] = HANDLE_SIGNS[handle];
  const degrees = (((((Math.atan2(signY, signX) + rotation) * 180) / Math.PI) % 180) + 180) % 180;
  const names = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
  return names[Math.round(degrees / 45) % 4]!;
}
