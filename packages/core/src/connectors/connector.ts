import { elementBounds, type ShapeElement } from '../elements/element';
import { boxOfPoints, inflateBox, type Box } from '../geometry/box';
import { localToWorld, worldToLocal } from '../geometry/frame';
import { distanceToSegment, midpoint, normalize, subtract, type Vec2 } from '../geometry/vector';
import { anchorOf } from './anchors';
import { autoControls, bendPoint, bezierMiddle, chord, curvePoints } from './curve';
import { elbowLayout, elbowPoints, routeCrossesAny, simplify, type ObstacleQuery } from './elbow';
import { clearBorder, isFloating, resolveEnd, resolveEnds } from './ends';
import { projectToOutline, type ResolvedEnd } from './local-geometry';
import { roundCornersWithArcs, type ConnectorArc } from './rounding';
import {
  capSize,
  type ConnectorElement,
  type ConnectorEnd,
  type ConnectorGeometry,
  type ConnectorHandle,
} from './types';

type ShapeLookup = (id: string) => ShapeElement | undefined;

/** The route-specific part of a connector's geometry. */
interface Route {
  points: Vec2[];
  handle: ConnectorHandle | null;
  routed: boolean;
  /** Elbows with rounded bends: the orthogonal polyline before rounding. */
  path?: Vec2[];
  arcs: ConnectorArc[];
}

/**
 * Computes a connector's polyline from its ends. Returns null if an attached shape
 * is missing (e.g. deleted concurrently): such connectors are not drawn.
 */
export function resolveConnector(
  connector: ConnectorElement,
  getShape: ShapeLookup,
  /** Other shapes to route elbows around; without it only the connected shapes are avoided. */
  findObstacles?: ObstacleQuery,
): ConnectorGeometry | null {
  const ends = resolveEnds(connector, getShape);
  if (!ends) return null;
  const [start, end] = ends;
  const route =
    connector.route === 'elbow'
      ? elbowRoute(connector, start, end, getShape, findObstacles)
      : connector.route === 'curve'
        ? curveRoute(connector, start, end, getShape)
        : straightRoute(start, end);
  const { points, handle, routed, path, arcs } = route;

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const hasCaps = connector.startCap !== 'none' || connector.endCap !== 'none';
  const margin = Math.max(connector.strokeWidth / 2, hasCaps ? capSize(connector.strokeWidth) : 0);
  return {
    points,
    startDirection: normalize(subtract(first, points[1]!)),
    endDirection: normalize(subtract(last, points[points.length - 2]!)),
    bounds: inflateBox(boxOfPoints(points), margin),
    handle,
    routed,
    ...(path ? { path } : {}),
    ...(arcs.length > 0 ? { arcs } : {}),
  };
}

function elbowRoute(
  connector: ConnectorElement,
  start: ResolvedEnd,
  end: ResolvedEnd,
  getShape: ShapeLookup,
  findObstacles: ObstacleQuery | undefined,
): Route {
  const boxOf = (connectorEnd: ConnectorEnd) => {
    const shape = connectorEnd.kind === 'element' ? getShape(connectorEnd.id) : undefined;
    return shape && elementBounds(shape);
  };
  const elbow = elbowPoints(
    start,
    end,
    connector.elbowAt,
    boxOf(connector.start),
    boxOf(connector.end),
    findObstacles,
  );
  const radius = connector.cornerRadius ?? 0;
  if (radius <= 0) return { ...elbow, arcs: [] };
  const rounded = roundCornersWithArcs(elbow.points, radius);
  return { ...elbow, points: rounded.points, path: elbow.points, arcs: rounded.arcs };
}

function curveRoute(
  connector: ConnectorElement,
  start: ResolvedEnd,
  end: ResolvedEnd,
  getShape: ShapeLookup,
): Route {
  if (!connector.curve) {
    return {
      points: curvePoints(start, end),
      handle: { point: bendPoint(start, end), kind: 'curve' },
      routed: false,
      arcs: [],
    };
  }
  // The bend point is defined against the unbent ends; then floating ends slide
  // along their outlines to face it, so the line bulges as one smooth arc.
  const bend = bendPoint(start, end, connector.curve);
  const slide = (connectorEnd: ConnectorEnd, fallback: ResolvedEnd) => {
    if (!isFloating(connectorEnd)) return fallback;
    const resolved = resolveEnd(connectorEnd, bend, 'curve', getShape);
    return resolved ? clearBorder(connector, connectorEnd, resolved, getShape) : fallback;
  };
  return {
    points: curvePoints(slide(connector.start, start), slide(connector.end, end), bend),
    handle: { point: bend, kind: 'curve' },
    routed: false,
    arcs: [],
  };
}

function straightRoute(start: ResolvedEnd, end: ResolvedEnd): Route {
  return {
    points: simplify([start.point, end.point]),
    // Dragging the middle of a straight line turns it into a curve.
    handle: { point: midpoint(start.point, end.point), kind: 'curve' },
    routed: false,
    arcs: [],
  };
}

/** Whether a resolved connector's line runs through a box (e.g. a shape that just moved). */
export function connectorCrossesBox(geometry: ConnectorGeometry, box: Box): boolean {
  return routeCrossesAny(geometry.path ?? geometry.points, [box]);
}

/**
 * Patch that reshapes a connector so its bend handle is at `world`:
 * curves (and straight lines, which become curves) pass through the point,
 * elbows move their middle segment. Returns null if the route has no handle.
 */
export function bendConnector(
  connector: ConnectorElement,
  world: Vec2,
  getShape: ShapeLookup,
): Partial<Pick<ConnectorElement, 'route' | 'curve' | 'elbowAt'>> | null {
  const route = connector.route === 'straight' ? 'curve' : connector.route;
  const ends = resolveEnds({ ...connector, route }, getShape);
  if (!ends) return null;
  const [start, end] = ends;
  if (route === 'curve') {
    const [startControl, endControl] = autoControls(start, end);
    const middle = bezierMiddle(start.point, startControl, endControl, end.point);
    const { tangent, normal, length } = chord(start, end);
    const offset = subtract(world, middle);
    return {
      route,
      curve: {
        along: (offset.x * tangent.x + offset.y * tangent.y) / length,
        across: (offset.x * normal.x + offset.y * normal.y) / length,
      },
    };
  }
  const { bend } = elbowLayout(start, end, connector.elbowAt);
  if (!bend || Math.abs(bend.to - bend.from) < 1e-6) return null;
  const at = (world[bend.axis] - bend.from) / (bend.to - bend.from);
  return { elbowAt: Math.min(4, Math.max(-3, at)) };
}

/** Patch that removes a manual bend. */
export const resetBend = (): Pick<ConnectorElement, 'curve' | 'elbowAt'> => ({
  curve: undefined,
  elbowAt: undefined,
});

/** Patch that swaps start and end (caps stay, so arrows point the other way); the bend keeps its shape. */
export function reverseConnector(
  connector: ConnectorElement,
): Pick<ConnectorElement, 'start' | 'end' | 'curve' | 'elbowAt'> {
  return {
    start: connector.end,
    end: connector.start,
    curve: connector.curve && { along: -connector.curve.along, across: -connector.curve.across },
    elbowAt: connector.elbowAt === undefined ? undefined : 1 - connector.elbowAt,
  };
}

/** Distance from a point to the connector's line (not counting stroke width). */
export function distanceToConnector(geometry: ConnectorGeometry, point: Vec2): number {
  let best = Infinity;
  for (let index = 0; index + 1 < geometry.points.length; index++) {
    best = Math.min(
      best,
      distanceToSegment(point, geometry.points[index]!, geometry.points[index + 1]!),
    );
  }
  return best;
}

export function hitTestConnector(
  connector: ConnectorElement,
  geometry: ConnectorGeometry,
  point: Vec2,
  tolerance = 0,
): boolean {
  if (distanceToConnector(geometry, point) <= connector.strokeWidth / 2 + tolerance) return true;
  // Caps are wider than the line: count clicks inside their box too.
  const size = capSize(connector.strokeWidth);
  const inCap = (tip: Vec2, direction: Vec2) => {
    const deltaX = point.x - tip.x;
    const deltaY = point.y - tip.y;
    const back = -(deltaX * direction.x + deltaY * direction.y); // distance behind the tip
    const side = Math.abs(deltaX * direction.y - deltaY * direction.x);
    return back >= -tolerance && back <= size + tolerance && side <= size / 2 + tolerance;
  };
  if (connector.startCap !== 'none' && inCap(geometry.points[0]!, geometry.startDirection))
    return true;
  return (
    connector.endCap !== 'none' &&
    inCap(geometry.points[geometry.points.length - 1]!, geometry.endDirection)
  );
}

/** Ids of shapes a connector is attached to. */
export function attachedIds(connector: ConnectorElement): string[] {
  const ids: string[] = [];
  if (connector.start.kind === 'element') ids.push(connector.start.id);
  if (
    connector.end.kind === 'element' &&
    !(connector.start.kind === 'element' && connector.start.id === connector.end.id)
  )
    ids.push(connector.end.id);
  return ids;
}

/**
 * The connector with every end attached to a shape that `keep` rejects turned into a free
 * end where it is drawn now, so the line looks the same without that shape (a copy or an
 * export of part of the board). `geometry` is its current geometry (null: ends stay).
 */
export function detachEnds(
  connector: ConnectorElement,
  geometry: ConnectorGeometry | null,
  keep: (shapeId: string) => boolean,
): ConnectorElement {
  const free = (end: ConnectorEnd, at: Vec2 | undefined): ConnectorEnd =>
    end.kind === 'element' && !keep(end.id) && at ? { kind: 'point', x: at.x, y: at.y } : end;
  const start = free(connector.start, geometry?.points[0]);
  const end = free(connector.end, geometry?.points[geometry.points.length - 1]);
  return start === connector.start && end === connector.end
    ? connector
    : { ...connector, start, end };
}

/**
 * Turns floating ends into fixed anchors at the outline points they resolve to right now.
 * The line doesn't change, but from then on its ends stay put on the shapes instead of
 * sliding along the outline when shapes move or the line is bent.
 * Returns null if nothing is floating (or the connector can't be resolved).
 */
export function freezeConnectorEnds(
  connector: ConnectorElement,
  getShape: ShapeLookup,
): Pick<ConnectorElement, 'start' | 'end'> | null {
  if (!isFloating(connector.start) && !isFloating(connector.end)) return null;
  const geometry = resolveConnector(connector, getShape);
  if (!geometry) return null;
  const freeze = (end: ConnectorEnd, at: Vec2): ConnectorEnd => {
    if (end.kind !== 'element' || end.anchor) return end;
    const shape = getShape(end.id);
    if (!shape) return end;
    // The end sits just outside the border: anchor at the outline point under it.
    const local = projectToOutline(shape, worldToLocal(shape, at));
    return { kind: 'element', id: end.id, anchor: anchorOf(shape, localToWorld(shape, local)) };
  };
  return {
    start: freeze(connector.start, geometry.points[0]!),
    end: freeze(connector.end, geometry.points[geometry.points.length - 1]!),
  };
}

/** The same geometry moved by (`deltaX`, `deltaY`). */
export function translateGeometry(
  geometry: ConnectorGeometry,
  deltaX: number,
  deltaY: number,
): ConnectorGeometry {
  const move = (point: Vec2): Vec2 => ({ x: point.x + deltaX, y: point.y + deltaY });
  const { bounds, handle, path, arcs } = geometry;
  return {
    ...geometry,
    points: geometry.points.map(move),
    bounds: {
      minX: bounds.minX + deltaX,
      minY: bounds.minY + deltaY,
      maxX: bounds.maxX + deltaX,
      maxY: bounds.maxY + deltaY,
    },
    handle: handle && { ...handle, point: move(handle.point) },
    ...(path ? { path: path.map(move) } : {}),
    ...(arcs
      ? {
          arcs: arcs.map((arc) => ({
            ...arc,
            centerX: arc.centerX + deltaX,
            centerY: arc.centerY + deltaY,
          })),
        }
      : {}),
  };
}
