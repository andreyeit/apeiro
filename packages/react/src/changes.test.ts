import { Scene, type SceneChanges, type ShapeElement } from '@apeiro/core';
import { describe, expect, test } from 'vitest';
import { ChangeLog } from './changes';

const rectangle = (id: string, x = 0): ShapeElement => ({
  id,
  type: 'rect',
  x,
  y: 0,
  width: 10,
  height: 10,
  rotation: 0,
  z: 0,
  fill: 0,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
});

describe('ChangeLog', () => {
  test('merges batches per element and splits them by origin', () => {
    const scene = new Scene();
    const log = new ChangeLog();
    scene.subscribe((changes: SceneChanges) => log.add(changes));
    scene.add(rectangle('a'));
    scene.update('a', { x: 5 });
    scene.add(rectangle('temp'));
    scene.remove('temp');
    scene.transact(() => scene.add(rectangle('remote')), 'remote');
    expect(log.isEmpty).toBe(false);
    const groups = log.take(scene);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ origin: undefined, updated: [], removed: [] });
    expect(groups[0]!.added.map((element) => element.id)).toEqual(['a']);
    expect(groups[1]!.origin).toBe('remote');
    expect(log.isEmpty).toBe(true);
    scene.remove('a');
    scene.add(rectangle('a', 9));
    const [readded] = log.take(scene);
    expect(readded!.updated.map((element) => element.id)).toEqual(['a']);
  });
});
