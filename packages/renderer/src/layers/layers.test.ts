import { Scene, type ConnectorElement } from '@apeiro/core';
import { describe, expect, test } from 'vitest';
import { ColorTheme } from '../color-theme';
import { GlyphAtlas } from '../text/glyph-atlas';
import { byteRuns, coalesceRuns, DirtyRanges } from './buffer-upload';
import { INSTANCE_STRIDE, InstanceStore } from './instance-store';
import { LINE_STRIDE, LineLayer } from './line-layer';
import { pickTier, SDF_TIERS } from './text-layer';

const rectangle = (id: string, z: number, patch: Record<string, unknown> = {}) => ({
  id,
  type: 'rect' as const,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  rotation: 0,
  z,
  fill: 0xff0000ff,
  stroke: 0x00ff00ff,
  strokeWidth: 1,
  radius: 0,
  ...patch,
});

describe('dirty ranges', () => {
  test('merges close runs and caps their number', () => {
    expect(
      coalesceRuns(
        [
          [10, 12],
          [0, 2],
          [3, 4],
        ],
        2,
      ),
    ).toEqual([
      [0, 4],
      [10, 12],
    ]);
    expect(
      coalesceRuns(
        [
          [0, 1],
          [10, 11],
          [30, 31],
        ],
        0,
        2,
      ),
    ).toEqual([
      [0, 11],
      [30, 31],
    ]);
    const dirty = new DirtyRanges();
    expect(dirty.take()).toEqual({ kind: 'none' });
    dirty.mark(5, 6);
    dirty.mark(1, 2);
    expect(dirty.take()).toEqual({ kind: 'ranges', runs: [[1, 6]] });
    dirty.markAll();
    dirty.mark(1, 2);
    expect(dirty.take()).toEqual({ kind: 'all' });
    expect(byteRuns({ kind: 'ranges', runs: [[2, 10]] }, false, 5, 4)).toEqual([[8, 12]]);
    expect(byteRuns({ kind: 'ranges', runs: [[2, 3]] }, true, 5, 4)).toEqual([[0, 20]]);
  });
});

describe('InstanceStore', () => {
  test('keeps slots in paint order and writes colors as bytes', () => {
    const store = new InstanceStore(1);
    store.rebuild([rectangle('a', 0), rectangle('b', 1)]);
    expect(store.count).toBe(2);
    expect(store.slot('b')).toBe(1);
    expect(store.takeDirty()).toEqual({ kind: 'all' });
    const bytes = new Uint8Array(store.data);
    expect([...bytes.subarray(32, 36)]).toEqual([255, 0, 0, 255]);
    expect(store.tryAppend([rectangle('c', 2)])).toBe(true);
    expect(store.tryAppend([rectangle('under', -1)])).toBe(false);
    expect(store.update(rectangle('a', 0, { fill: 0x0000ffff }))).toBe(true);
    expect([...new Uint8Array(store.data).subarray(32, 36)]).toEqual([0, 0, 255, 255]);
    expect(store.remove('b')).toBe(true);
    expect(store.holeCount).toBe(1);
    expect(new Float32Array(store.data)[(INSTANCE_STRIDE / 4) * 1 + 7]).toBe(-1);
  });

  test('draws colors through the theme', () => {
    const store = new InstanceStore();
    const theme = new ColorTheme();
    theme.set([[0xff0000, 0x123456]], ['sticky']);
    store.theme = theme;
    store.rebuild([rectangle('a', 0), rectangle('s', 1, { type: 'sticky' })]);
    const bytes = new Uint8Array(store.data);
    expect([...bytes.subarray(32, 36)]).toEqual([0x12, 0x34, 0x56, 255]);
    expect([...bytes.subarray(INSTANCE_STRIDE + 32, INSTANCE_STRIDE + 36)]).toEqual([
      255, 0, 0, 255,
    ]);
    expect(theme.of('rect', 0xff000080)).toBe(0x12345680);
  });
});

describe('LineLayer', () => {
  test('writes connector segments and caps into a range of their own', () => {
    const scene = new Scene();
    scene.add(rectangle('a', 0, { width: 100, height: 100 }));
    scene.add(rectangle('b', 1, { x: 300, width: 100, height: 100 }));
    const connector: ConnectorElement = {
      id: 'c',
      type: 'connector',
      z: 2,
      start: { kind: 'element', id: 'a' },
      end: { kind: 'element', id: 'b' },
      route: 'straight',
      stroke: 0x000000ff,
      strokeWidth: 2,
      dash: 'dashed',
      startCap: 'none',
      endCap: 'arrow',
    };
    scene.add(connector);
    const layer = new LineLayer();
    layer.rebuild(scene, () => 0);
    // One segment and one cap, plus room to grow.
    expect(layer.count).toBeGreaterThanOrEqual(2);
    const floats = new Float32Array(layer.data);
    const stride = LINE_STRIDE / 4;
    expect(floats[5]).toBe(0); // a segment
    expect(floats[stride + 5]).toBe(1); // an arrow cap
    expect(floats[6]).toBeGreaterThan(0); // dashed
    expect(layer.takeUpload()).toEqual({ kind: 'all' });
    layer.remove('c');
    expect(floats.length).toBeGreaterThan(0);
    expect(layer.takeUpload().kind).toBe('ranges');
  });
});

describe('text', () => {
  test('picks the smallest tier magnified at most 1.5x', () => {
    expect(pickTier(SDF_TIERS, 10)).toBe(0);
    expect(pickTier(SDF_TIERS, 60)).toBe(1);
    expect(pickTier(SDF_TIERS, 10_000)).toBe(SDF_TIERS.length - 1);
    expect(pickTier(SDF_TIERS, 10_000, 2)).toBe(2);
  });

  test('the glyph atlas packs, grows and resets', () => {
    const atlas = new GlyphAtlas({ channels: 1, initialSize: 16, maxSize: 32 });
    const raster = (size: number) => ({
      data: new Uint8Array(size * size),
      width: size,
      height: size,
      left: 0,
      top: 0,
    });
    const first = atlas.insert('a', raster(10), 32);
    expect(first).toMatchObject({ x: 0, y: 0, width: 10 });
    expect(atlas.peek('a')).toBe(first);
    atlas.insert('b', raster(10), 32);
    expect(atlas.size).toBe(32);
    const generation = atlas.generation;
    for (let i = 0; i < 10; i++) atlas.insert(`g${i}`, raster(10), 32);
    expect(atlas.generation).toBeGreaterThan(generation);
    expect(atlas.insert('huge', raster(64), 32)).toMatchObject({ width: 0, height: 0 });
    expect(atlas.takeUploads().full).toBe(true);
  });
});
