// @vitest-environment happy-dom
import { hexColor, type BoardElement, type ShapeElement } from '@apeiro/core';
import { BoardEditor } from '@apeiro/editor';
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BoardProvider, Element, Ellipse, Polygon, Rect, Sticky, Text } from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let board: BoardEditor;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  board = new BoardEditor();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  board.destroy();
  host.remove();
});
const render = async (children: ReactNode) => {
  await act(async () =>
    root.render(
      <StrictMode>
        <BoardProvider editor={board}>{children}</BoardProvider>
      </StrictMode>,
    ),
  );
};

describe('declarative elements', () => {
  test('StrictMode mounts once, assigns paint order and removes on unmount', async () => {
    const changes: string[] = [];
    board.scene.subscribe((change) => changes.push(...change.removed));
    await render(
      <>
        <Rect id="rect" />
        <Sticky id="sticky" text="Hello" />
      </>,
    );
    expect(board.scene.size).toBe(2);
    expect(changes).toEqual([]);
    expect(board.scene.get('sticky')!.z).toBeGreaterThan(board.scene.get('rect')!.z);
    expect(board.history.canUndo).toBe(false);
    expect(host.textContent).toBe('');
    await render(null);
    expect(board.scene.size).toBe(0);
    expect(changes.sort()).toEqual(['rect', 'sticky']);
  });

  test('changed props update only those fields and keep live geometry and rich text', async () => {
    const node = (fill: string) => (
      <Sticky
        id="note"
        x={10}
        fill={fill}
        text={{
          runs: [{ text: 'Original' }],
          fontSize: 20,
          color: 0,
          align: 'left',
          verticalAlign: 'top',
        }}
      />
    );
    await render(node('#fff'));
    await act(async () => {
      board.scene.update('note', {
        x: 80,
        width: 240,
        text: {
          runs: [{ text: 'Edited', bold: true }],
          fontSize: 20,
          color: 0,
          align: 'left',
          verticalAlign: 'top',
        },
      });
    });
    const editedText = (board.scene.get('note') as ShapeElement).text;
    await render(node('#f00'));
    expect(board.scene.get('note')).toMatchObject({ x: 80, width: 240, fill: hexColor('#f00') });
    expect((board.scene.get('note') as ShapeElement).text).toBe(editedText);
    await render(<Sticky id="note" x={25} fill="#f00" text="From React" />);
    expect(board.scene.get('note')).toMatchObject({
      x: 25,
      width: 240,
      text: { runs: [{ text: 'From React' }] },
    });
  });

  test('removed optional props reset, and a user deletion stays deleted on rerender', async () => {
    await render(<Rect id="a" fill="#f00" groupId="g" z={12} />);
    await render(<Rect id="a" />);
    expect(board.scene.get('a')).toMatchObject({
      fill: hexColor('#fff'),
      groupId: undefined,
      z: 1,
    });
    await act(async () => {
      board.scene.remove('a');
    });
    await render(<Rect id="a" x={50} />);
    expect(board.scene.has('a')).toBe(false);
    await act(async () => board.history.undo());
    expect(board.scene.has('a')).toBe(true);
  });

  test('a changed id or kind replaces the owned element without leaking the old one', async () => {
    await render(<Rect id="a" />);
    await render(<Rect id="b" />);
    expect([...board.scene.all()].map((e) => e.id)).toEqual(['b']);
    await render(<Ellipse id="b" />);
    expect(board.scene.size).toBe(1);
    expect(board.scene.get('b')?.type).toBe('ellipse');
  });

  test('adopts existing remote data and reports edits using the latest callback', async () => {
    const first = vi.fn();
    const second = vi.fn();
    await render(<Rect id="a" x={5} onChange={first} />);
    await render(<Rect id="a" x={5} onChange={second} />);
    await act(async () => {
      board.scene.transact(() => board.scene.update('a', { x: 75 }), 'remote');
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ x: 75 }));
    await render(<Rect id="a" x={15} onChange={second} />);
    expect(second).toHaveBeenCalledTimes(1);
    await render(null);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('adopts saved data and works on read-only boards', async () => {
    await render(<Rect id="a" x={40} />);
    const saved = board.scene.get('a')!;
    await render(null);
    board.scene.add(saved);
    board.setReadOnly(true);
    await render(<Rect id="a" x={0} />);
    expect(board.scene.get('a')?.type).toBe('rect');
    expect((board.scene.get('a') as ShapeElement).x).toBe(40);
    await render(<Rect id="a" x={10} />);
    expect((board.scene.get('a') as ShapeElement).x).toBe(10);
    await render(null);
    expect(board.scene.size).toBe(0);
  });

  test('shape defaults, generated ids, packed colors and generic connectors', async () => {
    const line: BoardElement = {
      id: 'line',
      type: 'connector',
      z: 4,
      start: { kind: 'point', x: 0, y: 0 },
      end: { kind: 'point', x: 50, y: 50 },
      route: 'straight',
      dash: 'solid',
      startCap: 'none',
      endCap: 'arrow',
      stroke: 0,
      strokeWidth: 2,
    };
    await render(
      <>
        <Rect fill={0x112233ff} />
        <Ellipse />
        <Polygon sides={6} />
        <Text text={'Hello\r\nReact'} />
        <Element element={line} />
      </>,
    );
    await render(
      <>
        <Rect fill={0x112233ff} />
        <Ellipse />
        <Polygon sides={6} />
        <Text text={'Hello\r\nReact'} />
        <Element element={{ ...line, strokeWidth: 5 }} />
      </>,
    );
    expect(board.scene.size).toBe(5);
    const text = [...board.scene.all()].find((e) => e.type === 'text') as ShapeElement;
    expect(text.text).toMatchObject({ sizing: 'fixed', runs: [{ text: 'Hello\nReact' }] });
    expect([...board.scene.all()].find((e) => e.type === 'rect')).toMatchObject({
      fill: 0x112233ff,
    });
    await render(<Element element={{ ...line, strokeWidth: 5 }} />);
    expect(board.scene.size).toBe(1);
    expect(board.scene.get('line')).toMatchObject({ strokeWidth: 5 });
  });
});
