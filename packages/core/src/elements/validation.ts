import type { ConnectorElement } from '../connectors/types';
import { MAX_LIST_INDENT, type TextBlock } from '../text/text-block';
import { isAllowedLink } from '../text/rich-text';
import { SHAPE_KINDS, type BoardElement, type ShapeElement } from './element';
import { MAX_POLYGON_SIDES, MIN_POLYGON_SIDES } from './shape-geometry';

const SHAPE_KIND_SET = new Set<string>(SHAPE_KINDS);
const ROUTES = new Set<string>(['straight', 'elbow', 'curve']);
const CAPS = new Set<string>(['none', 'arrow', 'triangle', 'circle', 'diamond']);
const DASHES = new Set<string>(['solid', 'dashed', 'dotted']);
const IMAGE_FITS = new Set<string>(['fill', 'fit', 'crop']);
const SIZINGS = new Set<string>(['auto-width', 'auto-height', 'fixed']);
const ALIGNS = new Set<string>(['left', 'center', 'right', 'top', 'middle', 'bottom']);
/** Rounding noise a stored crop may have past the image's edges. */
const CROP_EPSILON = 1e-6;

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const inRange = (value: unknown, minimum: number, maximum: number): boolean =>
  finite(value) && value >= minimum && value <= maximum;

/**
 * Why an element can't be stored, or null if it is fine. Non-finite numbers would make
 * the element invisible to hit testing and break layout, so data coming from the network
 * must be checked before it reaches the scene (`Scene.add/update` do this and throw).
 */
export function validateElement(element: BoardElement): string | null {
  if (!element || typeof element.id !== 'string' || element.id === '')
    return 'id must be a non-empty string';
  if (!finite(element.z)) return 'z must be finite';
  if (
    element.groupId !== undefined &&
    (typeof element.groupId !== 'string' || element.groupId === '')
  )
    return 'groupId must be a non-empty string';
  return element.type === 'connector' ? checkConnector(element) : checkShape(element);
}

function checkConnector(connector: ConnectorElement): string | null {
  if (!ROUTES.has(connector.route)) return `unknown route ${String(connector.route)}`;
  if (!DASHES.has(connector.dash)) return `unknown dash ${String(connector.dash)}`;
  if (!CAPS.has(connector.startCap) || !CAPS.has(connector.endCap)) return 'unknown cap';
  if (!finite(connector.strokeWidth) || connector.strokeWidth < 0)
    return 'strokeWidth must be >= 0';
  if (!finite(connector.stroke)) return 'stroke must be a packed color';
  if (connector.curve && !(finite(connector.curve.along) && finite(connector.curve.across)))
    return 'curve must be finite';
  if (connector.elbowAt !== undefined && !finite(connector.elbowAt))
    return 'elbowAt must be finite';
  if (connector.cornerRadius !== undefined && !inRange(connector.cornerRadius, 0, Infinity))
    return 'cornerRadius must be >= 0';
  return checkEnd(connector.start, 'start') ?? checkEnd(connector.end, 'end');
}

function checkEnd(end: unknown, name: string): string | null {
  const fields = end as {
    kind?: unknown;
    x?: unknown;
    y?: unknown;
    id?: unknown;
    anchor?: unknown;
  };
  if (!fields || typeof fields !== 'object') return `${name} is missing`;
  if (fields.kind === 'point')
    return finite(fields.x) && finite(fields.y) ? null : `${name} point is not finite`;
  if (fields.kind !== 'element' || typeof fields.id !== 'string')
    return `${name} has an invalid kind`;
  const anchor = fields.anchor as { x?: unknown; y?: unknown } | undefined;
  if (anchor !== undefined && !(finite(anchor?.x) && finite(anchor?.y)))
    return `${name} anchor is not finite`;
  return null;
}

function checkShape(shape: ShapeElement): string | null {
  if (!SHAPE_KIND_SET.has(shape.type)) return `unknown type ${String(shape.type)}`;
  for (const key of [
    'x',
    'y',
    'width',
    'height',
    'rotation',
    'radius',
    'strokeWidth',
    'fill',
    'stroke',
  ] as const)
    if (!finite(shape[key])) return `${key} must be finite`;
  if (shape.width < 0 || shape.height < 0) return 'size must be >= 0';
  if (shape.radius < 0) return 'radius must be >= 0';
  if (
    shape.sides !== undefined &&
    !(Number.isInteger(shape.sides) && inRange(shape.sides, MIN_POLYGON_SIDES, MAX_POLYGON_SIDES))
  )
    return `sides must be an integer in ${MIN_POLYGON_SIDES}..${MAX_POLYGON_SIDES}`;
  if (shape.strokeWidth < 0) return 'strokeWidth must be >= 0';
  if (shape.strokeStyle !== undefined && !DASHES.has(shape.strokeStyle))
    return 'unknown strokeStyle';
  if (shape.volume !== undefined && !inRange(shape.volume, 0, 1)) return 'volume must be in 0..1';
  if (shape.text) {
    const problem = checkText(shape.text);
    if (problem) return problem;
  }
  if (shape.media && typeof shape.media.source !== 'string') return 'media.source must be a string';
  if (shape.imageFit !== undefined && !IMAGE_FITS.has(shape.imageFit)) return 'unknown imageFit';
  if (shape.crop !== undefined) {
    const problem = checkCrop(shape.crop);
    if (problem) return problem;
  }
  if (shape.points !== undefined) {
    const points: unknown = shape.points;
    if (!Array.isArray(points) || points.length % 2 !== 0) return 'points must be [u, v, …] pairs';
    for (const value of points as unknown[]) if (!finite(value)) return 'points must be finite';
  }
  if (shape.type === 'ink' && !(shape.points && shape.points.length >= 2))
    return 'ink needs at least one point';
  return null;
}

function checkText(text: TextBlock): string | null {
  if (!Array.isArray(text.runs)) return 'text.runs must be an array';
  if (!finite(text.fontSize) || text.fontSize <= 0) return 'text.fontSize must be > 0';
  if (!finite(text.color)) return 'text.color must be a packed color';
  if (text.sizing !== undefined && !SIZINGS.has(text.sizing)) return 'unknown text.sizing';
  for (const key of ['align', 'verticalAlign'] as const)
    if (!ALIGNS.has(text[key])) return `unknown text.${key}`;
  for (const run of text.runs) {
    if (!run || typeof run.text !== 'string') return 'text run must have text';
    if (run.size !== undefined && !(finite(run.size) && run.size > 0))
      return 'run size must be > 0';
    if (run.color !== undefined && !finite(run.color)) return 'run color must be a packed color';
    if (run.link !== undefined && !(typeof run.link === 'string' && isAllowedLink(run.link)))
      return 'run link must be an http(s) or mailto URL';
  }
  const paragraphs: unknown = text.paragraphs;
  if (paragraphs === undefined) return null;
  if (!Array.isArray(paragraphs)) return 'text.paragraphs must be an array';
  for (const paragraph of paragraphs as Array<{ list?: unknown; indent?: unknown } | null>) {
    if (paragraph === null || typeof paragraph !== 'object')
      return 'paragraph style must be an object';
    if (paragraph.list !== undefined && paragraph.list !== 'bullet' && paragraph.list !== 'ordered')
      return 'unknown list kind';
    if (
      paragraph.indent !== undefined &&
      !(Number.isInteger(paragraph.indent) && inRange(paragraph.indent, 0, MAX_LIST_INDENT))
    )
      return `list indent must be an integer in 0..${MAX_LIST_INDENT}`;
  }
  return null;
}

function checkCrop(crop: NonNullable<ShapeElement['crop']>): string | null {
  if (!crop || !finite(crop.x) || !finite(crop.y) || !finite(crop.width) || !finite(crop.height))
    return 'crop must be finite';
  if (
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x < -CROP_EPSILON ||
    crop.y < -CROP_EPSILON ||
    crop.x + crop.width > 1 + CROP_EPSILON ||
    crop.y + crop.height > 1 + CROP_EPSILON
  )
    return 'crop must be a part of the image (0..1)';
  return null;
}
