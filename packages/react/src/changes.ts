import type { BoardElement, Scene, SceneChanges } from '@apeiro/core';
import type { BoardEditor } from '@apeiro/editor';
import { useEffect, useRef } from 'react';

/**
 * What changed on the board since the previous `onChange`: whole elements as they are now
 * (not patches) and ids of deleted ones. Enough to save incrementally or to send over your
 * own network protocol.
 */
export interface BoardChanges {
  /** Elements that are new. */
  added: BoardElement[];
  /** Elements that changed (re-routed connectors included), as they are now. */
  updated: BoardElement[];
  /** Ids of deleted elements. */
  removed: string[];
  /**
   * Where the changes come from: `undefined` for this user's edits, `'history'` for undo
   * and redo, `'load'` for `editor.load()`, or the tag you passed to
   * `scene.transact(fn, tag)`.
   */
  origin: string | undefined;
}

type Kind = 'added' | 'updated' | 'removed';

/**
 * Collects scene batches between two `onChange` calls, merged per element (added then
 * changed is added, added then deleted is nothing…) and split by origin, so local edits
 * and remote ones are reported apart.
 */
export class ChangeLog {
  private groups: Array<{ origin: string | undefined; kinds: Map<string, Kind> }> = [];

  get isEmpty(): boolean {
    return this.groups.length === 0;
  }

  add(changes: SceneChanges): void {
    let group = this.groups.at(-1);
    if (!group || group.origin !== changes.origin) {
      group = { origin: changes.origin, kinds: new Map() };
      this.groups.push(group);
    }
    const kinds = group.kinds;
    for (const element of changes.added)
      kinds.set(element.id, kinds.get(element.id) === 'removed' ? 'updated' : 'added');
    for (const element of changes.updated)
      if (kinds.get(element.id) !== 'added') kinds.set(element.id, 'updated');
    for (const id of changes.removed) {
      if (kinds.get(id) === 'added') kinds.delete(id);
      else kinds.set(id, 'removed');
    }
    if (kinds.size === 0) this.groups.pop();
  }

  /** The collected changes, one entry per origin in order, with elements as they are now. */
  take(scene: Scene): BoardChanges[] {
    const out = this.groups.map(({ origin, kinds }) => {
      const changes: BoardChanges = { added: [], updated: [], removed: [], origin };
      for (const [id, kind] of kinds) {
        if (kind === 'removed') {
          changes.removed.push(id);
          continue;
        }
        // Gone by now: a later group reports the deletion.
        const element = scene.get(id);
        if (element) changes[kind].push(element);
      }
      return changes;
    });
    this.groups = [];
    return out;
  }
}

/** A listener of the board's content (see `useBoardChange`). */
export type BoardChangeListener = (elements: BoardElement[], changes: BoardChanges) => void;

/**
 * Calls `onChange` after the scene of `editor` changed: once per batch, a gesture once it
 * ends, one call per origin. The latest `onChange` is called (no need to memoize it).
 */
export function useChangeListener(
  editor: BoardEditor,
  onChange: BoardChangeListener | undefined,
): void {
  const reference = useRef(onChange);
  reference.current = onChange;
  const listening = onChange !== undefined;
  useEffect(() => {
    if (!listening) return;
    let active = true;
    let queued = false;
    const log = new ChangeLog();
    const flush = () => {
      queued = false;
      // A drag or stroke reports once, when the pointer is released ('gesture').
      if (!active || log.isEmpty || editor.isInteracting || editor.isDestroyed) return;
      const groups = log.take(editor.scene);
      // One copy of the elements per flush (not per origin group).
      const elements = editor.getElements();
      for (const changes of groups) reference.current?.(elements, changes);
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(flush);
    };
    const offScene = editor.scene.subscribe((changes) => {
      log.add(changes);
      schedule();
    });
    const offGesture = editor.on('gesture', schedule);
    return () => {
      active = false;
      offScene();
      offGesture();
    };
  }, [editor, listening]);
}
