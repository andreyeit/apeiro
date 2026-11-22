import type { Box } from '../geometry/box';
import type { Vec2 } from '../geometry/vector';
import type { ConnectorArc } from './rounding';

/** A free end at a world point. */
export interface PointEnd {
  kind: 'point';
  x: number;
  y: number;
}

/** An end attached to a shape. It follows the shape when it moves, resizes or rotates. */
export interface ElementEnd {
  kind: 'element';
  id: string;
  /**
   * Fixed attachment point in the shape's unrotated box, 0..1 on each axis
   * (0.5, 0 = middle of the top side). Omitted: floating, the end slides along the
   * outline to face the other end.
   */
  anchor?: Vec2;
}

export type ConnectorEnd = PointEnd | ElementEnd;
export type ConnectorRoute = 'straight' | 'elbow' | 'curve';
export type CapKind = 'none' | 'arrow' | 'triangle' | 'circle' | 'diamond';
export type LineDash = 'solid' | 'dashed' | 'dotted';

export interface ConnectorElement {
  id: string;
  type: 'connector';
  z: number;
  start: ConnectorEnd;
  end: ConnectorEnd;
  route: ConnectorRoute;
  /** Packed 0xRRGGBBAA. */
  stroke: number;
  strokeWidth: number;
  dash: LineDash;
  startCap: CapKind;
  endCap: CapKind;
  /**
   * Bend of a curve: offset of its midpoint from the automatic curve, in the frame of the
   * chord (start → end) and as a fraction of its length, so the bend keeps its shape when
   * the ends move. Absent: the automatic curve. Used by the `curve` route only.
   */
  curve?: { along: number; across: number };
  /** Where an elbow's middle segment sits between the ends, 0..1 (default 0.5). */
  elbowAt?: number;
  /** Radius of the rounded bends of an `elbow` route, like Miro's (0 or absent: sharp corners). */
  cornerRadius?: number;
  /**
   * Group the element belongs to (any element with the same id is in it). Grouped
   * elements are selected, moved and transformed together; see `scene/groups.ts`.
   */
  groupId?: string;
}

/** Draggable point that changes a connector's shape (see `bendConnector`). */
export interface ConnectorHandle {
  point: Vec2;
  /** `curve`: the line passes through the handle. `elbow`: moves the middle segment along `axis`. */
  kind: 'curve' | 'elbow';
  axis?: 'x' | 'y';
}

export interface ConnectorGeometry {
  /** Polyline from start to end (curves are flattened). At least 2 points. */
  points: Vec2[];
  /** Unit direction the line arrives at each end, pointing outwards (for caps). */
  startDirection: Vec2;
  endDirection: Vec2;
  /** World AABB including stroke and caps. */
  bounds: Box;
  /** Bend handle, or null if this route has none (an L-shaped elbow). */
  handle: ConnectorHandle | null;
  /** True if the elbow was routed around shapes (it may straighten when they move away). */
  routed: boolean;
  /**
   * Elbows: the orthogonal polyline before its bends were rounded (`points` then has arcs).
   * Obstacle checks need the axis-aligned segments.
   */
  path?: Vec2[];
  /** Rounded bends of an elbow, drawn exactly (`points` only approximates them). */
  arcs?: ConnectorArc[];
}

/** Cap length in world units for a stroke width. */
export const capSize = (strokeWidth: number): number => Math.max(10, strokeWidth * 4);
