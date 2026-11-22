import { HANDLE_RADIUS_PX } from '../overlay/handles';
import type { Tool } from '../tools/tool-state';

// Distances are in screen pixels unless noted: they feel the same at any zoom.

/** Elements are hit this far outside their outline. */
export const HIT_TOLERANCE_PX = 4;
/** Connection dots are grabbable within this radius. */
export const DOT_HIT_PX = 10;
/** Connector end and bend handles are grabbable within this radius. */
export const HANDLE_HIT_PX = HANDLE_RADIUS_PX + 6;
/** Shapes smaller than this on screen don't show connection dots (they'd overlap). */
export const MIN_DOT_SHAPE_PX = 24;
/** Magnet radius of side midpoints; once snapped, released only at `SNAP_RELEASE` times it. */
export const SNAP_PX = 28;
export const SNAP_RELEASE = 1.5;
/** Dropping an end this close to an outline pins it to that exact point. */
export const EDGE_PX = 10;
/** How far outside a shape its connection dots stay visible. */
export const ANCHOR_KEEP_PX = 36;
/** Dragging within this distance of the viewport edge scrolls the board. */
export const AUTOPAN_EDGE_PX = 40;
/** Auto-pan speed at the very edge, screen px per second. */
export const AUTOPAN_MAX_SPEED = 900;
/** Quick-created shapes are placed this far (world units) from the source. */
export const QUICK_GAP = 80;
/** Text tool: a press moved at least this far sideways draws a fixed-width box. */
export const TEXTBOX_DRAG_PX = 6;
/** A press that moved less than this is a click. */
export const CLICK_SLOP_PX = 4;
/** Crop mode: the image's corner handles catch the pointer this close. */
export const IMAGE_HANDLE_HIT_PX = 9;
/** Snapping looks at most this many neighbours (a huge board stays responsive). */
export const MAX_SNAP_TARGETS = 2000;
/** Pen: a new point once the pointer moved this far. */
export const INK_STEP_PX = 1.5;
/** Pen: points closer than this to the simplified line are dropped on release. */
export const INK_SIMPLIFY_PX = 0.6;
/**
 * Pen: the stabilizer's string (see `pullString`) at full speed; longer is smoother but lags
 * more. Slower than INK_FULL_STRING_SPEED (screen px per ms) it shortens, down to nothing
 * when the pointer stops: the line catches up with the pointer before the button is let go.
 */
export const INK_STRING_PX = 8;
export const INK_FULL_STRING_SPEED = 0.6;
/** Pen: how much of a new speed sample goes into the smoothed speed. */
export const INK_SPEED_BLEND = 0.3;
/** Pen: the drawn line is resampled this often and evened out this many times (`relaxStroke`). */
export const INK_RELAX_SPACING_PX = 3;
export const INK_RELAX_PASSES = 6;
/** Eraser radius. */
export const ERASER_PX = 8;
/** Audio player controls are hit this far outside their drawn area. */
export const AUDIO_HIT_PX = 3;
/** A pan released within this many milliseconds of the last move flings the board. */
export const FLING_WINDOW_MS = 80;

/** Single-letter tool shortcuts (Figma/Miro), by physical key so any layout works. */
export const TOOL_KEYS: Readonly<Record<string, Tool | undefined>> = {
  V: 'select',
  H: 'hand',
  S: 'sticky',
  R: 'rect',
  O: 'ellipse',
  T: 'text',
  L: 'connector',
  C: 'comment',
};
export const SHIFT_TOOL_KEYS: Readonly<Record<string, Tool | undefined>> = {
  P: 'pen',
  E: 'eraser',
};
export const SHIFT_ZOOM: Readonly<Record<string, 'reset' | 'fit' | 'selection' | undefined>> = {
  Digit0: 'reset',
  Digit1: 'fit',
  Digit2: 'selection',
};
export const ARROWS: Readonly<Record<string, readonly [number, number] | undefined>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Eraser cursor: a hollow circle the size of the eraser. */
export const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="white" fill-opacity="0.6" stroke="#18181b" stroke-width="1.5"/></svg>',
)}") 10 10, crosshair`;
