// @vitest-environment happy-dom
import { BoardEditor, type BoardCollaboration } from '@apeiro/editor';
import type { ShapeElement } from '@apeiro/core';
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Board, BoardProvider, Rect } from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let editor: BoardEditor, root: Root, host: HTMLDivElement;
beforeEach(() => {
  editor = new BoardEditor();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  editor.destroy();
  host.remove();
  vi.restoreAllMocks();
});
const render = async (node: ReactNode) => {
  await act(async () => root.render(<StrictMode>{node}</StrictMode>));
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('collaboration provider', () => {
  test('standalone Board owns collaboration and preserves its layout while waiting for sync', async () => {
    const sync = deferred();
    const mount = vi.spyOn(BoardEditor.prototype, 'mount').mockResolvedValue();
    vi.spyOn(BoardEditor.prototype, 'isMounted', 'get').mockReturnValue(true);
    let owned!: BoardEditor;
    const destroy = vi.fn();
    const connect = vi.fn((board: BoardEditor) => {
      owned = board;
      return { ready: sync.promise, destroy };
    });
    const node = () => (
      <Board
        className="canvas"
        style={{ height: 400 }}
        config={{ grid: 'dots' }}
        collaboration={{ key: ['standalone'], connect }}
        fallback="Syncing"
      >
        <Rect id="a" />
      </Board>
    );
    await render(node());
    expect(host.querySelector('.ap-host.canvas')?.getAttribute('style')).toContain('height: 400px');
    expect(host.textContent).toBe('Syncing');
    expect(owned.scene.size).toBe(0);
    expect(mount).not.toHaveBeenCalled();
    await act(async () => sync.resolve());
    expect(owned.scene.has('a')).toBe(true);
    owned.elements.update(['a'], { x: 55 });
    await render(node());
    expect(connect).toHaveBeenCalledTimes(1);
    expect((owned.scene.get('a') as ShapeElement).x).toBe(55);
    await render(null);
    expect(destroy).toHaveBeenCalledTimes(1);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(owned.isDestroyed).toBe(true);
  });

  test('standalone Board shows collaboration errors in its canvas box and never mounts the renderer', async () => {
    const error = new Error('Access denied');
    const mount = vi.spyOn(BoardEditor.prototype, 'mount').mockResolvedValue();
    const report = vi.fn(),
      destroy = vi.fn();
    await render(
      <Board
        className="canvas"
        style={{ height: 300 }}
        config={{ onError: report }}
        collaboration={{
          key: ['denied'],
          connect: () => ({ ready: Promise.reject(error), destroy }),
        }}
        errorFallback={(error) => <span>{String(error)}</span>}
      >
        <Rect id="a" />
      </Board>,
    );
    expect(host.querySelector('.ap-host.canvas')?.textContent).toContain('Access denied');
    expect(host.querySelector('.ap-host')?.getAttribute('style')).toContain('height: 300px');
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(mount).not.toHaveBeenCalled();
  });

  test('server rendering a standalone collaborative Board preserves its box and opens no connection', () => {
    const connect = vi.fn(() => ({ destroy: vi.fn() }));
    const html = renderToString(
      <Board
        style={{ height: 400 }}
        collaboration={{ key: ['server'], connect }}
        fallback="Syncing"
      >
        <Rect id="a" />
      </Board>,
    );
    expect(html).toContain('Syncing');
    expect(html).toContain('height:400px');
    expect(connect).not.toHaveBeenCalled();
  });

  test('connects once in StrictMode, before JSX descendants mount, and owns only the connection', async () => {
    const destroy = vi.fn();
    const update = vi.fn();
    const connect = vi.fn((board: BoardEditor) => {
      expect(board.scene.size).toBe(0);
      return { destroy };
    });
    const node = () => (
      <BoardProvider editor={editor} collaboration={{ key: ['room'], connect, update }}>
        <Rect id="a" />
      </BoardProvider>
    );
    await render(node());
    expect(connect).toHaveBeenCalledTimes(1);
    expect(editor.scene.size).toBe(1);
    editor.scene.update('a', { x: 50 });
    await render(node());
    expect(connect).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    expect((editor.scene.get('a') as ShapeElement).x).toBe(50);
    expect(update).toHaveBeenCalled();
    await render(null);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(editor.isDestroyed).toBe(false);
  });

  test('waits for sync before mounting JSX and cancels pending connections', async () => {
    const sync = deferred();
    const destroy = vi.fn();
    const connect = vi.fn(() => ({ ready: sync.promise, destroy }));
    await render(
      <BoardProvider editor={editor} collaboration={{ key: ['room'], connect }} fallback="Syncing">
        <Rect id="a" />
      </BoardProvider>,
    );
    expect(host.textContent).toBe('Syncing');
    expect(editor.scene.size).toBe(0);
    await render(null);
    expect(destroy).toHaveBeenCalledTimes(1);
    await act(async () => sync.resolve());
    expect(editor.scene.size).toBe(0);
  });

  test('shows descendants after sync and uses current live options', async () => {
    const sync = deferred();
    const destroy = vi.fn();
    const updateA = vi.fn(),
      updateB = vi.fn();
    const connect = vi.fn(() => ({ ready: sync.promise, destroy }));
    const node = (update: BoardCollaboration['update']) => (
      <BoardProvider
        editor={editor}
        collaboration={{ key: ['room'], connect, update }}
        fallback="Syncing"
      >
        <Rect id="a" />
      </BoardProvider>
    );
    await render(node(updateA));
    await render(node(updateB));
    await act(async () => sync.resolve());
    expect(editor.scene.size).toBe(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(updateB).toHaveBeenCalled();
  });

  test('changing documents disconnects before descendants are recreated', async () => {
    const order: string[] = [];
    const first: BoardCollaboration = {
      key: ['first'],
      connect: () => ({
        destroy: () => {
          order.push('disconnect first');
        },
      }),
    };
    await render(
      <BoardProvider editor={editor} collaboration={first}>
        <Rect id="a" />
      </BoardProvider>,
    );
    const second: BoardCollaboration = {
      key: ['second'],
      connect: (board) => {
        order.push('connect second');
        expect(board.scene.size).toBe(0);
        board.elements.add(
          [
            {
              id: 'a',
              type: 'rect',
              x: 90,
              y: 0,
              width: 100,
              height: 100,
              z: 0,
              rotation: 0,
              fill: 0,
              stroke: 0,
              strokeWidth: 0,
              radius: 0,
            },
          ],
          { select: false },
        );
        return { destroy: vi.fn() };
      },
    };
    await render(
      <BoardProvider editor={editor} collaboration={second}>
        <Rect id="a" />
      </BoardProvider>,
    );
    expect(order).toEqual(['disconnect first', 'connect second']);
    expect((editor.scene.get('a') as ShapeElement).x).toBe(90);
  });

  test('reports connection and sync errors once and renders an error fallback', async () => {
    const failure = new Error('Offline');
    const report = vi.fn();
    const destroy = vi.fn();
    const sync = deferred();
    const failedSync = sync.promise.then(() => {
      throw failure;
    });
    await render(
      <BoardProvider
        editor={editor}
        collaboration={{ key: ['bad'], connect: () => ({ ready: failedSync, destroy }) }}
        config={{ onError: report }}
        errorFallback={(error) => <span>{String(error)}</span>}
      >
        <Rect id="a" />
      </BoardProvider>,
    );
    await act(async () => sync.resolve());
    expect(host.textContent).toContain('Offline');
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(editor.scene.size).toBe(0);
    await render(null);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test('server rendering never connects and renders the sync fallback', () => {
    const connect = vi.fn(() => ({ destroy: vi.fn() }));
    const html = renderToString(
      <BoardProvider
        editor={editor}
        collaboration={{ key: ['server'], connect }}
        fallback={<p>Syncing</p>}
      >
        <Rect id="a" />
      </BoardProvider>,
    );
    expect(html).toContain('Syncing');
    expect(connect).not.toHaveBeenCalled();
    expect(editor.scene.size).toBe(0);
  });
  test('synchronous connection failures report once without mounting children', async () => {
    const error = new Error('Cannot connect');
    const onError = vi.fn();
    const connect = vi.fn(() => {
      throw error;
    });
    await render(
      <BoardProvider
        editor={editor}
        collaboration={{ key: ['failure'], connect }}
        config={{ onError }}
        errorFallback="Failed"
      >
        <Rect id="a" />
      </BoardProvider>,
    );
    expect(host.textContent).toBe('Failed');
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(editor.scene.size).toBe(0);
  });

  test('an owned board and its connection are released after unmount', async () => {
    let owned!: BoardEditor;
    const destroy = vi.fn();
    await render(
      <BoardProvider
        collaboration={{
          key: ['owned'],
          connect: (board) => {
            owned = board;
            return { destroy };
          },
        }}
      >
        <Rect id="a" />
      </BoardProvider>,
    );
    expect(owned.scene.size).toBe(1);
    await render(null);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(owned.isDestroyed).toBe(true);
  });
});
