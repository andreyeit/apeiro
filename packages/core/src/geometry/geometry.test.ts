import { describe, expect, test } from 'vitest';
import {
  boxAroundPoint,
  boxCenter,
  boxContainsBox,
  boxContainsPoint,
  boxFrame,
  boxFromPoints,
  boxIntersects,
  boxOfPoints,
  boxUnion,
  clamp,
  distanceToSegment,
  frameToWorld,
  gridStep,
  GRID_BASE,
  inflateBox,
  lerp,
  localToWorld,
  midpoint,
  normalize,
  rotateAround,
  rotateVector,
  shapeFrame,
  snapBox,
  SpatialIndex,
  subtract,
  worldToFrame,
  worldToLocal,
  type Box,
} from '../index';

const box = (minX: number, minY: number, maxX: number, maxY: number): Box => ({
  minX,
  minY,
  maxX,
  maxY,
});

describe('boxes', () => {
  test('intersect, contain, union and points', () => {
    expect(boxIntersects(box(0, 0, 10, 10), box(10, 10, 20, 20))).toBe(true);
    expect(boxIntersects(box(0, 0, 10, 10), box(11, 0, 20, 10))).toBe(false);
    expect(boxContainsBox(box(0, 0, 10, 10), box(2, 2, 8, 8))).toBe(true);
    expect(boxContainsBox(box(0, 0, 10, 10), box(2, 2, 11, 8))).toBe(false);
    expect(boxUnion(box(0, 0, 1, 1), box(-1, 2, 3, 4))).toEqual(box(-1, 0, 3, 4));
    expect(boxFromPoints({ x: 5, y: -1 }, { x: 1, y: 3 })).toEqual(box(1, -1, 5, 3));
  });

  test('rotateAround and clamp', () => {
    const rotated = rotateAround({ x: 2, y: 1 }, { x: 1, y: 1 }, Math.PI / 2);
    expect(rotated.x).toBeCloseTo(1);
    expect(rotated.y).toBeCloseTo(2);
    expect(rotateAround({ x: 3, y: 4 }, { x: 0, y: 0 }, 0)).toEqual({ x: 3, y: 4 });
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

describe('SpatialIndex', () => {
  test('finds, moves and deletes entries', () => {
    const index = new SpatialIndex({ cellSize: 10 });
    index.set('a', box(0, 0, 5, 5));
    index.set('b', box(100, 100, 120, 120));
    expect(index.size).toBe(2);
    expect(index.query(box(-1, -1, 6, 6))).toEqual(['a']);
    expect(index.queryPoint(110, 110)).toEqual(['b']);
    index.set('a', box(200, 200, 210, 210));
    expect(index.query(box(-1, -1, 6, 6))).toEqual([]);
    expect(index.query(box(195, 195, 205, 205))).toEqual(['a']);
    expect(index.getBox('a')).toEqual(box(200, 200, 210, 210));
    expect(index.delete('a')).toBe(true);
    expect(index.delete('a')).toBe(false);
    expect(index.has('a')).toBe(false);
  });

  test('reports an entry spanning many cells once, large ones too', () => {
    const index = new SpatialIndex({ cellSize: 10, maxCellsPerEntry: 4 });
    index.set('wide', box(0, 0, 25, 5));
    index.set('huge', box(-1000, -1000, 1000, 1000));
    expect(index.query(box(0, 0, 30, 30)).sort()).toEqual(['huge', 'wide']);
    index.clear();
    expect(index.size).toBe(0);
    expect(index.query(box(0, 0, 30, 30))).toEqual([]);
  });

  test('rejects invalid input', () => {
    expect(() => new SpatialIndex({ cellSize: 0 })).toThrow(RangeError);
    const index = new SpatialIndex();
    expect(() => index.set('a', box(1, 0, 0, 1))).toThrow(RangeError);
    expect(() => index.query(box(0, 0, Infinity, 1))).toThrow(RangeError);
  });
});

describe('snapping', () => {
  test('grid step grows 4x per level as the zoom falls', () => {
    expect(gridStep(1)).toBe(GRID_BASE);
    expect(gridStep(0.25)).toBe(GRID_BASE * 4);
    expect(gridStep(0)).toBe(GRID_BASE);
  });

  test('snaps edges to a nearby box and reports a guide', () => {
    const result = snapBox(box(103, 0, 153, 50), [box(0, 0, 100, 50)], { threshold: 5 });
    expect(result.deltaX).toBe(-3);
    expect(result.deltaY).toBe(0);
    expect(result.guides.some((guide) => guide.axis === 'x' && guide.at === 100)).toBe(true);
  });

  test('falls back to the grid and respects locks', () => {
    const result = snapBox(box(13, 13, 23, 23), [], { threshold: 2, grid: 10 });
    expect(result).toMatchObject({ deltaX: -3, deltaY: -3, guides: [] });
    const locked = snapBox(box(13, 13, 23, 23), [], { threshold: 2, grid: 10, lockY: true });
    expect(locked.deltaY).toBe(0);
  });

  test('snaps a box between two neighbours to equal gaps', () => {
    const result = snapBox(box(48, 0, 58, 10), [box(0, 0, 10, 10), box(100, 0, 110, 10)], {
      threshold: 3,
    });
    expect(result.deltaX).toBe(2);
    expect(result.spacing).toHaveLength(1);
    expect(result.spacing[0]).toMatchObject({ axis: 'x', distance: 40 });
  });

  test('resizes snap only the dragged edges', () => {
    const result = snapBox(box(0, 0, 97, 50), [box(100, 0, 150, 50)], {
      threshold: 5,
      edges: { x: ['max'], y: [] },
    });
    expect(result.deltaX).toBe(3);
    expect(result.spacing).toEqual([]);
  });
});

describe('vectors, boxes and frames', () => {
  test('vector helpers', () => {
    expect(subtract({ x: 3, y: 4 }, { x: 1, y: 1 })).toEqual({ x: 2, y: 3 });
    expect(normalize({ x: 3, y: 4 })).toEqual({ x: 0.6, y: 0.8 });
    expect(normalize({ x: 0, y: 0 })).toEqual({ x: 1, y: 0 });
    const rotated = rotateVector({ x: 1, y: 0 }, Math.PI / 2);
    expect(rotated.x).toBeCloseTo(0);
    expect(rotated.y).toBeCloseTo(1);
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distanceToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
    expect(midpoint({ x: 0, y: 0 }, { x: 2, y: 4 })).toEqual({ x: 1, y: 2 });
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });

  test('box helpers', () => {
    expect(
      boxOfPoints([
        { x: 1, y: 5 },
        { x: -2, y: 3 },
      ]),
    ).toEqual(box(-2, 3, 1, 5));
    expect(inflateBox(box(0, 0, 1, 1), 2)).toEqual(box(-2, -2, 3, 3));
    expect(inflateBox(box(0, 0, 1, 1), 2, 0)).toEqual(box(-2, 0, 3, 1));
    expect(boxAroundPoint({ x: 5, y: 5 }, 1)).toEqual(box(4, 4, 6, 6));
    expect(boxContainsPoint(box(0, 0, 10, 10), { x: 5, y: 5 })).toBe(true);
    expect(boxContainsPoint(box(0, 0, 10, 10), { x: 10, y: 5 })).toBe(false);
  });

  test('local and world points of rotated boxes agree with frames', () => {
    const rotated = { x: 10, y: 20, width: 40, height: 20, rotation: 0.7 };
    const local = { x: 5, y: -3 };
    const world = localToWorld(rotated, local);
    const back = worldToLocal(rotated, world);
    expect(back.x).toBeCloseTo(local.x);
    expect(back.y).toBeCloseTo(local.y);
    expect(frameToWorld(shapeFrame(rotated), local)).toEqual(world);
    expect(worldToFrame(shapeFrame(rotated), world).x).toBeCloseTo(local.x);
    expect(boxCenter(rotated)).toEqual({ x: 30, y: 30 });
    expect(boxFrame(box(0, 0, 10, 20))).toEqual({
      centerX: 5,
      centerY: 10,
      width: 10,
      height: 20,
      rotation: 0,
    });
  });
});
