import { describe, expect, test } from 'vitest';
import {
  anchorAt,
  anchorOf,
  anchorPoint,
  attachedIds,
  bendConnector,
  detachEnds,
  distanceToConnector,
  freezeConnectorEnds,
  hitTestConnector,
  resolveConnector,
  reverseConnector,
  roundCornersWithArcs,
  type ConnectorElement,
  type ShapeElement,
} from '../index';
import { routeOrthogonal } from './orthogonal-router';
import { makeRectangle } from '../test-utils';

const shapes = new Map<string, ShapeElement>([
  ['a', makeRectangle('a', { x: 0, y: 0 })],
  ['b', makeRectangle('b', { x: 300, y: 0 })],
  ['below', makeRectangle('below', { x: 300, y: 300 })],
]);
const getShape = (id: string) => shapes.get(id);

const connector = (patch: Partial<ConnectorElement> = {}): ConnectorElement => ({
  id: 'c',
  type: 'connector',
  z: 1,
  start: { kind: 'element', id: 'a' },
  end: { kind: 'element', id: 'b' },
  route: 'straight',
  stroke: 0x000000ff,
  strokeWidth: 2,
  dash: 'solid',
  startCap: 'none',
  endCap: 'arrow',
  ...patch,
});

const isOrthogonal = (points: { x: number; y: number }[]) =>
  points.every(
    (point, i) =>
      i === 0 ||
      Math.abs(point.x - points[i - 1]!.x) < 1e-6 ||
      Math.abs(point.y - points[i - 1]!.y) < 1e-6,
  );

describe('resolveConnector', () => {
  test('a straight line between facing sides', () => {
    const geometry = resolveConnector(connector(), getShape)!;
    expect(geometry.points).toHaveLength(2);
    const [start, end] = geometry.points;
    // Moved out of the shapes by half the line width (they have no border).
    expect(start!.x).toBeCloseTo(101);
    expect(start!.y).toBeCloseTo(50);
    expect(end!.x).toBeCloseTo(299, 0);
    expect(geometry.endDirection).toEqual({ x: 1, y: 0 });
    expect(geometry.handle?.kind).toBe('curve');
    expect(geometry.bounds.maxX).toBeGreaterThan(299);
  });

  test('missing shapes are not drawn', () => {
    expect(resolveConnector(connector({ end: { kind: 'element', id: 'x' } }), getShape)).toBeNull();
  });

  test('elbow routes are orthogonal and leave along the side normals', () => {
    const geometry = resolveConnector(
      connector({ route: 'elbow', end: { kind: 'element', id: 'below' } }),
      getShape,
    )!;
    expect(isOrthogonal(geometry.points)).toBe(true);
    expect(geometry.routed).toBe(false);
    const rounded = resolveConnector(
      connector({ route: 'elbow', end: { kind: 'element', id: 'below' }, cornerRadius: 8 }),
      getShape,
    )!;
    expect(rounded.arcs?.length).toBeGreaterThan(0);
    expect(isOrthogonal(rounded.path!)).toBe(true);
  });

  test('elbow routes go around obstacles', () => {
    const wall = { minX: 150, minY: -200, maxX: 200, maxY: 300 };
    const geometry = resolveConnector(connector({ route: 'elbow' }), getShape, (area) =>
      area.maxX >= wall.minX && area.minX <= wall.maxX ? [wall] : [],
    )!;
    expect(geometry.routed).toBe(true);
    expect(isOrthogonal(geometry.points)).toBe(true);
  });

  test('curves bend through the handle', () => {
    const line = connector({ route: 'curve' });
    const patch = bendConnector(line, { x: 200, y: 200 }, getShape)!;
    expect(patch.route).toBe('curve');
    const bent = resolveConnector({ ...line, ...patch }, getShape)!;
    expect(bent.handle!.point.x).toBeCloseTo(200);
    expect(bent.handle!.point.y).toBeCloseTo(200);
    expect(bent.points.length).toBeGreaterThan(10);
  });

  test('reversing swaps the ends and mirrors the bend', () => {
    const reversed = reverseConnector(
      connector({ curve: { along: 0.1, across: 0.2 }, elbowAt: 0.3 }),
    );
    expect(reversed.start).toEqual({ kind: 'element', id: 'b' });
    expect(reversed.curve).toEqual({ along: -0.1, across: -0.2 });
    expect(reversed.elbowAt).toBeCloseTo(0.7);
  });

  test('hit testing the line and its caps', () => {
    const line = connector();
    const geometry = resolveConnector(line, getShape)!;
    expect(hitTestConnector(line, geometry, { x: 200, y: 50 })).toBe(true);
    expect(hitTestConnector(line, geometry, { x: 200, y: 70 })).toBe(false);
    expect(hitTestConnector(line, geometry, { x: 293, y: 53 })).toBe(true);
    expect(distanceToConnector(geometry, { x: 200, y: 60 })).toBeCloseTo(10);
    expect(attachedIds(line)).toEqual(['a', 'b']);
    expect(attachedIds(connector({ end: { kind: 'element', id: 'a' } }))).toEqual(['a']);
  });

  test('freezing floating ends keeps the line', () => {
    const line = connector();
    const before = resolveConnector(line, getShape)!;
    const frozen = freezeConnectorEnds(line, getShape)!;
    expect(frozen.start).toMatchObject({ kind: 'element', id: 'a', anchor: { x: 1, y: 0.5 } });
    const after = resolveConnector({ ...line, ...frozen }, getShape)!;
    expect(after.points[0]!.x).toBeCloseTo(before.points[0]!.x);
    expect(freezeConnectorEnds({ ...line, ...frozen }, getShape)).toBeNull();
  });
});

describe('anchors', () => {
  test('side midpoints act as magnets', () => {
    const shape = shapes.get('a')!;
    expect(anchorAt(shape, { x: 104, y: 60 }, 10)).toEqual({ x: 1, y: 0.5 });
    expect(anchorAt(shape, { x: 50, y: 50 }, 10)).toBeUndefined();
    expect(anchorAt(shape, { x: 2, y: 20 }, 1, 5)).toEqual({ x: 0, y: 0.2 });
    expect(anchorOf(shape, { x: 100, y: 25 })).toEqual({ x: 1, y: 0.25 });
    expect(anchorPoint(shape, { x: 0.5, y: 1 })).toEqual({ x: 50, y: 100 });
  });
});

describe('rounding and routing', () => {
  test('rounds every bend with an arc that fits its segments', () => {
    const { points, arcs } = roundCornersWithArcs(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 10 },
      ],
      20,
    );
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.radius).toBeCloseTo(5);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 100, y: 10 });
  });

  test('finds an orthogonal path around an obstacle', () => {
    const path = routeOrthogonal({
      from: { x: 0, y: 0 },
      fromDirection: 0,
      to: { x: 200, y: 0 },
      toDirection: 0,
      obstacles: [{ box: { minX: 50, minY: -50, maxX: 150, maxY: 50 }, margin: 10 }],
      bendCost: 20,
      margin: 20,
    })!;
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 200, y: 0 });
    expect(isOrthogonal(path)).toBe(true);
    for (let i = 0; i + 1 < path.length; i++) {
      const middle = { x: (path[i]!.x + path[i + 1]!.x) / 2, y: (path[i]!.y + path[i + 1]!.y) / 2 };
      const inside = middle.x > 40 && middle.x < 160 && middle.y > -60 && middle.y < 60;
      expect(inside).toBe(false);
    }
  });
});

describe('detachEnds', () => {
  test('frees ends attached to shapes that are left out', () => {
    const line = connector();
    const geometry = resolveConnector(line, getShape)!;
    const detached = detachEnds(line, geometry, (id) => id === 'a');
    expect(detached.start).toEqual({ kind: 'element', id: 'a' });
    expect(detached.end).toEqual({
      kind: 'point',
      x: geometry.points[1]!.x,
      y: geometry.points[1]!.y,
    });
    expect(detachEnds(line, geometry, () => true)).toBe(line);
    expect(detachEnds(line, null, () => false)).toBe(line);
  });
});
