import { hexColor, Scene, textBlock, type BoardElement, type ShapeElement } from '@apeiro/core';
import { BoardEditor } from './board-editor/board-editor';
import { describe, expect, test, vi } from 'vitest';
import { exportFrame, sceneOf } from './export/export-image';
import { dragStep, resizeStep } from './input/transform-gestures';
import { DraftScene, normalizeDraft } from './preview/draft-preview';
import { enteredGroup, groupSelection, selectionAfterPress } from './selection/grouping';
import { offsetMapper } from './text-editor/text-editor';
import { ToolState } from './tools/tool-state';

const rectangle = (id: string, patch: Partial<ShapeElement> = {}): ShapeElement => ({
  id,
  type: 'rect',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0x000000ff,
  strokeWidth: 0,
  radius: 0,
  ...patch,
});

const snap = { zoom: 1, snapping: true, shift: false, alt: false, deep: false };

describe('gestures', () => {
  test('drag snaps past the click slop and locks an axis with Shift', () => {
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const targets = [{ minX: 200, minY: 0, maxX: 300, maxY: 100 }];
    const start = { x: 0, y: 0 };
    expect(dragStep(start, { x: 97, y: 3 }, box, targets, true, snap)).toMatchObject({
      deltaX: 100,
      deltaY: 0,
    });
    expect(dragStep(start, { x: 97, y: 3 }, box, targets, false, snap)).toMatchObject({
      deltaX: 97,
      deltaY: 3,
    });
    expect(
      dragStep(start, { x: 50, y: 10 }, box, [], true, { ...snap, shift: true }),
    ).toMatchObject({ deltaX: 48, deltaY: 0 });
  });

  test('resize scales the elements and reports a badge', () => {
    const frame = { centerX: 50, centerY: 50, width: 100, height: 100, rotation: 0 };
    const step = resizeStep(
      {
        handle: 'se',
        frame,
        originals: [rectangle('a')],
        start: { x: 50, y: 50 },
        lockAspect: false,
        scaleText: true,
        targets: [],
      },
      { x: 100, y: 70 },
      { ...snap, snapping: false },
    );
    expect(step.patches.get('a')).toEqual({ x: 0, y: 0, width: 150, height: 120 });
    expect(step.badge).toBe('150 × 120');
  });
});

describe('grouping', () => {
  function grouped(): Scene {
    const scene = new Scene();
    scene.add(rectangle('a', { groupId: 'g' }));
    scene.add(rectangle('b', { groupId: 'g' }));
    scene.add(rectangle('c'));
    return scene;
  }

  test('a press selects the group, a click inside picks one element', () => {
    const scene = grouped();
    const first = selectionAfterPress(scene, new Set(), 'a', false);
    expect([...first.selection].sort()).toEqual(['a', 'b']);
    const second = selectionAfterPress(scene, first.selection, 'a', false);
    expect([...second.onClick!]).toEqual(['a']);
    expect(enteredGroup(scene, new Set(['a']))?.sort()).toEqual(['a', 'b']);
    const deep = selectionAfterPress(scene, new Set(), 'a', false, true);
    expect([...deep.selection]).toEqual(['a']);
    const shift = selectionAfterPress(scene, new Set(['c']), 'a', true);
    expect([...shift.selection].sort()).toEqual(['a', 'b', 'c']);
  });

  test('groups a selection under a new id', () => {
    const scene = grouped();
    const next = groupSelection(scene, new Set(['a', 'c']))!;
    expect([...next].sort()).toEqual(['a', 'b', 'c']);
    expect(new Set([...next].map((id) => scene.get(id)!.groupId)).size).toBe(1);
  });
});

describe('draft preview', () => {
  test('renames clashing ids, places new elements on top, drops missing targets', () => {
    const scene = new Scene();
    scene.add(rectangle('a', { z: 4 }));
    const draft = normalizeDraft(scene, {
      add: [rectangle('a', { z: 0 }), rectangle('new', { z: -1 })],
      update: [
        { id: 'a', x: 10 },
        { id: 'gone', x: 1 },
      ],
      remove: ['a', 'gone', 'a'],
    });
    expect(draft.add.map((element) => element.z)).toEqual([5, 6]);
    expect(draft.add[0]!.id).toBe('new');
    expect(draft.add[1]!.id).not.toBe('a');
    expect(draft.update).toEqual([{ id: 'a', x: 10 }]);
    expect(draft.remove).toEqual(['a']);
    expect(() => normalizeDraft(scene, { add: [rectangle('bad', { width: -1 })] })).toThrow(
      /draft element/,
    );
  });

  test('the draft scene follows the board', () => {
    const scene = new Scene();
    scene.add(rectangle('a'));
    const connector: BoardElement = {
      id: 'line',
      type: 'connector',
      z: 1,
      start: { kind: 'element', id: 'a' },
      end: { kind: 'point', x: 500, y: 0 },
      route: 'straight',
      stroke: 0,
      strokeWidth: 1,
      dash: 'solid',
      startCap: 'none',
      endCap: 'none',
    };
    const draft = new DraftScene(scene, normalizeDraft(scene, { add: [connector] }));
    expect(draft.scene.get('a')).toMatchObject({ fill: 0, stroke: 0 });
    scene.subscribe((changes) => draft.boardChanged(changes));
    scene.update('a', { x: 50 });
    expect(draft.scene.get('a')).toMatchObject({ x: 50 });
  });
});

describe('text editing', () => {
  test('maps offsets across one remote change', () => {
    const map = offsetMapper('hello world', 'hello brave world');
    expect(map(3)).toBe(3);
    expect(map(8)).toBe(14);
    expect(map(11)).toBe(17);
    expect(textBlock('x').runs).toEqual([{ text: 'x' }]);
  });
});

describe('ToolState', () => {
  test('activates, completes and registers tools', () => {
    const tools = new ToolState();
    let changes = 0;
    tools.onChange = () => changes++;
    tools.setTool('rect');
    expect(tools.repeat).toBe(false);
    tools.complete();
    expect(tools.tool).toBe('select');
    tools.setTool('pen');
    tools.complete();
    expect(tools.tool).toBe('pen');
    expect(() => tools.setTool('mine')).toThrow(/Unknown tool/);
    const unregister = tools.register('mine', {});
    tools.setTool('mine');
    expect(tools.customTool()).toEqual({});
    unregister();
    expect(tools.tool).toBe('select');
    tools.setDefaults('connector', { route: 'curve' });
    expect(tools.style.route).toBe('curve');
    expect(tools.overrides('connector')).toEqual({ route: 'curve' });
    expect(changes).toBe(6);
  });

  test('defaults are the full style, stable until an override changes', () => {
    const tools = new ToolState();
    const pen = tools.getDefaults('pen');
    expect(pen.stroke).toBe(0x18181bff);
    expect(tools.getDefaults('pen')).toBe(pen);
    tools.setDefaults('pen', { stroke: 0xff0000ff });
    expect(tools.getDefaults('pen')).toEqual({ ...pen, stroke: 0xff0000ff });
    expect(tools.getDefaults('connector').endCap).toBe('arrow');
    expect(tools.getDefaults('polygon').sides).toBe(5);
    expect(tools.getDefaults('sticky').strokeWidth).toBe(0);
    expect(tools.getDefaults('text')).not.toHaveProperty('runs');
  });
});

describe('BoardEditor', () => {
  test('creates a styled, labelled shape in one undo step, selected or not', () => {
    const editor = new BoardEditor();
    const box = { minX: 0, minY: 0, maxX: 300, maxY: 50 };
    const id = editor.elements.create('rect', {
      box,
      style: { fill: hexColor('#ff0000') },
      text: 'Idea',
    })!;
    const element = editor.scene.get(id) as ShapeElement;
    expect(element).toMatchObject({ x: 0, y: 0, width: 300, height: 50, fill: 0xff0000ff });
    expect(element.text?.runs).toEqual([{ text: 'Idea' }]);
    expect(editor.selection.ids).toEqual([id]);
    editor.history.undo();
    expect(editor.scene.has(id)).toBe(false);
    const quiet = editor.elements.create('sticky', { at: { x: 0, y: 0 }, select: false })!;
    expect(editor.selection.ids).toEqual([]);
    expect(editor.scene.get(quiet)).toMatchObject({ x: -90, y: -90, fill: 0xfff9b1ff });
    editor.destroy();
  });

  test('groups are stable, bound and say what a read-only board allows', async () => {
    const editor = new BoardEditor({ readOnly: true });
    const { undo } = editor.history;
    undo();
    expect(editor.history).toBe(editor.history);
    expect(editor.elements.create('rect')).toBeNull();
    editor.tools.activate('rect');
    expect(editor.tools.current).toBe('select');
    editor.setReadOnly(false);
    editor.elements.create('rect');
    expect(editor.history.canUndo).toBe(true);
    editor.setReadOnly(true);
    expect(editor.history.canUndo).toBe(false);
    await expect(editor.clipboard.paste()).resolves.toEqual([]);
    editor.destroy();
  });

  test('camera.set jumps and stops an animated zoom', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const editor = new BoardEditor();
    editor.camera.zoomTo(2);
    editor.camera.set({ x: 10, y: 20, zoom: 0.5 });
    expect([editor.camera.x, editor.camera.y, editor.camera.zoom]).toEqual([10, 20, 0.5]);
    editor.destroy();
    vi.unstubAllGlobals();
  });

  test('configured zoom steps are reciprocal and respect min/max bounds', () => {
    const editor = new BoardEditor({
      smoothCamera: false,
      camera: { zoomStep: 1.1, minZoom: 0.5, maxZoom: 2 },
    });
    editor.camera.zoomTo('in');
    expect(editor.camera.zoom).toBeCloseTo(1.1);
    editor.camera.zoomTo('out');
    expect(editor.camera.zoom).toBeCloseTo(1);
    editor.camera.set({ zoom: 1.95 });
    editor.camera.zoomTo('in');
    expect(editor.camera.zoom).toBe(2);
    editor.camera.set({ zoom: 0.51 });
    editor.camera.zoomTo('out');
    expect(editor.camera.zoom).toBe(0.5);
    editor.destroy();
    const defaults = new BoardEditor({ smoothCamera: false });
    defaults.camera.zoomTo('in');
    expect(defaults.camera.zoom).toBe(1.25);
    defaults.camera.zoomTo('out');
    expect(defaults.camera.zoom).toBe(1);
    defaults.destroy();
    const neutral = new BoardEditor({ smoothCamera: false, camera: { zoomStep: 1 } });
    neutral.camera.zoomTo('in');
    neutral.camera.zoomTo('out');
    expect(neutral.camera.zoom).toBe(1);
    neutral.destroy();
  });
});

describe('export', () => {
  test('a connector exported without its shapes keeps its line', () => {
    const scene = new Scene();
    scene.add(rectangle('a'));
    scene.add(rectangle('b', { x: 300 }));
    scene.add({
      id: 'line',
      type: 'connector',
      z: 1,
      start: { kind: 'element', id: 'a' },
      end: { kind: 'element', id: 'b' },
      route: 'straight',
      stroke: 0,
      strokeWidth: 2,
      dash: 'solid',
      startCap: 'none',
      endCap: 'arrow',
    });
    const part = sceneOf(scene, ['line', 'b']);
    expect(part.size).toBe(2);
    const geometry = part.connectorGeometry('line');
    expect(geometry).not.toBeNull();
    expect(geometry!.points[0]!.x).toBeCloseTo(scene.connectorGeometry('line')!.points[0]!.x);
    expect(part.get('line')).toMatchObject({ start: { kind: 'point' }, end: { kind: 'element' } });
  });

  test('the frame fits the content into the largest side', () => {
    const frame = exportFrame({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 2, 0, 100);
    expect(frame).toEqual({ x: 0, y: 0, width: 100, height: 50, zoom: 1 });
  });
});
