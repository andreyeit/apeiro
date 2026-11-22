import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Server } from 'socket.io';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { BoardEditor } from '@apeiro/editor';
import type { ShapeElement } from '@apeiro/core';
import { bindYjs } from '../yjs';
import { connectSocketRoom, type SocketRoomOptions } from './provider';
import { attachSocketRooms, type SocketRoomsOptions } from './server';
import { socketIO, type SocketIOOptions } from './adapter';
import { collaborationAdapter } from '../react/collaboration';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function server(options: SocketRoomsOptions = {}) {
  const http = createServer();
  const io = new Server(http, { transports: ['websocket'] });
  const rooms = attachSocketRooms(io, options);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    rooms.destroy();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { url, io, rooms };
}
function client(url: string, roomId = 'test', options: SocketRoomOptions = {}) {
  const provider = connectSocketRoom(url, roomId, {
    syncTimeout: 1000,
    onError: vi.fn(),
    ...options,
    socketOptions: { transports: ['websocket'], reconnectionDelay: 10, ...options.socketOptions },
  });
  cleanups.push(() => provider.destroy());
  return provider;
}
const eventually = async (assertion: () => void) => {
  await vi.waitFor(assertion, { timeout: 4000, interval: 10 });
};
const rect: ShapeElement = {
  id: 'a',
  type: 'rect',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  z: 1,
  rotation: 0,
  fill: 0,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
};
function board(provider: ReturnType<typeof client>) {
  const editor = new BoardEditor();
  bindYjs(editor, {
    document: provider.document,
    awareness: provider.awareness,
    showPresence: false,
  });
  cleanups.push(() => editor.destroy());
  return editor;
}

describe('Socket.IO rooms', () => {
  test('synchronizes two clients, isolates rooms and does not echo document changes', async () => {
    const host = await server();
    const first = client(host.url),
      second = client(host.url),
      other = client(host.url, 'other');
    await Promise.all([first.whenSynced, second.whenSynced, other.whenSynced]);
    const firstUpdates = vi.fn(),
      secondUpdates = vi.fn();
    first.document.on('update', firstUpdates);
    second.document.on('update', secondUpdates);
    first.document.getMap('data').set('message', 'hello');
    await eventually(() => expect(second.document.getMap('data').get('message')).toBe('hello'));
    expect(firstUpdates).toHaveBeenCalledTimes(1);
    expect(secondUpdates).toHaveBeenCalledTimes(1);
    expect(other.document.getMap('data').size).toBe(0);
    const third = client(host.url);
    await third.whenSynced;
    expect(third.document.getMap('data').get('message')).toBe('hello');
  });

  test('restores persisted state before first sync and includes edits made during loading', async () => {
    const persisted = new Y.Doc();
    persisted.getMap('data').set('saved', 1);
    cleanups.push(() => persisted.destroy());
    let finish!: (snapshot: Uint8Array) => void;
    const load = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finish = resolve;
        }),
    );
    const host = await server({ load });
    const provider = client(host.url);
    await eventually(() => expect(load).toHaveBeenCalledTimes(1));
    expect(provider.status).toBe('connecting');
    provider.document.getMap('data').set('during-sync', 2);
    finish(Y.encodeStateAsUpdate(persisted));
    await provider.whenSynced;
    expect(provider.document.getMap('data').get('saved')).toBe(1);
    await eventually(() =>
      expect(host.rooms.getDocument('test')?.getMap('data').get('during-sync')).toBe(2),
    );
  });

  test('reconnects with offline edits and receives edits missed while disconnected', async () => {
    const host = await server();
    const first = client(host.url),
      second = client(host.url);
    await Promise.all([first.whenSynced, second.whenSynced]);
    first.socket.disconnect();
    first.document.getMap('data').set('offline', 'first');
    second.document.getMap('data').set('online', 'second');
    first.socket.connect();
    await eventually(() => expect(first.status).toBe('connected'));
    await eventually(() => {
      expect(first.document.getMap('data').get('online')).toBe('second');
      expect(second.document.getMap('data').get('offline')).toBe('first');
    });
  });

  test('selection locks travel over sockets and expired reservations cannot steal a new owner on reconnect', async () => {
    const host = await server();
    const first = client(host.url),
      second = client(host.url);
    const a = board(first),
      b = board(second);
    await Promise.all([first.whenSynced, second.whenSynced]);
    a.elements.add([rect], { select: false });
    await eventually(() => expect(b.scene.has('a')).toBe(true));
    a.selection.set(['a']);
    await eventually(() => expect(b.isElementLocked('a')).toBe(true));
    b.elements.update(['a'], { x: 50 });
    expect((b.scene.get('a') as ShapeElement).x).toBe(0);
    first.socket.disconnect();
    await eventually(() => expect(b.isElementLocked('a')).toBe(false));
    b.selection.set(['a']);
    first.socket.connect();
    await eventually(() => expect(first.status).toBe('connected'));
    await eventually(() => {
      expect(a.isElementLocked('a')).toBe(true);
      expect(a.selection.ids).toEqual([]);
      expect(b.isElementLocked('a')).toBe(false);
    });
    b.selection.clear();
    await eventually(() => expect(a.isElementLocked('a')).toBe(false));
  });

  test('automatically reconnects after a dropped transport and resumes updates', async () => {
    const host = await server();
    const first = client(host.url),
      second = client(host.url);
    await Promise.all([first.whenSynced, second.whenSynced]);
    const previousId = first.socket.id;
    host.io.sockets.sockets.get(previousId!)!.conn.close();
    await eventually(() => {
      expect(first.status).toBe('connected');
      expect(first.socket.id).not.toBe(previousId);
    });
    first.document.getMap('data').set('reconnected', true);
    await eventually(() => expect(second.document.getMap('data').get('reconnected')).toBe(true));
  });

  test('passes room updates to persistence and reports persistence failures', async () => {
    const failure = new Error('Storage unavailable');
    const onError = vi.fn();
    const onUpdate = vi.fn<NonNullable<SocketRoomsOptions['onUpdate']>>(async () => {
      throw failure;
    });
    const host = await server({ onUpdate, onError });
    const provider = client(host.url);
    await provider.whenSynced;
    provider.document.getMap('data').set('persist', 42);
    await eventually(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(onUpdate.mock.calls[0]?.[0]).toBe('test');
    expect(provider.status).toBe('connected');
    expect(host.rooms.getDocument('test')?.getMap('data').get('persist')).toBe(42);
  });

  test('rejects unauthorized rooms before loading or exposing their document', async () => {
    const load = vi.fn();
    const host = await server({ authorize: () => false, load });
    const provider = client(host.url);
    await expect(provider.whenSynced).rejects.toThrow('Room access denied');
    expect(provider.status).toBe('error');
    expect(load).not.toHaveBeenCalled();
    expect(host.rooms.getDocument('test')).toBeUndefined();
  });

  test('retries sync timeouts and shares an in-flight document load', async () => {
    let finish!: () => void;
    const load = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const host = await server({ load });
    const provider = client(host.url, 'slow', { syncTimeout: 30 });
    await eventually(() => expect(load).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    finish();
    await provider.whenSynced;
    expect(load).toHaveBeenCalledTimes(1);
    expect(provider.status).toBe('connected');
  });

  test('destroy is idempotent, releases presence and preserves external resources', async () => {
    const host = await server();
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    cleanups.push(() => {
      awareness.destroy();
      doc.destroy();
    });
    const first = client(host.url, 'test', { document: doc, awareness }),
      second = client(host.url);
    await Promise.all([first.whenSynced, second.whenSynced]);
    awareness.setLocalStateField('user', 'first');
    await eventually(() => expect(second.awareness.getStates().has(doc.clientID)).toBe(true));
    first.destroy();
    first.destroy();
    await eventually(() => expect(second.awareness.getStates().has(doc.clientID)).toBe(false));
    expect(first.status).toBe('destroyed');
    expect(doc.isDestroyed).toBe(false);
    awareness.setLocalStateField('still-usable', true);
    expect(awareness.getLocalState()?.['still-usable']).toBe(true);
  });

  test('a pending provider can be destroyed without a late sync reviving it', async () => {
    let finish!: () => void;
    const host = await server({
      load: () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    });
    const provider = client(host.url);
    await eventually(() => expect(finish).toBeTypeOf('function'));
    provider.destroy();
    finish();
    await expect(provider.whenSynced).rejects.toThrow('destroyed');
    expect(provider.document.isDestroyed).toBe(true);
    expect(provider.status).toBe('destroyed');
  });

  test('clients cannot publish presence for a different document client', async () => {
    const onError = vi.fn();
    const host = await server({ onError });
    const first = client(host.url),
      second = client(host.url);
    await Promise.all([first.whenSynced, second.whenSynced]);
    first.awareness.setLocalStateField('user', 'first');
    const before = first.awareness.getLocalState();
    second.socket.emit(
      'apeiro:awareness',
      encodeAwarenessUpdate(first.awareness, [first.document.clientID]),
    );
    await eventually(() => expect(second.status).toBe('error'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(first.awareness.getLocalState()).toEqual(before);
  });
});

function connectBoard(options: SocketIOOptions) {
  const editor = new BoardEditor();
  const adapter = socketIO({
    ...options,
    socketOptions: { transports: ['websocket'], ...options.socketOptions },
  });
  const connection = adapter.connect(editor, vi.fn());
  cleanups.push(() => {
    connection.destroy();
    editor.destroy();
  });
  return { editor, adapter, connection };
}

describe('declarative socketIO adapter', () => {
  test('creating inline descriptors opens no sockets and leaves external documents untouched', async () => {
    const host = await server();
    const doc = new Y.Doc();
    cleanups.push(() => doc.destroy());
    const first = socketIO({ url: host.url, roomId: 'test', document: doc });
    const second = socketIO({ url: host.url, roomId: 'test', document: doc });
    expect(first.key).toEqual(second.key);
    expect(host.io.sockets.sockets.size).toBe(0);
    expect(host.rooms.getDocument('test')).toBeUndefined();
    expect(doc.isDestroyed).toBe(false);
  });

  test('creates resources, syncs and seeds before ready, and releases its socket on destroy', async () => {
    const host = await server();
    const first = connectBoard({ url: host.url, roomId: 'test', initialElements: [rect] });
    await first.connection.ready;
    const second = connectBoard({ url: host.url, roomId: 'test' });
    await second.connection.ready;
    expect(second.editor.scene.has('a')).toBe(true);
    first.editor.elements.update(['a'], { x: 123 });
    await eventually(() => expect((second.editor.scene.get('a') as ShapeElement).x).toBe(123));
    first.connection.destroy();
    first.connection.destroy();
    await eventually(() => expect(host.io.sockets.sockets.size).toBe(1));
    expect(first.editor.isDestroyed).toBe(false);
  });

  test('updates inline user config without reconnecting or resetting history', async () => {
    const host = await server();
    const options: SocketIOOptions = {
      url: host.url,
      roomId: 'test',
      user: { name: 'Alice', color: '#2563eb' },
      socketOptions: { transports: ['websocket'], auth: { token: 'token' } },
    };
    const first = connectBoard(options);
    const observer = client(host.url);
    await Promise.all([first.connection.ready, observer.whenSynced]);
    first.editor.elements.add([rect], { select: false });
    const ids = [...host.io.sockets.sockets.keys()];
    const next = socketIO({
      ...options,
      user: { name: 'Updated', color: '#db2777' },
      socketOptions: { auth: { token: 'token' }, transports: ['websocket'] },
    });
    expect(next.key).toEqual(first.adapter.key);
    next.update?.(first.connection);
    await eventually(() =>
      expect(
        [...observer.awareness.getStates().values()].some(
          (state) =>
            (state['apeiro:apeiro'] as { user?: { name: string } })?.user?.name === 'Updated',
        ),
      ).toBe(true),
    );
    expect([...host.io.sockets.sockets.keys()]).toEqual(ids);
    expect(first.editor.history.canUndo).toBe(true);
    expect(socketIO({ ...options, roomId: 'other' }).key).not.toEqual(next.key);
    expect(socketIO({ ...options, socketOptions: { auth: { token: 'changed' } } }).key).not.toEqual(
      next.key,
    );
  });

  test('preserves supplied document and Awareness and releases reservations on board destruction', async () => {
    const host = await server();
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    cleanups.push(() => {
      awareness.destroy();
      doc.destroy();
    });
    const first = connectBoard({ url: host.url, roomId: 'test', document: doc, awareness });
    const observer = client(host.url);
    const second = board(observer);
    await Promise.all([first.connection.ready, observer.whenSynced]);
    first.editor.elements.add([rect]);
    await eventually(() => expect(second.isElementLocked('a')).toBe(true));
    first.editor.destroy();
    await eventually(() => expect(second.isElementLocked('a')).toBe(false));
    expect(doc.isDestroyed).toBe(false);
    awareness.setLocalStateField('usable', true);
    expect(awareness.getLocalState()?.['usable']).toBe(true);
    await eventually(() => expect(host.io.sockets.sockets.size).toBe(1));
  });

  test('rejects initial authorization errors and stops a pending connection on cleanup', async () => {
    const host = await server({ authorize: () => false });
    const onError = vi.fn();
    const first = connectBoard({ url: host.url, roomId: 'test', onError });
    await expect(first.connection.ready).rejects.toThrow('Room access denied');
    expect(onError).toHaveBeenCalledTimes(1);
    first.connection.destroy();
    await eventually(() => expect(host.io.sockets.sockets.size).toBe(0));
  });

  test('does not seed or stay connected when destroyed during initial synchronization', async () => {
    let finish!: () => void;
    const host = await server({
      load: () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    });
    const doc = new Y.Doc();
    cleanups.push(() => doc.destroy());
    const first = connectBoard({
      url: host.url,
      roomId: 'test',
      document: doc,
      initialElements: [rect],
    });
    await eventually(() => expect(finish).toBeTypeOf('function'));
    first.connection.destroy();
    finish();
    await expect(first.connection.ready).rejects.toThrow('destroyed');
    expect(first.editor.scene.size).toBe(0);
    expect(doc.isDestroyed).toBe(false);
    await eventually(() => expect(host.io.sockets.sockets.size).toBe(0));
  });
});

describe('plain collaboration configuration', () => {
  test('connects Socket.IO lazily and applies live options without reconnecting', async () => {
    const host = await server();
    const options = {
      url: host.url,
      roomId: 'test',
      user: { name: 'Before', color: '#2563eb' },
      socketOptions: { transports: ['websocket'], auth: { token: 'test' } },
      initialElements: [rect],
    };
    const editor = new BoardEditor();
    const adapter = collaborationAdapter(options)!;
    const connection = adapter.connect(editor, vi.fn());
    cleanups.push(() => {
      connection.destroy();
      editor.destroy();
    });
    const pending = collaborationAdapter({
      ...options,
      user: { name: 'During import', color: '#2563eb' },
    })!;
    expect(pending.key).toEqual(adapter.key);
    pending.update?.(connection);
    const observer = client(host.url);
    await Promise.all([connection.ready, observer.whenSynced]);
    await eventually(() => expect(observer.document.getMap('apeiro:elements').has('a')).toBe(true));
    await eventually(() =>
      expect(
        [...observer.awareness.getStates().values()].some(
          (state) =>
            (state['apeiro:apeiro'] as { user?: { name: string } })?.user?.name === 'During import',
        ),
      ).toBe(true),
    );
    editor.elements.update(['a'], { x: 321 });
    const ids = [...host.io.sockets.sockets.keys()];
    collaborationAdapter({
      ...options,
      user: { name: 'After import', color: '#db2777' },
    })!.update?.(connection);
    await eventually(() =>
      expect(
        [...observer.awareness.getStates().values()].some(
          (state) =>
            (state['apeiro:apeiro'] as { user?: { name: string } })?.user?.name === 'After import',
        ),
      ).toBe(true),
    );
    expect([...host.io.sockets.sockets.keys()]).toEqual(ids);
    expect(editor.history.canUndo).toBe(true);
  });

  test('destroying before the lazy import finishes never opens a connection or seeds the document', async () => {
    const host = await server();
    const doc = new Y.Doc();
    const editor = new BoardEditor();
    cleanups.push(() => {
      editor.destroy();
      doc.destroy();
    });
    const adapter = collaborationAdapter({
      url: host.url,
      roomId: 'test',
      document: doc,
      socketOptions: { transports: ['websocket'] },
      initialElements: [rect],
    })!;
    const connection = adapter.connect(editor, vi.fn());
    connection.destroy();
    connection.destroy();
    await connection.ready;
    expect(host.io.sockets.sockets.size).toBe(0);
    expect(host.rooms.getDocument('test')).toBeUndefined();
    expect(editor.scene.size).toBe(0);
    expect(doc.isDestroyed).toBe(false);
  });

  test('document-only configuration uses existing Yjs resources and waits for their sync', async () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const editor = new BoardEditor();
    cleanups.push(() => {
      editor.destroy();
      awareness.destroy();
      doc.destroy();
    });
    let finish!: () => void;
    const whenSynced = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const adapter = collaborationAdapter({
      document: doc,
      awareness,
      whenSynced,
      initialElements: [rect],
    })!;
    const connection = adapter.connect(editor, vi.fn());
    cleanups.push(() => connection.destroy());
    expect(editor.scene.size).toBe(0);
    finish();
    await connection.ready;
    expect(editor.scene.has('a')).toBe(true);
    connection.destroy();
    expect(doc.isDestroyed).toBe(false);
    awareness.setLocalStateField('usable', true);
    expect(awareness.getLocalState()?.['usable']).toBe(true);
  });

  test('forwards rejected room access and preserves explicit custom adapters', async () => {
    const host = await server({ authorize: () => false });
    const editor = new BoardEditor();
    cleanups.push(() => editor.destroy());
    const adapter = collaborationAdapter({
      url: host.url,
      roomId: 'test',
      socketOptions: { transports: ['websocket'] },
    })!;
    const connection = adapter.connect(editor, vi.fn());
    cleanups.push(() => connection.destroy());
    await expect(connection.ready).rejects.toThrow('Room access denied');
    connection.destroy();
    await eventually(() => expect(host.io.sockets.sockets.size).toBe(0));
    const custom = { key: ['custom'], connect: () => ({ destroy: vi.fn() }) };
    expect(collaborationAdapter(custom)).toBe(custom);
  });
});
