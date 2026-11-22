import type { ConnectorElement, LineDash } from '../connectors/types';
import type { Box } from '../geometry/box';
import type { TextBlock } from '../text/text-block';
import type { CropRectangle, ImageFit } from './image-fit';
import type { MediaFile } from './media';
import { polygonSides, polygonTextBox } from './shape-geometry';

/**
 * Every kind of shape.
 * `text` is a frameless text box: drawn like a rect, usually with a transparent fill.
 * `polygon` is a regular polygon with `sides` corners stretched to the box (3 = triangle).
 * `ink` is a freehand pen stroke: a polyline (`points`) in the box, drawn with `stroke`.
 */
export const SHAPE_KINDS = [
  'rect',
  'ellipse',
  'polygon',
  'sticky',
  'text',
  'image',
  'audio',
  'ink',
] as const;

export type ShapeKind = (typeof SHAPE_KINDS)[number];

/**
 * A board element. Plain data: the engine never stores behaviour on elements,
 * so they serialize 1:1 to JSON.
 *
 * Geometry: (x, y) is the top-left corner of the unrotated box,
 * rotation is in radians around the box center.
 */
export interface ShapeElement {
  id: string;
  type: ShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** Paint order. Higher is drawn on top. Fractional values allow inserting between neighbours. */
  z: number;
  /** Packed 0xRRGGBBAA. */
  fill: number;
  /** Packed 0xRRGGBBAA. */
  stroke: number;
  strokeWidth: number;
  /** Border pattern (default solid). Dashes and dots scale with the stroke width. */
  strokeStyle?: LineDash;
  /**
   * Corner radius (world units) of rect, sticky, image and polygon corners; ignored for
   * ellipses. Capped when drawn (see `effectiveRadius`): at the cap a square is a circle.
   */
  radius: number;
  /** Number of corners of a `polygon`, 3..12 (default 3). */
  sides?: number;
  /**
   * Text inside the shape. Keep the object reference unchanged when only geometry changes:
   * renderers cache layouts by it.
   */
  text?: TextBlock;
  /** File behind an `image` or `audio` element. */
  media?: MediaFile;
  /** How an `image` fills its box (default `fill`), see `image-fit.ts`. */
  imageFit?: ImageFit;
  /** Part of the image an `image` in `crop` mode shows. */
  crop?: CropRectangle;
  /** Playback volume of an `audio` element, 0..1. */
  volume?: number;
  /**
   * Polyline of an `ink` stroke: flat [u0, v0, u1, v1, …] as fractions (0..1) of the box,
   * so moving, resizing and rotating the box reshapes the stroke without touching them.
   * Keep the array reference unchanged when only geometry changes.
   */
  points?: readonly number[];
  /**
   * Group the element belongs to (any element with the same id is in it). Grouped
   * elements are selected, moved and transformed together; see `scene/groups.ts`.
   */
  groupId?: string;
}

export type BoardElement = ShapeElement | ConnectorElement;

/**
 * Fields that can be changed with `Scene.update`. `id` and `type` are immutable.
 * Only fields of the element's own kind should be patched.
 */
export type ElementPatch = Partial<Omit<ShapeElement, 'id' | 'type'>> &
  Partial<Omit<ConnectorElement, 'id' | 'type'>>;

export const isShape = (element: BoardElement): element is ShapeElement =>
  element.type !== 'connector';

export const isConnector = (element: BoardElement): element is ConnectorElement =>
  element.type === 'connector';

export const isMedia = (element: BoardElement): element is ShapeElement & { media: MediaFile } =>
  (element.type === 'image' || element.type === 'audio') && 'media' in element && !!element.media;

/** Shapes whose text can be typed into: not images, audio players or pen strokes. */
export const canHoldText = (element: BoardElement | null | undefined): element is ShapeElement =>
  !!element &&
  isShape(element) &&
  element.type !== 'image' &&
  element.type !== 'audio' &&
  element.type !== 'ink';

/** `element` with `patch` applied; its `id` and `type` never change. */
export const patchedElement = (element: BoardElement, patch: ElementPatch): BoardElement =>
  ({ ...element, ...patch, id: element.id, type: element.type }) as BoardElement;

const TEXT_PADDING: Record<ShapeKind, number> = {
  sticky: 16,
  rect: 10,
  ellipse: 6,
  polygon: 6,
  text: 0,
  image: 0,
  audio: 0,
  ink: 0,
};

/**
 * Area available for text, relative to the element's top-left corner (unrotated).
 * Ellipses use the inscribed rectangle, polygons a box that fits inside them.
 */
export function textArea(element: ShapeElement): Box {
  const padding = TEXT_PADDING[element.type] + element.strokeWidth / 2;
  if (element.type === 'polygon') {
    const textBox = polygonTextBox(polygonSides(element));
    const minX = element.width * textBox.left + padding;
    const minY = element.height * textBox.top + padding;
    return {
      minX,
      minY,
      maxX: Math.max(minX, element.width * textBox.right - padding),
      maxY: Math.max(minY, element.height * textBox.bottom - padding),
    };
  }
  let insetX = padding;
  let insetY = padding;
  if (element.type === 'ellipse') {
    const inset = (1 - Math.SQRT1_2) / 2;
    insetX += element.width * inset;
    insetY += element.height * inset;
  }
  return {
    minX: insetX,
    minY: insetY,
    maxX: Math.max(insetX, element.width - insetX),
    maxY: Math.max(insetY, element.height - insetY),
  };
}

/** World-space AABB of a shape, including rotation and stroke. */
export function elementBounds(element: ShapeElement): Box {
  const halfStroke = element.strokeWidth / 2;
  if (element.rotation === 0) {
    return {
      minX: element.x - halfStroke,
      minY: element.y - halfStroke,
      maxX: element.x + element.width + halfStroke,
      maxY: element.y + element.height + halfStroke,
    };
  }
  // Rotated half-extents avoid allocating and rotating four corners on every move.
  const cosine = Math.abs(Math.cos(element.rotation));
  const sine = Math.abs(Math.sin(element.rotation));
  const halfWidth = (element.width * cosine + element.height * sine) / 2 + halfStroke;
  const halfHeight = (element.width * sine + element.height * cosine) / 2 + halfStroke;
  const centerX = element.x + element.width / 2;
  const centerY = element.y + element.height / 2;
  return {
    minX: centerX - halfWidth,
    minY: centerY - halfHeight,
    maxX: centerX + halfWidth,
    maxY: centerY + halfHeight,
  };
}
