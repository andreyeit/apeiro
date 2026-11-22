// @vitest-environment happy-dom
import { Camera, textBlock, type ShapeElement } from '@apeiro/core';
import { BoardEditor } from '@apeiro/editor';
import type { BoardRenderer } from '@apeiro/renderer';
import { afterEach, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { TextEditor } from '../../../editor/src/text-editor/text-editor';
import { bindYjs } from '../yjs';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const sharedDocument = new Y.Doc();
  const board = new BoardEditor();
  bindYjs(board, { document: sharedDocument });
  board.elements.add([
    {
      id: 'text',
      type: 'rect',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      rotation: 0,
      z: 0,
      fill: 0,
      stroke: 0,
      strokeWidth: 0,
      radius: 0,
      text: textBlock('ab'),
    },
  ]);
  const container = document.createElement('div');
  document.body.append(container);
  const renderer = {
    onAfterRender: () => () => undefined,
    setTextHidden: vi.fn(),
    textLayout: () => ({ scale: 1 }),
    drawnColor: (_type: string, color: number) => color,
  } as unknown as BoardRenderer;
  const editor = new TextEditor(container, board.scene, new Camera(), renderer, {
    collaborative: true,
    beginGroup: () => undefined,
    endGroup: () => undefined,
    undo: () => {
      board.history.undo();
      return [];
    },
    redo: () => {
      board.history.redo();
      return [];
    },
  });
  const secondDocument = new Y.Doc();
  const remote = new BoardEditor();
  bindYjs(remote, { document: secondDocument });
  Y.applyUpdate(secondDocument, Y.encodeStateAsUpdate(sharedDocument));
  secondDocument.on('update', (update: Uint8Array) => Y.applyUpdate(sharedDocument, update));
  sharedDocument.on('update', (update: Uint8Array) => Y.applyUpdate(secondDocument, update));
  cleanups.push(() => {
    editor.destroy();
    container.remove();
    board.destroy();
    remote.destroy();
    sharedDocument.destroy();
    secondDocument.destroy();
  });
  editor.start('text');
  return {
    board,
    remote,
    editor,
    input: container.querySelector<HTMLElement>('.ap-text-editor-input')!,
  };
}

test('IME composition preserves remote insertions received while the DOM is composing', () => {
  const { board, remote, input } = setup();
  input.dispatchEvent(new Event('compositionstart'));
  input.textContent = 'ab中';
  const range = document.createRange();
  range.selectNodeContents(input);
  range.collapse(false);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  remote.scene.update('text', { text: textBlock('!ab') });
  expect(input.textContent).toBe('ab中');
  input.dispatchEvent(new Event('compositionend'));
  expect((board.scene.get('text') as ShapeElement).text?.runs.map((run) => run.text).join('')).toBe(
    '!ab中',
  );
  expect((remote.scene.get('text') as ShapeElement).text).toEqual(
    (board.scene.get('text') as ShapeElement).text,
  );
});

test('text undo uses shared operations and preserves remote text', () => {
  const { board, remote, editor, input } = setup();
  input.textContent = 'abX';
  input.dispatchEvent(new Event('input'));
  remote.scene.update('text', { text: textBlock('!abX') });
  editor.undo();
  expect((board.scene.get('text') as ShapeElement).text?.runs.map((run) => run.text).join('')).toBe(
    '!ab',
  );
  editor.redo();
  expect((board.scene.get('text') as ShapeElement).text?.runs.map((run) => run.text).join('')).toBe(
    '!abX',
  );
});

test('remote deletion closes the active text editor', () => {
  const { remote, editor } = setup();
  remote.scene.remove('text');
  expect(editor.editing).toBeNull();
});
