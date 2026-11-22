// @vitest-environment happy-dom
import { Camera, Scene, textBlock, type ShapeElement } from '@apeiro/core';
import type { BoardRenderer } from '../../renderer/src/renderer';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { TextEditor } from '../../editor/src/text-editor/text-editor';
import { TextToolbar } from '../../../apps/playground/src/TextToolbar';

const context = vi.hoisted(() => ({ editor: null as TextEditor | null }));
vi.mock('@apeiro/react', () => ({
  useBoard: () => ({ text: context.editor }),
  useTextEditing: () => ({ id: 'text', format: context.editor!.format }),
  useFloating: () => ({ ref: undefined, style: {} }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  cleanup.length = 0;
  context.editor = null;
});

test.each([false, true])(
  'font-size input keeps text and focus (selected: %s)',
  async (selected) => {
    const container = document.createElement('div');
    document.body.append(container);
    cleanup.push(() => container.remove());
    const scene = new Scene();
    const element: ShapeElement = {
      id: 'text',
      type: 'text',
      x: 0,
      y: 0,
      width: 300,
      height: 100,
      rotation: 0,
      z: 0,
      fill: 0,
      stroke: 0,
      strokeWidth: 0,
      radius: 0,
      text: textBlock('Keep this text'),
    };
    scene.add(element);
    const renderer = {
      onAfterRender: () => () => undefined,
      setTextHidden: vi.fn(),
      textLayout: () => ({ scale: 1 }),
      drawnColor: (_type: string, color: number) => color,
    } as unknown as BoardRenderer;
    const editor = new TextEditor(container, scene, new Camera(), renderer);
    context.editor = editor;
    cleanup.push(() => editor.destroy());
    editor.start('text');
    const textInput = container.querySelector<HTMLElement>('.ap-text-editor-input')!;
    if (selected) {
      const range = document.createRange();
      range.selectNodeContents(textInput);
      range.setEnd(textInput.firstElementChild!.firstElementChild!.firstChild!, 4);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }
    const toolbar = document.createElement('div');
    container.append(toolbar);
    const root = createRoot(toolbar);
    cleanup.push(() => act(() => root.unmount()));
    await act(() => root.render(<TextToolbar />));
    const field = toolbar.querySelector<HTMLInputElement>('input.size')!;
    await act(() => field.focus());

    // Use the browser setter so React receives an actual value change.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const size of [32, 33, 34]) {
      await act(() => {
        setValue.call(field, String(size));
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(editor.format?.fontSize).toBe(size);
      expect(document.activeElement).toBe(field);
      expect(textInput.textContent).toBe('Keep this text');
      expect(editor.editing).toBe('text');
      if (selected) {
        expect((scene.get('text') as ShapeElement).text?.runs).toEqual([
          { text: 'Keep', size },
          { text: ' this text' },
        ]);
      }
    }

    // Enter must not carry its default action into the contenteditable after blur.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(() => field.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect((scene.get('text') as ShapeElement).text?.runs.map((run) => run.text).join('')).toBe(
      'Keep this text',
    );
    editor.undo();
    expect(editor.format?.fontSize).toBe(33);
    expect(textInput.textContent).toBe('Keep this text');
  },
);
