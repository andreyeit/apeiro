import { describe, expect, test } from 'vitest';
import {
  canGroup,
  canUngroup,
  clipboardFromHtml,
  clipboardText,
  clipboardToHtml,
  copyElements,
  duplicateElements,
  expandToGroups,
  groupElements,
  groupOf,
  History,
  isBoardClipboard,
  isWholeGroup,
  pasteElements,
  Scene,
  textBlock,
  ungroupElements,
  type ConnectorElement,
  type SceneChanges,
} from '../index';
import { makeRectangle } from '../test-utils';

const line = (id: string, from: string, to: string, patch: Partial<ConnectorElement> = {}) =>
  ({
    id,
    type: 'connector',
    z: 10,
    start: { kind: 'element', id: from },
    end: { kind: 'element', id: to },
    route: 'straight',
    stroke: 0x000000ff,
    strokeWidth: 2,
    dash: 'solid',
    startCap: 'none',
    endCap: 'arrow',
    ...patch,
  }) satisfies ConnectorElement;

function record(scene: Scene): SceneChanges[] {
  const batches: SceneChanges[] = [];
  scene.subscribe((changes) => batches.push(changes));
  return batches;
}

describe('Scene', () => {
  test('adds, updates and removes in batches', () => {
    const scene = new Scene();
    const batches = record(scene);
    scene.transact(() => {
      scene.add(makeRectangle('a'));
      scene.add(makeRectangle('b', { x: 200, z: 1 }));
      scene.update('a', { fill: 0 });
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.added.map((element) => element.id)).toEqual(['a', 'b']);
    expect(batches[0]!.updated).toEqual([]);
    expect(scene.get('a')).toMatchObject({ fill: 0 });
    expect(scene.update('missing', { x: 1 })).toBe(false);
    scene.update('a', { x: 5 });
    expect(batches[1]!.updated.map((element) => element.id)).toEqual(['a']);
    expect(batches[1]!.previous.get('a')).toMatchObject({ x: 0 });
    expect(scene.remove('a')).toBe(true);
    expect(batches[2]!.removed).toEqual(['a']);
    expect(scene.size).toBe(1);
  });

  test('throws on invalid or duplicate elements', () => {
    const scene = new Scene();
    scene.add(makeRectangle('a'));
    expect(() => scene.add(makeRectangle('a'))).toThrow(/already exists/);
    expect(() => scene.add(makeRectangle('b', { x: Number.NaN }))).toThrow(/Invalid/);
    expect(() => scene.update('a', { width: -1 })).toThrow(/Invalid update/);
    expect(scene.get('a')).toMatchObject({ width: 100 });
  });

  test('an element removed and re-added in one batch is an update', () => {
    const scene = new Scene();
    scene.add(makeRectangle('a'));
    const batches = record(scene);
    scene.transact(() => {
      scene.remove('a');
      scene.add(makeRectangle('a', { z: 5 }));
    });
    expect(batches[0]!.updated.map((element) => element.id)).toEqual(['a']);
    expect(batches[0]!.removed).toEqual([]);
    expect(batches[0]!.orderChanged).toBe(true);
    scene.transact(() => {
      scene.add(makeRectangle('temp'));
      scene.remove('temp');
    });
    expect(batches).toHaveLength(1);
  });

  test('paint order, highest z and origins', () => {
    const scene = new Scene();
    const batches = record(scene);
    scene.transact(() => {
      scene.add(makeRectangle('b', { z: 1 }));
      scene.add(makeRectangle('a', { z: 1 }));
      scene.add(makeRectangle('c', { z: 0 }));
    }, 'load');
    expect(scene.sortedByZ().map((element) => element.id)).toEqual(['c', 'a', 'b']);
    expect(scene.maxZ()).toBe(1);
    expect(batches[0]!.origin).toBe('load');
    scene.update('c', { z: 7 });
    expect(batches[1]!.orderChanged).toBe(true);
    expect(scene.sortedByZ().map((element) => element.id)).toEqual(['a', 'b', 'c']);
    scene.remove('c');
    expect(scene.maxZ()).toBe(1);
  });

  test('hit testing and box queries', () => {
    const scene = new Scene();
    scene.add(makeRectangle('low', { z: 0 }));
    scene.add(makeRectangle('high', { x: 50, z: 1 }));
    expect(scene.hitTest({ x: 75, y: 50 })?.id).toBe('high');
    expect(scene.hitTest({ x: 25, y: 50 })?.id).toBe('low');
    expect(scene.hitTest({ x: 500, y: 500 })).toBeUndefined();
    expect(scene.hitTestShape({ x: 75, y: 50 }, 0, (id) => id === 'high')?.id).toBe('low');
    const box = { minX: -10, minY: -10, maxX: 120, maxY: 120 };
    expect(scene.queryBox(box, 'contain').map((element) => element.id)).toEqual(['low']);
    expect(scene.queryBox(box).length).toBe(2);
    expect(scene.bounds()).toEqual({ minX: 0, minY: 0, maxX: 150, maxY: 100 });
    expect(scene.bounds(['missing'])).toBeNull();
  });

  test('connectors follow their shapes and are removed with them', () => {
    const scene = new Scene();
    scene.add(makeRectangle('a'));
    scene.add(makeRectangle('b', { x: 300 }));
    scene.add(line('c', 'a', 'b'));
    expect(scene.connectorsOf('a')).toEqual(['c']);
    const before = scene.connectorGeometry('c')!.points[1]!.x;
    const batches = record(scene);
    scene.update('b', { x: 400 });
    expect(batches[0]!.updated.map((element) => element.id).sort()).toEqual(['b', 'c']);
    expect(scene.connectorGeometry('c')!.points[1]!.x).toBeCloseTo(before + 100);
    scene.removeWithConnectors(['a']);
    expect(scene.has('c')).toBe(false);
    expect(scene.connectorsOf('b')).toEqual([]);
  });

  test('elbows re-route around shapes that move into their way', () => {
    const scene = new Scene();
    scene.add(makeRectangle('a'));
    scene.add(makeRectangle('b', { x: 400 }));
    scene.add(line('c', 'a', 'b', { route: 'elbow' }));
    expect(scene.connectorGeometry('c')!.routed).toBe(false);
    scene.add(makeRectangle('wall', { x: 200, y: -100, width: 50, height: 300 }));
    expect(scene.connectorGeometry('c')!.routed).toBe(true);
    scene.remove('wall');
    expect(scene.connectorGeometry('c')!.routed).toBe(false);
  });

  test('the edit guard refuses local edits only', () => {
    const scene = new Scene();
    scene.add(makeRectangle('a'));
    scene.setEditGuard(() => false);
    expect(scene.update('a', { x: 5 })).toBe(false);
    expect(scene.remove('a')).toBe(false);
    scene.add(makeRectangle('b'));
    expect(scene.has('b')).toBe(false);
    scene.transact(() => scene.update('a', { x: 5 }), 'remote');
    expect(scene.get('a')).toMatchObject({ x: 5 });
    scene.setEditGuard(null);
    expect(scene.remove('a')).toBe(true);
  });

  test('frozen scenes reject mutation of stored elements', () => {
    const scene = new Scene({ freeze: true });
    scene.add(makeRectangle('a', { text: textBlock('x') }));
    const stored = scene.get('a')!;
    expect(() => {
      (stored as { x: number }).x = 1;
    }).toThrow();
  });

  test('tracks group members', () => {
    const scene = new Scene();
    scene.add(makeRectangle('a', { groupId: 'g' }));
    scene.add(makeRectangle('b', { groupId: 'g' }));
    expect(scene.groupMembers('g').sort()).toEqual(['a', 'b']);
    scene.update('b', { groupId: undefined });
    expect(scene.groupMembers('g')).toEqual(['a']);
  });

  test('a throwing listener does not stop the others', () => {
    const scene = new Scene();
    let called = false;
    scene.subscribe(() => {
      throw new Error('boom');
    });
    scene.subscribe(() => {
      called = true;
    });
    expect(() => scene.add(makeRectangle('a'))).toThrow('boom');
    expect(called).toBe(true);
  });
});

describe('History', () => {
  test('undoes and redoes local batches', () => {
    const scene = new Scene();
    const history = new History(scene);
    scene.add(makeRectangle('a'));
    scene.update('a', { x: 50 });
    expect(history.canUndo).toBe(true);
    expect(history.undo()).toEqual(['a']);
    expect(scene.get('a')).toMatchObject({ x: 0 });
    history.undo();
    expect(scene.has('a')).toBe(false);
    expect(history.canRedo).toBe(true);
    history.redo();
    history.redo();
    expect(scene.get('a')).toMatchObject({ x: 50 });
    expect(history.canRedo).toBe(false);
  });

  test('groups gestures, skips no-ops and ignores tagged batches', () => {
    const scene = new Scene();
    const history = new History(scene);
    scene.transact(() => scene.add(makeRectangle('a')), 'load');
    expect(history.canUndo).toBe(false);
    history.beginGroup();
    scene.update('a', { x: 10 });
    scene.update('a', { x: 20 });
    history.endGroup();
    history.undo();
    expect(scene.get('a')).toMatchObject({ x: 0 });
    expect(history.canUndo).toBe(false);
    history.batch(() => {
      scene.update('a', { x: 5 });
      scene.update('a', { x: 0 });
    });
    expect(history.canUndo).toBe(false);
  });

  test('keeps at most `limit` steps and notifies', () => {
    const scene = new Scene();
    const history = new History(scene, { limit: 2 });
    let notified = 0;
    history.subscribe(() => notified++);
    scene.add(makeRectangle('a'));
    scene.update('a', { x: 1 });
    scene.update('a', { x: 2 });
    history.undo();
    history.undo();
    expect(history.canUndo).toBe(false);
    expect(scene.get('a')).toMatchObject({ x: 0 });
    expect(notified).toBe(5);
    history.clear();
    expect(history.canRedo).toBe(false);
    history.dispose();
  });
});

describe('groups', () => {
  test('group and ungroup', () => {
    const scene = new Scene();
    for (const id of ['a', 'b', 'c']) scene.add(makeRectangle(id));
    expect(canGroup(scene, new Set(['a']))).toBe(false);
    expect(canGroup(scene, new Set(['a', 'b']))).toBe(true);
    expect(groupElements(scene, ['a', 'b'], 'g')?.sort()).toEqual(['a', 'b']);
    expect(groupOf(scene, scene.get('a'))?.sort()).toEqual(['a', 'b']);
    expect(isWholeGroup(scene, new Set(['a', 'b']))).toBe(true);
    expect(canGroup(scene, new Set(['a', 'b']))).toBe(false);
    expect([...expandToGroups(scene, ['a', 'c'])].sort()).toEqual(['a', 'b', 'c']);
    expect(canUngroup(scene, ['c'])).toBe(false);
    expect(ungroupElements(scene, ['a']).sort()).toEqual(['a', 'b']);
    expect(scene.get('b')?.groupId).toBeUndefined();
  });
});

describe('clipboard', () => {
  function board(): Scene {
    const scene = new Scene();
    scene.add(makeRectangle('a', { text: textBlock('Alpha'), groupId: 'g' }));
    scene.add(makeRectangle('b', { x: 300, groupId: 'g' }));
    scene.add(makeRectangle('outside', { x: 600 }));
    scene.add(line('ab', 'a', 'b'));
    scene.add(line('to-outside', 'b', 'outside'));
    return scene;
  }

  test('copies the lines between copied shapes, frees the others', () => {
    const scene = board();
    const data = copyElements(scene, ['a', 'b'])!;
    expect(data.elements.map((element) => element.id).sort()).toEqual(['a', 'ab', 'b']);
    expect(copyElements(scene, ['missing'])).toBeNull();
    const single = copyElements(scene, ['to-outside'])!;
    const copied = single.elements[0] as ConnectorElement;
    expect(copied.start.kind).toBe('point');
    expect(copied.end.kind).toBe('point');
  });

  test('pastes with new ids, rewired lines and groups, on top', () => {
    const scene = board();
    const data = copyElements(scene, ['a', 'b'])!;
    let next = 0;
    const ids = pasteElements(scene, data, {
      offset: { x: 0, y: 500 },
      newId: () => `copy-${next++}`,
    });
    expect(ids).toHaveLength(3);
    const copies = ids.map((id) => scene.get(id)!);
    const shapes = copies.filter((element) => element.type !== 'connector');
    expect(shapes.every((shape) => 'y' in shape && shape.y === 500)).toBe(true);
    expect(new Set(shapes.map((shape) => shape.groupId)).size).toBe(1);
    expect(shapes[0]!.groupId).not.toBe('g');
    const connector = copies.find((element) => element.type === 'connector') as ConnectorElement;
    expect(ids).toContain((connector.start as { id: string }).id);
    expect(Math.min(...copies.map((element) => element.z))).toBeGreaterThan(10);
    expect(duplicateElements(scene, ['outside'], { x: 10, y: 10 })).toHaveLength(1);
  });

  test('round-trips through HTML and plain text', () => {
    const scene = board();
    const data = copyElements(scene, ['a'])!;
    expect(isBoardClipboard(data)).toBe(true);
    expect(isBoardClipboard({ kind: 'other' })).toBe(false);
    expect(clipboardText(data)).toBe('Alpha');
    const html = clipboardToHtml(data);
    expect(html).toContain('<p>Alpha</p>');
    expect(clipboardFromHtml(html)).toEqual(data);
    expect(clipboardFromHtml('<p>nothing</p>')).toBeNull();
  });
});

describe('Scene shortcuts', () => {
  test('a patch that changes nothing is no change', () => {
    const scene = new Scene();
    scene.add(makeRectangle('a', { x: 5 }));
    const history = new History(scene);
    const batches = record(scene);
    expect(scene.update('a', { x: 5, groupId: undefined })).toBe(true);
    expect(batches).toHaveLength(0);
    expect(history.canUndo).toBe(false);
  });

  test('connectors between shapes moved together are shifted, not routed again', () => {
    const scene = new Scene();
    scene.add(makeRectangle('a'));
    scene.add(makeRectangle('b', { x: 300, y: 80 }));
    scene.add(line('straight', 'a', 'b'));
    scene.add(line('curved', 'a', 'b', { route: 'curve', curve: { along: 0.1, across: 0.3 } }));
    const before = {
      straight: scene.connectorGeometry('straight')!,
      curved: scene.connectorGeometry('curved')!,
    };
    const batches = record(scene);
    scene.transact(() => {
      scene.update('a', { x: 40, y: 25 });
      scene.update('b', { x: 340, y: 105 });
    });
    expect(batches[0]!.updated.map((element) => element.id).sort()).toEqual([
      'a',
      'b',
      'curved',
      'straight',
    ]);
    for (const id of ['straight', 'curved'] as const) {
      const moved = scene.connectorGeometry(id)!;
      // The same as resolving it from scratch.
      const fresh = new Scene();
      for (const element of scene.all()) fresh.add(element);
      const resolved = fresh.connectorGeometry(id)!;
      expect(moved.points.length).toBe(resolved.points.length);
      moved.points.forEach((point, index) => {
        expect(point.x).toBeCloseTo(resolved.points[index]!.x, 6);
        expect(point.y).toBeCloseTo(resolved.points[index]!.y, 6);
        expect(point.x).toBeCloseTo(before[id].points[index]!.x + 40, 6);
      });
      expect(scene.getBounds(id)!.minX).toBeCloseTo(before[id].bounds.minX + 40, 6);
    }
    // Moved apart: routed again.
    scene.update('b', { x: 600 });
    expect(scene.connectorGeometry('straight')!.points[1]!.x).toBeCloseTo(599, 0);
  });

  test('moves within one batch read in between are not counted twice', () => {
    const scene = new Scene();
    scene.add(makeRectangle('a'));
    scene.add(makeRectangle('b', { x: 300 }));
    scene.add(line('straight', 'a', 'b'));
    const start = scene.connectorGeometry('straight')!.points[0]!.x;
    scene.transact(() => {
      scene.update('a', { x: 10 });
      scene.update('b', { x: 310 });
      expect(scene.connectorGeometry('straight')!.points[0]!.x).toBeCloseTo(start + 10);
      scene.update('a', { x: 20 });
      scene.update('b', { x: 320 });
    });
    expect(scene.connectorGeometry('straight')!.points[0]!.x).toBeCloseTo(start + 20);
  });
});
