import type {
  BoardElement,
  Box,
  ConnectorElement,
  ConnectorEnd,
  Frame,
  ShapeElement,
  Vec2,
} from '@apeiro/core';
import type { CustomTool, PlaceKind } from '../tools/tool-state';
import type { ResizeStart } from './transform-gestures';

/** Where a dragged element started: a shape's corner, or a connector's two ends. */
export type DragOrigin =
  | { kind: 'shape'; x: number; y: number }
  | { kind: 'connector'; start: ConnectorEnd; end: ConnectorEnd };

/**
 * The pointer gesture in progress. Each kind carries what it needs to apply the gesture at
 * a new pointer position (`moveTo`) and to put everything back on Esc (`cancelGesture`).
 */
export type Mode =
  | { kind: 'idle' }
  | {
      kind: 'custom';
      name: string;
      definition: CustomTool;
      /** Elements the tool changed, as they were before it: restored on cancel. */
      before: Map<string, BoardElement | undefined>;
      unsubscribe: () => void;
    }
  | { kind: 'pan'; last: Vec2; lastTime: number; velocityX: number; velocityY: number }
  | {
      kind: 'drag';
      start: Vec2;
      origin: Map<string, DragOrigin>;
      /** Link under the press: opened if the press ends without moving (a click). */
      link: string | null;
      /** Selection to switch to if the press ends without a drag (see `selectionAfterPress`). */
      onClick: Set<string> | null;
      /** Box of the moved elements at the start, and boxes of the others to snap to. */
      box: Box | null;
      targets: Box[];
      /** Past the click slop: from here on the move snaps (a click must not nudge). */
      moved: boolean;
    }
  | { kind: 'marquee'; start: Vec2; base: Set<string> }
  | {
      kind: 'connect';
      id: string;
      which: 'start' | 'end';
      down: Vec2;
      /** null: the connector was created by this gesture (Esc / click removes it). */
      original: ConnectorEnd | null;
      /** Set when the gesture started on a connection dot: a click there quick-creates a shape. */
      fromDot: { shape: string; anchor: Vec2 } | null;
    }
  | { kind: 'bend'; id: string; original: Pick<ConnectorElement, 'route' | 'curve' | 'elbowAt'> }
  | { kind: 'seek'; id: string }
  /** Text tool: pressed on the empty board; a drag sets the width of the new text box. */
  | { kind: 'textbox'; down: Vec2; start: Vec2 }
  /** Sticky / shape tool: a click drops a default element, a drag draws its box. */
  | { kind: 'place'; shape: PlaceKind; down: Vec2; start: Vec2 }
  /**
   * Pen: the stroke being drawn (world points, before simplification). `drawn`: the
   * stabilized pen tip and `pointer`: the real one (screen points); `last`: the last point
   * added. The string between them shortens as the pointer slows down (`speed`).
   */
  | {
      kind: 'ink';
      id: string;
      points: Vec2[];
      last: Vec2;
      drawn: Vec2;
      pointer: Vec2;
      /** Pointer speed (screen px per ms, smoothed) and when the pointer was last seen. */
      speed: number;
      time: number;
    }
  /** Eraser: removes pen strokes the pointer passes over. */
  | { kind: 'erase'; last: Vec2 }
  | { kind: 'volume'; id: string; original: number | undefined }
  /**
   * Crop mode of an image: dragging a side of the crop frame (`resize`), the image inside
   * it (`pan`), or a corner of the image itself (`scale`).
   */
  | {
      kind: 'crop';
      action: CropAction;
      signs: readonly [number, number];
      original: ShapeElement;
      frame: Frame;
      /** Pointer at the start, frame-local. */
      start: Vec2;
    }
  /** A polygon's corner-count handle (Figma): dragged around the center, adds or removes corners. */
  | { kind: 'count'; id: string; original: number | undefined }
  | {
      kind: 'radius';
      id: string;
      /** Requested radius before the drag (restored on Esc). */
      original: number;
      /** Radius drawn when the drag started, and the pointer's position along the corner bisector. */
      startRadius: number;
      startAlong: number;
    }
  | ({ kind: 'resize' } & ResizeStart)
  | {
      kind: 'rotate';
      center: Vec2;
      originals: BoardElement[];
      /** Pointer angle around the center at the start. */
      startAngle: number;
      /** Rotation that Shift snaps to 15° steps (the shape's own for one shape, else 0). */
      base: number;
    };

export type ModeKind = Mode['kind'];
export type ModeOf<K extends ModeKind> = Extract<Mode, { kind: K }>;
export type CropAction = 'resize' | 'pan' | 'scale';

const MOVING_MODES: ReadonlySet<ModeKind> = new Set([
  'drag',
  'connect',
  'marquee',
  'textbox',
  'place',
  'ink',
  'erase',
  'bend',
  'resize',
]);

/** Gestures that follow the pointer to the viewport edge, so the board auto-pans for them. */
export const isMovingMode = (mode: Mode): boolean => MOVING_MODES.has(mode.kind);

/** Gestures after which a one-shot tool returns to select. */
const COMPLETING_MODES: ReadonlySet<ModeKind> = new Set(['custom', 'ink', 'erase', 'connect']);
export const completesTool = (kind: ModeKind): boolean => COMPLETING_MODES.has(kind);
