import { afterEach, describe, expect, test } from 'vitest';
import { BoardEditor } from '@apeiro/editor';
import type { ShapeElement } from '@apeiro/core';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { bindYjs } from '../yjs';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0).reverse()) dispose();
});
const rect = (id: string): ShapeElement => ({
  id,
  type: 'rect',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  z: 0,
  fill: 0,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
});
function client(
  document = new Y.Doc(),
  awareness = new Awareness(document),
  board = new BoardEditor(),
) {
  const binding = bindYjs(board, { document, awareness, showPresence: false });
  cleanups.push(() => {
    binding.destroy();
    board.destroy();
    awareness.destroy();
    document.destroy();
  });
  return { document, awareness, board, binding };
}
type Client = ReturnType<typeof client>;
function syncPresence(sender: Client, receiver: Client) {
  applyAwarenessUpdate(
    receiver.awareness,
    encodeAwarenessUpdate(sender.awareness, [sender.document.clientID]),
    sender,
  );
}
function pair() {
  const first = client();
  const second = client();
  for (const [sender, receiver] of [
    [first, second],
    [second, first],
  ] as const) {
    const update = (data: Uint8Array, origin: unknown) => {
      if (origin !== receiver) Y.applyUpdate(receiver.document, data, sender);
    };
    sender.document.on('update', update);
    cleanups.push(() => sender.document.off('update', update));
  }
  first.board.elements.add([rect('a'), rect('b')], { select: false });
  return [first, second] as const;
}
function connectPresence(first: Client, second: Client) {
  for (const [sender, receiver] of [
    [first, second],
    [second, first],
  ] as const) {
    const update = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin !== receiver)
        applyAwarenessUpdate(
          receiver.awareness,
          encodeAwarenessUpdate(sender.awareness, [...added, ...updated, ...removed]),
          sender,
        );
    };
    sender.awareness.on('update', update);
    cleanups.push(() => sender.awareness.off('update', update));
    syncPresence(sender, receiver);
  }
}
const x = (board: BoardEditor) => (board.scene.get('a') as ShapeElement).x;

describe('selection ownership', () => {
  test('reserves selection, blocks all local writes and permits owner updates', () => {
    const [first, second] = pair();
    connectPresence(first, second);
    first.board.selection.set(['a']);
    expect(second.board.isElementLocked('a')).toBe(true);
    second.board.selection.set(['a', 'b']);
    expect(second.board.selection.ids).toEqual(['b']);
    second.board.scene.update('a', { x: 10 });
    second.board.elements.update(['a'], { x: 20 });
    second.board.scene.transact(() => second.board.scene.update('a', { x: 30 }), 'react');
    second.board.elements.remove(['a']);
    second.board.setReadOnly(true);
    second.board.setReadOnly(false);
    second.board.scene.update('a', { x: 40 });
    expect(x(second.board)).toBe(0);
    first.board.scene.update('a', { x: 50 });
    expect(x(second.board)).toBe(50);
    second.board.scene.update('b', { x: 75 });
    expect((first.board.scene.get('b') as ShapeElement).x).toBe(75);
    first.board.selection.clear();
    second.board.selection.set(['a']);
    expect(first.board.isElementLocked('a')).toBe(true);
    second.board.scene.update('a', { x: 100 });
    expect(x(first.board)).toBe(100);
  });

  test('simultaneous claims converge to one owner without deadlock', () => {
    const [first, second] = pair();
    first.board.selection.set(['a']);
    second.board.selection.set(['a']);
    connectPresence(first, second);
    const [winner, loser] =
      first.document.clientID < second.document.clientID ? [first, second] : [second, first];
    expect(winner.board.selection.ids).toEqual(['a']);
    expect(loser.board.selection.ids).toEqual([]);
    expect(winner.board.isElementLocked('a')).toBe(false);
    expect(loser.board.isElementLocked('a')).toBe(true);
    loser.board.scene.update('a', { x: 90 });
    expect(x(winner.board)).toBe(0);
    winner.board.selection.clear();
    loser.board.selection.set(['a']);
    expect(loser.board.selection.ids).toEqual(['a']);
  });

  test('cannot undo or redo a batch touching an element selected by a peer', () => {
    const [first, second] = pair();
    connectPresence(first, second);
    first.board.scene.update('a', { x: 10 });
    second.board.selection.set(['a']);
    expect(first.board.history.canUndo).toBe(false);
    first.board.history.undo();
    expect(x(first.board)).toBe(10);
    second.board.selection.clear();
    expect(first.board.history.canUndo).toBe(true);
    first.board.history.undo();
    expect(x(second.board)).toBe(0);
    first.board.selection.clear();
    second.board.selection.set(['a']);
    expect(first.board.history.canRedo).toBe(false);
    first.board.history.redo();
    expect(x(first.board)).toBe(0);
    second.board.selection.clear();
    expect(first.board.history.canRedo).toBe(true);
    first.board.history.redo();
    expect(x(second.board)).toBe(10);
  });

  test('releases reservations when presence disappears or the binding is destroyed', () => {
    const [first, second] = pair();
    connectPresence(first, second);
    first.board.selection.set(['a']);
    first.awareness.setLocalState(null);
    expect(second.board.isElementLocked('a')).toBe(false);
    second.board.selection.set(['b']);
    expect(first.board.isElementLocked('b')).toBe(true);
    first.binding.destroy();
    expect(first.board.isElementLocked('b')).toBe(false);
    first.board.elements.update(['b'], { x: 30 });
    expect((first.board.scene.get('b') as ShapeElement).x).toBe(30);
  });

  test('a joining client cannot steal an existing reservation with a lower claim clock', () => {
    const first = client();
    first.board.elements.add([rect('a')], { select: false });
    for (let i = 0; i < 4; i++) {
      first.board.selection.set(['a']);
      first.board.selection.clear();
    }
    first.board.selection.set(['a']);
    const document = new Y.Doc();
    Y.applyUpdate(document, Y.encodeStateAsUpdate(first.document));
    const awareness = new Awareness(document);
    applyAwarenessUpdate(
      awareness,
      encodeAwarenessUpdate(first.awareness, [first.document.clientID]),
      null,
    );
    const board = new BoardEditor();
    board.elements.add([rect('a')]);
    const second = client(document, awareness, board);
    expect(second.board.isElementLocked('a')).toBe(true);
    expect(second.board.selection.ids).toEqual([]);
  });

  test('loading content preserves reserved elements and cannot remove their connectors indirectly', () => {
    const [first, second] = pair();
    connectPresence(first, second);
    first.board.elements.add(
      [
        {
          id: 'line',
          type: 'connector',
          z: 1,
          start: { kind: 'element', id: 'a' },
          end: { kind: 'point', x: 200, y: 0 },
          route: 'straight',
          dash: 'solid',
          startCap: 'none',
          endCap: 'none',
          stroke: 0,
          strokeWidth: 1,
        },
      ],
      { select: false },
    );
    first.board.selection.set(['a']);
    second.board.elements.remove(['a']);
    expect(second.board.scene.has('line')).toBe(true);
    second.board.elements.load([{ ...rect('a'), x: 99 }]);
    expect(x(first.board)).toBe(0);
    expect(x(second.board)).toBe(0);
  });
});
