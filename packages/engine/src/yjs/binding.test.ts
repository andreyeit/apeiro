import { afterEach, describe, expect, test, vi } from 'vitest';
import { BoardEditor } from '@apeiro/editor';
import { textBlock, type ShapeElement } from '@apeiro/core';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { bindYjs } from '../yjs';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
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
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
  ...patch,
});
function client(
  options: {
    document?: Y.Doc;
    name?: string;
    readOnly?: boolean;
    onError?: (error: unknown) => void;
  } = {},
) {
  const sharedDocument = options.document ?? new Y.Doc();
  const board = new BoardEditor({ readOnly: options.readOnly });
  const binding = bindYjs(board, {
    document: sharedDocument,
    name: options.name,
    onError: options.onError,
  });
  cleanups.push(() => {
    board.destroy();
    sharedDocument.destroy();
  });
  return { document: sharedDocument, board, binding };
}
function exchange(first: ReturnType<typeof client>, second: ReturnType<typeof client>) {
  const firstUpdate = Y.encodeStateAsUpdate(first.document, Y.encodeStateVector(second.document));
  const secondUpdate = Y.encodeStateAsUpdate(second.document, Y.encodeStateVector(first.document));
  Y.applyUpdate(first.document, secondUpdate);
  Y.applyUpdate(second.document, firstUpdate);
}
function shape(board: BoardEditor, id = 'a'): ShapeElement {
  return board.scene.get(id) as ShapeElement;
}
function link(first: ReturnType<typeof client>, second: ReturnType<typeof client>) {
  exchange(first, second);
  first.document.on('update', (update: Uint8Array) => Y.applyUpdate(second.document, update));
  second.document.on('update', (update: Uint8Array) => Y.applyUpdate(first.document, update));
}

describe('Yjs binding', () => {
  test('streams creates, patches, deletes and undo without echo, including read-only viewers', () => {
    const first = client();
    const second = client({ readOnly: true });
    link(first, second);
    const updates = vi.fn();
    second.document.on('update', updates);
    first.board.elements.add([rectangle('a')]);
    first.board.scene.update('a', { x: 50 });
    expect(shape(second.board).x).toBe(50);
    expect(updates).toHaveBeenCalledTimes(2);
    expect(second.board.history.canUndo).toBe(false);
    first.board.history.undo();
    expect(shape(second.board).x).toBe(0);
    first.board.elements.remove(['a']);
    expect(second.board.scene.size).toBe(0);
    first.board.history.undo();
    expect(second.board.scene.size).toBe(1);
  });

  test('merges concurrent edits to different fields and undo preserves remote fields', () => {
    const first = client();
    const second = client();
    first.board.elements.add([rectangle('a')]);
    exchange(first, second);
    first.board.scene.update('a', { x: 25 });
    second.board.scene.update('a', { fill: 123 });
    exchange(first, second);
    expect(shape(first.board)).toMatchObject({ x: 25, fill: 123 });
    expect(shape(first.board)).toEqual(shape(second.board));
    first.board.history.undo();
    exchange(first, second);
    expect(shape(second.board)).toMatchObject({ x: 0, fill: 123 });
    first.board.history.redo();
    exchange(first, second);
    expect(shape(second.board)).toMatchObject({ x: 25, fill: 123 });
  });

  test('concurrent edits of the same field converge, including out-of-order duplicate updates', () => {
    const first = client();
    const second = client();
    first.board.elements.add([rectangle('a')]);
    exchange(first, second);
    first.board.scene.update('a', { x: 10 });
    second.board.scene.update('a', { x: 20 });
    const update = Y.encodeStateAsUpdate(first.document);
    exchange(first, second);
    Y.applyUpdate(second.document, update);
    Y.applyUpdate(second.document, update);
    expect(shape(first.board)).toEqual(shape(second.board));
  });

  test('merges concurrent rich text insertions, emoji and independent formatting', () => {
    const first = client();
    const second = client();
    first.board.elements.add([rectangle('a', { text: textBlock('ab') })]);
    exchange(first, second);
    first.board.scene.update('a', { text: textBlock('a🙂b') });
    second.board.scene.update('a', {
      text: textBlock('ab!', { runs: [{ text: 'ab!', bold: true }] }),
    });
    exchange(first, second);
    expect(shape(first.board).text).toEqual(shape(second.board).text);
    expect(
      shape(first.board)
        .text!.runs.map((run) => run.text)
        .join(''),
    ).toBe('a🙂b!');
    first.board.history.undo();
    exchange(first, second);
    expect(shape(second.board).text!.runs).toEqual([{ text: 'ab!', bold: true }]);
  });

  test('round trips paragraph formatting, empty final lines and optional field removal', () => {
    const first = client();
    const second = client();
    link(first, second);
    const block = textBlock('hello\n', {
      paragraphs: [{ list: 'bullet', indent: 1 }, { list: 'ordered' }],
    });
    first.board.elements.add([rectangle('a', { text: block, groupId: 'group' })]);
    expect(shape(second.board).text).toEqual(block);
    first.board.scene.update('a', { text: undefined, groupId: undefined });
    expect(shape(second.board).text).toBeUndefined();
    expect(shape(second.board).groupId).toBeUndefined();
    first.board.history.undo();
    expect(shape(second.board).text).toEqual(block);
    expect(shape(second.board).groupId).toBe('group');
  });

  test('a batch is one undo step', () => {
    const first = client();
    first.board.history.batch(() => {
      first.board.elements.add([rectangle('a'), rectangle('b')]);
      first.board.scene.update('a', { x: 12 });
    });
    first.board.history.undo();
    expect(first.board.scene.size).toBe(0);
    first.board.history.redo();
    expect(first.board.scene.size).toBe(2);
  });

  test('does not transmit computed connector routes or replace unchanged text snapshots', () => {
    const first = client();
    const second = client();
    link(first, second);
    first.board.elements.add([
      rectangle('a', { text: textBlock('label') }),
      {
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
        endCap: 'arrow',
      },
    ]);
    const text = shape(second.board).text;
    const record = first.document.getMap<Y.Map<unknown>>('apeiro:elements').get('line')!;
    const changed = vi.fn();
    record.observe(changed);
    first.board.scene.update('a', { x: 100 });
    expect(changed).not.toHaveBeenCalled();
    expect(shape(second.board).text).toBe(text);
    expect(second.board.scene.connectorGeometry('line')).toEqual(
      first.board.scene.connectorGeometry('line'),
    );
  });

  test('merges concurrent formatting attributes without replacing the text', () => {
    const first = client();
    const second = client();
    first.board.elements.add([rectangle('a', { text: textBlock('hello') })]);
    exchange(first, second);
    first.board.scene.update('a', {
      text: textBlock('hello', { runs: [{ text: 'hello', bold: true }] }),
    });
    second.board.scene.update('a', {
      text: textBlock('hello', { runs: [{ text: 'hello', color: 255 }] }),
    });
    exchange(first, second);
    expect(shape(first.board).text!.runs).toEqual([{ text: 'hello', bold: true, color: 255 }]);
    expect(shape(second.board).text).toEqual(shape(first.board).text);
  });

  test('load intentionally resets shared content and invalid initial data leaves content intact', () => {
    const first = client();
    const second = client();
    link(first, second);
    first.board.elements.add([rectangle('a')]);
    first.board.elements.load([rectangle('b')]);
    expect(second.board.elements.getAll().map((element) => element.id)).toEqual(['b']);
    const sharedDocument = new Y.Doc();
    const board = new BoardEditor();
    cleanups.push(() => {
      board.destroy();
      sharedDocument.destroy();
    });
    board.elements.add([rectangle('retained')]);
    sharedDocument.getMap('apeiro:elements').set('invalid', 'wrong type');
    expect(() => bindYjs(board, { document: sharedDocument })).toThrow('Invalid shared element');
    expect(board.scene.has('retained')).toBe(true);
  });

  test('hydrates from a document, isolates named boards and validates remote batches before applying', () => {
    const first = client();
    first.board.elements.add([rectangle('a')]);
    const second = client({ document: first.document });
    expect(shape(second.board)).toEqual(shape(first.board));
    const other = client({ document: first.document, name: 'other' });
    expect(other.board.scene.size).toBe(0);
    const onError = vi.fn();
    const third = client({ onError });
    exchange(first, third);
    first.document.transact(() => {
      first.document.getMap<Y.Map<unknown>>('apeiro:elements').get('a')!.set('width', -1);
    });
    exchange(first, third);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(shape(third.board).width).toBe(100);
  });

  test('detach is idempotent, restores local history and allows rebinding', () => {
    const first = client();
    first.board.elements.add([rectangle('a')]);
    first.binding.destroy();
    first.binding.destroy();
    first.board.scene.update('a', { x: 5 });
    first.board.history.undo();
    expect(shape(first.board).x).toBe(0);
    first.board.scene.update('a', { x: 10 });
    expect(first.document.getMap<Y.Map<unknown>>('apeiro:elements').get('a')!.get('x')).toBe(0);
    const binding = bindYjs(first.board, { document: first.document });
    expect(shape(first.board).x).toBe(0);
    expect(() => bindYjs(first.board, { document: first.document })).toThrow('already');
    binding.destroy();
  });

  test('destroying either owner disconnects subscriptions', () => {
    const first = client();
    first.board.destroy();
    const update = vi.fn();
    first.document.on('update', update);
    first.board.scene.update('missing', { x: 1 });
    expect(update).not.toHaveBeenCalled();
    const second = client();
    second.document.destroy();
    second.board.elements.add([rectangle('a')]);
    second.board.history.undo();
    expect(second.board.scene.size).toBe(0);
  });

  test('shares presence without destroying provider state or unrelated fields', () => {
    const firstDocument = new Y.Doc();
    const secondDocument = new Y.Doc();
    const firstAwareness = new Awareness(firstDocument);
    const secondAwareness = new Awareness(secondDocument);
    const first = new BoardEditor();
    const second = new BoardEditor();
    cleanups.push(() => {
      first.destroy();
      second.destroy();
      firstAwareness.destroy();
      secondAwareness.destroy();
      firstDocument.destroy();
      secondDocument.destroy();
    });
    firstAwareness.setLocalStateField('application', 'keep');
    const firstBinding = bindYjs(first, {
      document: firstDocument,
      awareness: firstAwareness,
      user: { name: 'Alice', color: '#ff0000' },
    });
    const secondBinding = bindYjs(second, { document: secondDocument, awareness: secondAwareness });
    applyAwarenessUpdate(
      secondAwareness,
      encodeAwarenessUpdate(firstAwareness, [firstDocument.clientID]),
      null,
    );
    expect(secondBinding.peers[0]?.user.name).toBe('Alice');
    firstBinding.setUser({ name: 'Updated', color: '#000000' });
    applyAwarenessUpdate(
      secondAwareness,
      encodeAwarenessUpdate(firstAwareness, [firstDocument.clientID]),
      null,
    );
    expect(secondBinding.peers[0]?.user.name).toBe('Updated');
    firstBinding.destroy();
    expect(firstAwareness.getLocalState()).toEqual({ application: 'keep' });
  });
});
