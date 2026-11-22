import type { ShapeElement } from './element';
import type { Vec2 } from '../geometry/vector';

/**
 * Outline geometry of shapes in their local frame: centered at the box center, unrotated,
 * y down. Shared by hit testing, connector attachment and overlays. The fragment shader
 * (`shaders.ts`) implements the same formulas, so what you click is what is drawn.
 *
 * Corner rounding works like in Figma: every corner of a rect or polygon is replaced by
 * a circular arc of the given radius, tangent to both edges. The radius is capped where
 * the arcs meet, so a square at the maximum radius is a circle, a regular polygon its
 * incircle.
 */

export const MIN_POLYGON_SIDES = 3;
export const MAX_POLYGON_SIDES = 12;
/** Keeps the eroded polygon from degenerating to a point at the maximum radius. */
const RADIUS_CAP = 0.999;

/** Shapes whose corners can be rounded by the user. */
export const hasCornerRadius = (element: ShapeElement): boolean =>
  element.type === 'rect' || element.type === 'polygon' || element.type === 'image';

export const polygonSides = (element: Pick<ShapeElement, 'sides'>): number =>
  Math.min(MAX_POLYGON_SIDES, Math.max(MIN_POLYGON_SIDES, Math.round(element.sides ?? 3)));

/** A regular polygon's outline in its local frame, with what distance queries and rounding need. */
interface PolygonOutline {
  vertices: readonly Vec2[];
  /** Outward unit normal of each edge (vertex i → vertex i + 1). */
  normals: readonly Vec2[];
  /** Largest corner radius before the arcs of two corners meet on some edge. */
  maxRadius: number;
  /** The vertices moved in for each corner radius asked for (see `roundedPolygonSdf`). */
  eroded: Map<number, readonly Vec2[]>;
}

/**
 * Outlines by size and corner count. Hit tests, connector ends and overlays ask for the same
 * polygon many times per pointer move; building it each time dominated dragging.
 */
const outlines = new Map<string, PolygonOutline>();
const OUTLINE_CACHE_SIZE = 256;
/** Corner radii kept per outline (a radius handle drag asks for a new one each move). */
const ERODED_CACHE_SIZE = 8;

/** Adds to a bounded cache, dropping its oldest entry when full. */
function remember<Key, Value>(
  cache: Map<Key, Value>,
  limit: number,
  key: Key,
  value: Value,
): Value {
  if (cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

/** The outline asked for last: distance searches ask for one shape many times in a row. */
let lastOutline: { width: number; height: number; sides: number; outline: PolygonOutline } | null =
  null;

function polygonOutline(width: number, height: number, sides: number): PolygonOutline {
  const last = lastOutline;
  if (last && last.width === width && last.height === height && last.sides === sides)
    return last.outline;
  const outline = cachedOutline(width, height, sides);
  lastOutline = { width, height, sides, outline };
  return outline;
}

function cachedOutline(width: number, height: number, sides: number): PolygonOutline {
  const key = `${width}|${height}|${sides}`;
  const cached = outlines.get(key);
  if (cached) return cached;
  const vertices = regularPolygon(width, height, sides);
  const normals = edgeNormals(vertices);
  return remember(outlines, OUTLINE_CACHE_SIZE, key, {
    vertices,
    normals,
    maxRadius: polygonMaxRadius(vertices, cornerCuts(normals)),
    eroded: new Map(),
  });
}

/**
 * Vertices of a regular polygon with `sides` corners, the first one at the top, clockwise
 * on screen, stretched so that the polygon's bounding box is exactly the `width` × `height` box
 * (a triangle has its apex at the top middle and its base on the bottom edge). Shared: don't
 * modify the array.
 */
export function polygonVertices(width: number, height: number, sides: number): readonly Vec2[] {
  return polygonOutline(width, height, sides).vertices;
}

function regularPolygon(width: number, height: number, sides: number): Vec2[] {
  const unit: Vec2[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < sides; index++) {
    const angle = (2 * Math.PI * index) / sides;
    const vertex = { x: Math.sin(angle), y: -Math.cos(angle) };
    unit.push(vertex);
    minX = Math.min(minX, vertex.x);
    minY = Math.min(minY, vertex.y);
    maxX = Math.max(maxX, vertex.x);
    maxY = Math.max(maxY, vertex.y);
  }
  const scaleX = width / (maxX - minX);
  const scaleY = height / (maxY - minY);
  const middleX = (minX + maxX) / 2;
  const middleY = (minY + maxY) / 2;
  return unit.map((point) => ({
    x: (point.x - middleX) * scaleX,
    y: (point.y - middleY) * scaleY,
  }));
}

/** Outward unit normal of each edge (vertex i → vertex i + 1) of clockwise-on-screen vertices. */
function edgeNormals(vertices: readonly Vec2[]): Vec2[] {
  return vertices.map((point, index) => {
    const next = vertices[(index + 1) % vertices.length]!;
    const edgeX = next.x - point.x;
    const edgeY = next.y - point.y;
    const length = Math.hypot(edgeX, edgeY) || 1;
    return { x: edgeY / length, y: -edgeX / length };
  });
}

/** For each vertex: how much a rounding of radius 1 eats into each adjacent edge (cot of half the angle). */
function cornerCuts(normals: readonly Vec2[]): number[] {
  const count = normals.length;
  return normals.map((current, index) => {
    const previous = normals[(index + count - 1) % count]!;
    const cross = Math.abs(previous.x * current.y - previous.y * current.x);
    return cross / (1 + previous.x * current.x + previous.y * current.y);
  });
}

/** Largest corner radius before the arcs of two corners meet on some edge. */
function polygonMaxRadius(vertices: readonly Vec2[], cuts: readonly number[]): number {
  let maximum = Infinity;
  for (let index = 0; index < vertices.length; index++) {
    const next = (index + 1) % vertices.length;
    const length = Math.hypot(
      vertices[next]!.x - vertices[index]!.x,
      vertices[next]!.y - vertices[index]!.y,
    );
    const cutSum = cuts[index]! + cuts[next]!;
    if (cutSum > 0) maximum = Math.min(maximum, length / cutSum);
  }
  return Number.isFinite(maximum) ? maximum * RADIUS_CAP : 0;
}

/** Largest useful corner radius of a shape (a square at this radius is a circle). */
export function maxCornerRadius(element: ShapeElement): number {
  if (element.type === 'ellipse' || element.type === 'audio') return 0;
  if (element.type === 'polygon')
    return polygonOutline(element.width, element.height, polygonSides(element)).maxRadius;
  return Math.min(element.width, element.height) / 2;
}

/** Radius actually drawn: the requested one, capped by the shape's size. */
export function effectiveRadius(element: ShapeElement): number {
  if (element.type === 'ellipse' || element.type === 'audio') return 0;
  return Math.max(0, Math.min(element.radius, maxCornerRadius(element)));
}

/** Exact signed distance to a polygon (negative inside); after Inigo Quilez. */
function polygonSdf(point: Vec2, vertices: readonly Vec2[]): number {
  let distanceSquared = (point.x - vertices[0]!.x) ** 2 + (point.y - vertices[0]!.y) ** 2;
  let sign = 1;
  for (
    let index = 0, previous = vertices.length - 1;
    index < vertices.length;
    previous = index, index++
  ) {
    const vertex = vertices[index]!;
    const previousVertex = vertices[previous]!;
    const edgeX = previousVertex.x - vertex.x;
    const edgeY = previousVertex.y - vertex.y;
    const offsetX = point.x - vertex.x;
    const offsetY = point.y - vertex.y;
    const edgeLengthSquared = edgeX * edgeX + edgeY * edgeY;
    const fraction =
      edgeLengthSquared > 0
        ? Math.max(0, Math.min(1, (offsetX * edgeX + offsetY * edgeY) / edgeLengthSquared))
        : 0;
    const closestX = offsetX - edgeX * fraction;
    const closestY = offsetY - edgeY * fraction;
    distanceSquared = Math.min(distanceSquared, closestX * closestX + closestY * closestY);
    const aboveStart = point.y >= vertex.y;
    const belowEnd = point.y < previousVertex.y;
    const leftOfEdge = edgeX * offsetY > edgeY * offsetX;
    if ((aboveStart && belowEnd && leftOfEdge) || (!aboveStart && !belowEnd && !leftOfEdge))
      sign = -sign;
  }
  return sign * Math.sqrt(distanceSquared);
}

/** The outline's vertices moved in so that each corner's arc of `radius` fits. */
function erodedVertices(outline: PolygonOutline, radius: number): readonly Vec2[] {
  const cached = outline.eroded.get(radius);
  if (cached) return cached;
  const { vertices, normals } = outline;
  const count = vertices.length;
  const eroded = vertices.map((vertex, index) => {
    const previousNormal = normals[(index + count - 1) % count]!;
    const normal = normals[index]!;
    const miter = radius / (1 + previousNormal.x * normal.x + previousNormal.y * normal.y);
    return {
      x: vertex.x - (previousNormal.x + normal.x) * miter,
      y: vertex.y - (previousNormal.y + normal.y) * miter,
    };
  });
  return remember(outline.eroded, ERODED_CACHE_SIZE, radius, eroded);
}

/** Polygon with every corner rounded by `radius`: the polygon shrunk by it, then grown back. */
function roundedPolygonSdf(point: Vec2, outline: PolygonOutline, radius: number): number {
  if (radius <= 0) return polygonSdf(point, outline.vertices);
  return polygonSdf(point, erodedVertices(outline, radius)) - radius;
}

/** Signed distance from a local point to the shape's outline (negative inside, stroke ignored). */
export function shapeSdf(element: ShapeElement, point: Vec2): number {
  const halfWidth = element.width / 2;
  const halfHeight = element.height / 2;
  if (element.type === 'ellipse') {
    // Same approximation as the shader: exact on the axes, good near the outline.
    const gradientLength = Math.hypot(
      point.x / (halfWidth * halfWidth || 1e-9),
      point.y / (halfHeight * halfHeight || 1e-9),
    );
    if (gradientLength < 1e-9) return -Math.min(halfWidth, halfHeight);
    const scaledLength = Math.hypot(point.x / (halfWidth || 1e-9), point.y / (halfHeight || 1e-9));
    return (scaledLength * (scaledLength - 1)) / gradientLength;
  }
  const radius = effectiveRadius(element);
  if (element.type === 'polygon') {
    const outline = polygonOutline(element.width, element.height, polygonSides(element));
    return roundedPolygonSdf(point, outline, radius);
  }
  const cornerX = Math.abs(point.x) - (halfWidth - radius);
  const cornerY = Math.abs(point.y) - (halfHeight - radius);
  return (
    Math.hypot(Math.max(cornerX, 0), Math.max(cornerY, 0)) +
    Math.min(Math.max(cornerX, cornerY), 0) -
    radius
  );
}

/** True when the outline isn't the plain box (or ellipse): attachment points must follow it. */
export const hasCustomOutline = (element: ShapeElement): boolean =>
  element.type === 'polygon' || (element.type !== 'ellipse' && effectiveRadius(element) > 0);

/** Outward unit normal of the outline near a local point (gradient of the distance). */
export function outlineNormal(element: ShapeElement, point: Vec2): Vec2 {
  const epsilon = Math.max(element.width, element.height, 1) * 1e-4;
  const gradientX =
    shapeSdf(element, { x: point.x + epsilon, y: point.y }) -
    shapeSdf(element, { x: point.x - epsilon, y: point.y });
  const gradientY =
    shapeSdf(element, { x: point.x, y: point.y + epsilon }) -
    shapeSdf(element, { x: point.x, y: point.y - epsilon });
  const length = Math.hypot(gradientX, gradientY);
  return length > 1e-12 ? { x: gradientX / length, y: gradientY / length } : { x: 1, y: 0 };
}

/** Where a ray from the center along local `direction` leaves the outline. */
export function outlineAlongRay(element: ShapeElement, direction: Vec2): Vec2 {
  const length = Math.hypot(direction.x, direction.y) || 1;
  const unitX = direction.x / length;
  const unitY = direction.y / length;
  let low = 0;
  let high = Math.hypot(element.width, element.height) / 2 + 1;
  if (shapeSdf(element, { x: 0, y: 0 }) >= 0) return { x: unitX * high, y: unitY * high }; // degenerate shape
  for (let iteration = 0; iteration < 40; iteration++) {
    const middle = (low + high) / 2;
    if (shapeSdf(element, { x: unitX * middle, y: unitY * middle }) < 0) low = middle;
    else high = middle;
  }
  const halfway = (low + high) / 2;
  return { x: unitX * halfway, y: unitY * halfway };
}

/** Closest outline point to a local point. */
export function closestOutlinePoint(element: ShapeElement, point: Vec2): Vec2 {
  let probe = point;
  for (let iteration = 0; iteration < 6; iteration++) {
    const distance = shapeSdf(element, probe);
    if (Math.abs(distance) < 1e-9) break;
    const normal = outlineNormal(element, probe);
    probe = { x: probe.x - normal.x * distance, y: probe.y - normal.y * distance };
  }
  return probe;
}

/**
 * The corner whose rounding the on-canvas handle controls (top-left for boxes, the top
 * vertex for polygons), in local coordinates: the vertex, the unit bisector pointing into
 * the shape, and sin of half the corner angle (the arc center is radius / sinHalf away from the vertex).
 */
export function radiusCorner(element: ShapeElement): {
  vertex: Vec2;
  inward: Vec2;
  sinHalf: number;
} {
  if (element.type === 'polygon') {
    const { vertices, normals } = polygonOutline(
      element.width,
      element.height,
      polygonSides(element),
    );
    const lastNormal = normals[normals.length - 1]!;
    const firstNormal = normals[0]!;
    const bisectorX = -(lastNormal.x + firstNormal.x);
    const bisectorY = -(lastNormal.y + firstNormal.y);
    const length = Math.hypot(bisectorX, bisectorY) || 1;
    const dot = lastNormal.x * firstNormal.x + lastNormal.y * firstNormal.y;
    return {
      vertex: vertices[0]!,
      inward: { x: bisectorX / length, y: bisectorY / length },
      sinHalf: Math.sqrt((1 + dot) / 2),
    };
  }
  return {
    vertex: { x: -element.width / 2, y: -element.height / 2 },
    inward: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
    sinHalf: Math.SQRT1_2,
  };
}

/**
 * Local position of the radius handle: the center of the corner arc, but never closer to
 * the vertex than `minOffset` (so it can be grabbed at radius 0, like in Figma).
 */
export function radiusHandleLocal(element: ShapeElement, minOffset: number): Vec2 {
  const corner = radiusCorner(element);
  const offset = Math.max(effectiveRadius(element) / corner.sinHalf, minOffset);
  return {
    x: corner.vertex.x + corner.inward.x * offset,
    y: corner.vertex.y + corner.inward.y * offset,
  };
}

/** Radius for a handle dragged by `along` local units toward the inside from where it was grabbed. */
export function radiusAfterDrag(element: ShapeElement, startRadius: number, along: number): number {
  const corner = radiusCorner(element);
  return Math.max(0, Math.min(maxCornerRadius(element), startRadius + along * corner.sinHalf));
}

/** Sides of a box as fractions (0..1) of another box. */
export interface FractionBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Text box inside a polygon, as fractions of the shape's box. */
export function polygonTextBox(sides: number): FractionBox {
  if (sides === 3) return { left: 0.25, top: 0.45, right: 0.75, bottom: 0.92 };
  if (sides === 4) return { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 };
  const inset = (1 - Math.SQRT1_2) / 2;
  return { left: inset, top: inset, right: 1 - inset, bottom: 1 - inset };
}
