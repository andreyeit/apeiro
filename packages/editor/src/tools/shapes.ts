import {
  newId,
  hexColor,
  type Scene,
  type ShapeElement,
  type ShapeKind,
  type Vec2,
  type LineDash,
} from '@apeiro/core';

/** What the "add shape" buttons create. */
export interface ShapePreset {
  type: Extract<ShapeKind, 'rect' | 'ellipse' | 'polygon'>;
  width: number;
  height: number;
  sides?: number;
  fill: number;
  stroke: number;
  strokeWidth: number;
  strokeStyle?: LineDash;
  radius: number;
}

/**
 * Size of a new sticky note (as in Miro) and of a new shape's box: shapes come as big as
 * stickies.
 * Polygons fit in the same square, keeping their own proportions.
 */
export const ELEMENT_SIZE = 180;

/** Corner radius of a new sticky note and of new rectangles and polygons: all alike. */
export const CORNER_RADIUS = 8;

/**
 * New shapes look like the design's Canvas Block: white (color/background), a 1.5px border
 * in color/foreground; rectangles are squares (as big as the circle). Corners, polygons'
 * too, are rounded by radius/sm (CORNER_RADIUS).
 */
const BLOCK = { fill: hexColor('#ffffff'), stroke: hexColor('#18181b'), strokeWidth: 1.5 };

export const SHAPE_PRESETS = {
  rect: {
    type: 'rect',
    width: ELEMENT_SIZE,
    height: ELEMENT_SIZE,
    radius: CORNER_RADIUS,
    ...BLOCK,
  },
  ellipse: { type: 'ellipse', width: ELEMENT_SIZE, height: ELEMENT_SIZE, radius: 0, ...BLOCK },
  // Equilateral: as tall as √3/2 of its width.
  triangle: {
    type: 'polygon',
    sides: 3,
    width: ELEMENT_SIZE,
    height: Math.round((ELEMENT_SIZE * Math.sqrt(3)) / 2),
    radius: CORNER_RADIUS,
    ...BLOCK,
  },
  // Regular pentagon: 0.951 as tall as wide.
  polygon: {
    type: 'polygon',
    sides: 5,
    width: ELEMENT_SIZE,
    height: Math.round(ELEMENT_SIZE * 0.951),
    radius: CORNER_RADIUS,
    ...BLOCK,
  },
} satisfies Record<string, ShapePreset>;

/** A new shape centered at `center`, above everything else. */
export function createShape(scene: Scene, preset: ShapePreset, center: Vec2): ShapeElement {
  const element: ShapeElement = {
    id: newId('s'),
    type: preset.type,
    x: center.x - preset.width / 2,
    y: center.y - preset.height / 2,
    width: preset.width,
    height: preset.height,
    rotation: 0,
    z: scene.maxZ() + 1,
    fill: preset.fill,
    stroke: preset.stroke,
    strokeWidth: preset.strokeWidth,
    ...(preset.strokeStyle !== undefined ? { strokeStyle: preset.strokeStyle } : {}),
    radius: preset.radius,
    ...(preset.sides !== undefined ? { sides: preset.sides } : {}),
  };
  scene.add(element);
  return element;
}
