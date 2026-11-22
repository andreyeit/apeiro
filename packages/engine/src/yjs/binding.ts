import {
  validateElement,
  type BoardElement,
  type SceneChanges,
  type TextBlock,
} from '@apeiro/core';
import type { BoardEditor } from '@apeiro/editor';
import * as Y from 'yjs';
import { SharedHistory } from './history';
import {
  bindPresence,
  type BoardPresence,
  type PresenceUser,
  type PresenceAwareness,
} from './presence';
import { equal, readText, writeFields, writeText } from './text';

export interface YjsOptions {
  /** Owned by your application; the binding never destroys it or its provider. */
  document: Y.Doc;
  /** Shared collection name. Use different names for boards in the same document. */
  name?: string;
  /** Optional presence supplied by your provider. */
  awareness?: PresenceAwareness;
  user?: PresenceUser;
  /** Draw remote cursors and selected element bounds. Default true. */
  showPresence?: boolean;
  /** Invalid remote data is reported and the last valid scene state is retained. */
  onError?: (error: unknown) => void;
}

export interface YjsBinding {
  readonly document: Y.Doc;
  /** Current remote participants, including their cursors and selections. */
  readonly peers: readonly BoardPresence[];
  setUser(user: PresenceUser): void;
  setShowPresence(show: boolean): void;
  subscribePresence(listener: () => void): () => void;
  /** Disconnect, retain the visible content and restore a fresh local undo history. Idempotent. */
  destroy(): void;
}

const bindings = new WeakMap<BoardEditor, YjsBinding>();

/**
 * Connect an editor to an authoritative shared document, before or after mounting.
 * Existing scene content is replaced. Import saved elements once after the provider's
 * initial sync, through the usual board commands; never seed every joining client.
 */
export function bindYjs(board: BoardEditor, options: YjsOptions): YjsBinding {
  if (board.isDestroyed) throw new Error('Cannot bind a destroyed board');
  if (bindings.has(board)) throw new Error('This board already has a Yjs binding');
  board.text.stop();
  const { document: sharedDocument } = options;
  const elements = sharedDocument.getMap<Y.Map<unknown>>(`${options.name ?? 'apeiro'}:elements`);
  const origin = {};
  const report = options.onError ?? console.error;
  let destroyed = false;

  const read = (id: string): BoardElement | undefined => {
    const record = elements.get(id);
    if (record === undefined) return undefined;
    if (!(record instanceof Y.Map)) throw new Error(`Invalid shared element ${id}`);
    const value = Object.fromEntries(record) as Record<string, unknown>;
    if (value.text instanceof Y.Map) value.text = readText(value.text);
    const problem = validateElement(value as unknown as BoardElement);
    if (problem || value.id !== id)
      throw new Error(`Invalid shared element ${id}: ${problem ?? 'id mismatch'}`);
    return structuredClone(value) as unknown as BoardElement;
  };
  const apply = (ids: Iterable<string>): void => {
    // Validate every touched element before mutating the scene: Scene.transact does not roll back.
    const next = [...ids].map((id) => [id, read(id)] as const);
    board.scene.transact(() => {
      for (const [id, element] of next) {
        const previous = board.scene.get(id);
        if (equal(previous, element)) continue;
        if (!element) board.scene.remove(id);
        else if (!previous) board.scene.add(element);
        else if (previous.type !== element.type) {
          board.scene.remove(id);
          board.scene.add(element);
        } else {
          // Include absent optional fields so undo/deletion clears them locally too.
          const patch = Object.fromEntries(Object.keys(previous).map((key) => [key, undefined]));
          const previousFields = previous as unknown as Record<string, unknown>;
          for (const [key, value] of Object.entries(element)) {
            // Preserve layout/media caches and the active text DOM on geometry-only updates.
            patch[key] = equal(previousFields[key], value) ? previousFields[key] : value;
          }
          board.scene.update(id, patch);
        }
      }
    }, 'remote');
  };
  // Initial validation errors are synchronous and leave the editor/history untouched.
  apply(new Set([...board.scene.all()].map((element) => element.id).concat([...elements.keys()])));
  const history = new SharedHistory(
    board.scene,
    elements,
    origin,
    (id) => !board.isElementLocked(id),
  );
  board.history.replace(history);

  const observe = (events: Y.YEvent<Y.Map<unknown>>[], transaction: Y.Transaction): void => {
    if (transaction.origin === origin || destroyed) return;
    const ids = new Set<string>();
    for (const event of events) {
      if (event.target === elements) for (const key of event.changes.keys.keys()) ids.add(key);
      else if (typeof event.path[0] === 'string') ids.add(event.path[0]);
    }
    try {
      apply(ids);
    } catch (error) {
      report(error);
    }
  };
  elements.observeDeep(observe);
  const write = (changes: SceneChanges): void => {
    if (destroyed || changes.origin === 'remote') return;
    sharedDocument.transact(() => {
      // previous excludes connectors whose derived geometry alone was recomputed.
      for (const [id, previous] of changes.previous) {
        const next = board.scene.get(id);
        if (!next) {
          elements.delete(id);
          continue;
        }
        let record = elements.get(id);
        const replacement = !record || previous?.type !== next.type;
        if (replacement) {
          record = new Y.Map<unknown>();
          elements.set(id, record);
        }
        const { text, ...fields } = next as BoardElement & {
          text?: TextBlock;
        };
        const { text: previousText, ...previousFields } = (
          replacement ? {} : (previous ?? {})
        ) as Partial<BoardElement> & { text?: TextBlock };
        writeFields(record!, fields, previousFields);
        if (text && !equal(text, previousText)) {
          let sharedText = record!.get('text');
          if (!(sharedText instanceof Y.Map)) {
            sharedText = new Y.Map<unknown>();
            record!.set('text', sharedText);
          }
          writeText(sharedText as Y.Map<unknown>, text, previousText);
        } else if (!text && previousText) record!.delete('text');
      }
    }, origin);
    history.record(changes.previous.keys());
  };
  const unsubscribe = board.scene.subscribe(write);
  const presence = options.awareness
    ? bindPresence(
        board,
        options.awareness,
        options.name ?? 'apeiro',
        options.user,
        options.showPresence !== false,
      )
    : undefined;
  const unsubscribePresence = presence?.subscribe(() => history.refresh());
  const binding: YjsBinding = {
    document: sharedDocument,
    get peers() {
      return presence?.peers ?? [];
    },
    setUser(user) {
      presence?.setUser(user);
    },
    setShowPresence(show) {
      presence?.setVisible(show);
    },
    subscribePresence(listener) {
      return presence?.subscribe(listener) ?? (() => undefined);
    },
    destroy() {
      if (destroyed) return;
      if (!board.isDestroyed) board.text.stop();
      destroyed = true;
      unsubscribe();
      elements.unobserveDeep(observe);
      unsubscribePresence?.();
      presence?.destroy();
      offDestroy();
      sharedDocument.off('destroy', binding.destroy);
      history.dispose();
      if (!board.isDestroyed) board.history.replace();
      bindings.delete(board);
    },
  };
  const offDestroy = board.on('destroy', binding.destroy);
  sharedDocument.on('destroy', binding.destroy);
  bindings.set(board, binding);
  return binding;
}
