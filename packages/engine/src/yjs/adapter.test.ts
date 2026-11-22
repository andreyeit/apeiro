import { afterEach, describe, expect, test, vi } from 'vitest';
import { BoardEditor } from '@apeiro/editor';
import { textBlock, type ShapeElement } from '@apeiro/core';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { yjs } from '../yjs';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const rect = (id: string, x = 0): ShapeElement => ({
  id,
  type: 'rect',
  x,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  z: 1,
  fill: 0,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
  text: textBlock('Seed'),
});
const document = () => {
  const doc = new Y.Doc();
  cleanups.push(() => doc.destroy());
  return doc;
};
const board = () => {
  const editor = new BoardEditor();
  cleanups.push(() => editor.destroy());
  return editor;
};
function connect(options: Parameters<typeof yjs>[0], editor = board()) {
  const adapter = yjs(options);
  const connection = adapter.connect(editor, vi.fn());
  cleanups.push(() => connection.destroy());
  return { adapter, connection, board: editor };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Yjs adapter', () => {
  test('factory is inert and equivalent inline options share a connection key', () => {
    const doc = document();
    const before = Y.encodeStateAsUpdate(doc);
    const first = yjs({ document: doc, user: { name: 'First', color: '#2563eb' } });
    const second = yjs({
      document: doc,
      user: { name: 'Second', color: '#db2777' },
      showPresence: false,
    });
    expect(second.key).toEqual(first.key);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(yjs({ document: document() }).key).not.toEqual(first.key);
  });

  test('seeds after sync, without undo steps, and does not reseed an emptied document', async () => {
    const doc = document();
    const sync = deferred();
    const first = connect({
      document: doc,
      whenSynced: sync.promise,
      initialElements: [rect('a')],
    });
    expect(first.board.scene.size).toBe(0);
    sync.resolve();
    await first.connection.ready;
    expect(first.board.scene.size).toBe(1);
    expect(first.board.history.canUndo).toBe(false);
    first.board.elements.load([]);
    first.connection.destroy();
    const second = connect({ document: doc, initialElements: [rect('a')] });
    await second.connection.ready;
    expect(second.board.scene.size).toBe(0);
    expect(doc.isDestroyed).toBe(false);
  });

  test('incoming content wins over initialElements while awaiting sync', async () => {
    const savedDocument = document();
    const remote = connect({ document: savedDocument, initialElements: [rect('saved', 75)] });
    await remote.connection.ready;
    const sync = deferred();
    const doc = document();
    const joining = connect({
      document: doc,
      whenSynced: sync.promise,
      initialElements: [rect('seed')],
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(savedDocument));
    sync.resolve();
    await joining.connection.ready;
    expect([...joining.board.scene.all()].map((e) => e.id)).toEqual(['saved']);
    expect((joining.board.scene.get('saved') as ShapeElement).x).toBe(75);
  });

  test('concurrent seeds with stable ids converge without duplicate elements or text', async () => {
    const a = document(),
      b = document();
    const first = connect({ document: a, initialElements: [rect('a')] });
    const second = connect({ document: b, initialElements: [rect('a')] });
    await Promise.all([first.connection.ready, second.connection.ready]);
    const aUpdate = Y.encodeStateAsUpdate(a);
    const bUpdate = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, bUpdate);
    Y.applyUpdate(b, aUpdate);
    expect(first.board.elements.getAll()).toEqual(second.board.elements.getAll());
    expect(first.board.scene.size).toBe(1);
    expect((first.board.scene.get('a') as ShapeElement).text?.runs).toEqual([{ text: 'Seed' }]);
  });

  test('unmount before sync prevents late seeding and leaves external resources alive', async () => {
    const doc = document();
    const sync = deferred();
    const editor = board();
    const first = connect(
      { document: doc, whenSynced: sync.promise, initialElements: [rect('a')] },
      editor,
    );
    first.connection.destroy();
    sync.resolve();
    await first.connection.ready;
    expect(doc.getMap('apeiro:elements').size).toBe(0);
    expect(editor.isDestroyed).toBe(false);
    expect(doc.isDestroyed).toBe(false);
    const second = connect({ document: doc }, editor);
    await second.connection.ready;
    editor.elements.add([rect('local')]);
    expect(doc.getMap('apeiro:elements').has('local')).toBe(true);
  });

  test('live user and error settings update without losing undo history', async () => {
    const doc = document();
    const awareness = new Awareness(doc);
    cleanups.push(() => awareness.destroy());
    const initialError = vi.fn();
    const nextError = vi.fn();
    const first = connect({
      document: doc,
      awareness,
      user: { name: 'First', color: '#2563eb' },
      onError: initialError,
    });
    await first.connection.ready;
    first.board.elements.add([rect('a')], { select: false });
    const changed = yjs({
      document: doc,
      awareness,
      user: { name: 'Updated', color: '#db2777' },
      showPresence: false,
      onError: nextError,
    });
    changed.update!(first.connection);
    const published = awareness.getLocalState()?.['apeiro:apeiro'] as
      | { user: { name: string } }
      | undefined;
    expect(published?.user.name).toBe('Updated');
    expect(first.board.history.canUndo).toBe(true);
    first.board.history.undo();
    expect(first.board.scene.size).toBe(0);
    doc.getMap('apeiro:elements').set('invalid', 42);
    expect(initialError).not.toHaveBeenCalled();
    expect(nextError).toHaveBeenCalledTimes(1);
  });

  test('invalid initial data is rejected before any seed is written', async () => {
    const doc = document();
    const first = connect({ document: doc, initialElements: [rect('a'), rect('a')] });
    await expect(first.connection.ready).rejects.toThrow('Duplicate initial element');
    expect(first.board.scene.size).toBe(0);
    expect(doc.getMap('apeiro:initialized').size).toBe(0);
  });
  test('destroying an external document during sync prevents late initialization', async () => {
    const doc = document();
    const sync = deferred();
    const first = connect({
      document: doc,
      whenSynced: sync.promise,
      initialElements: [rect('a')],
    });
    doc.destroy();
    sync.resolve();
    await expect(first.connection.ready).rejects.toThrow('was destroyed');
    expect(first.board.scene.size).toBe(0);
  });
});
