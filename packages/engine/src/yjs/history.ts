import type { Scene, UndoHistory } from '@apeiro/core';
import * as Y from 'yjs';

/** Bridges gesture boundaries and the editor's existing history controls to Yjs. */
export class SharedHistory implements UndoHistory {
  readonly collaborative = true;
  private depth = 0;
  private listeners = new Set<() => void>();
  readonly manager: Y.UndoManager;

  constructor(
    private scene: Scene,
    elements: Y.Map<Y.Map<unknown>>,
    origin: object,
    private canEdit: (id: string) => boolean = () => true,
  ) {
    this.manager = new Y.UndoManager(elements, {
      trackedOrigins: new Set([origin]),
      captureTimeout: 0,
    });
    this.manager.on('stack-item-added', this.emit);
    this.manager.on('stack-item-updated', this.emit);
    this.manager.on('stack-item-popped', this.emit);
    this.manager.on('stack-cleared', this.emit);
  }
  get canUndo(): boolean {
    return this.available(this.manager.undoStack.at(-1));
  }
  get canRedo(): boolean {
    return this.available(this.manager.redoStack.at(-1));
  }
  undo(): string[] {
    if (!this.canUndo) return [];
    const ids = this.manager.undoStack.at(-1)?.meta.get('apeiro:elements');
    const result = this.travel(() => this.manager.undo());
    this.manager.redoStack.at(-1)?.meta.set('apeiro:elements', ids);
    this.refresh();
    return result;
  }
  redo(): string[] {
    if (!this.canRedo) return [];
    const ids = this.manager.redoStack.at(-1)?.meta.get('apeiro:elements');
    const result = this.travel(() => this.manager.redo());
    this.manager.undoStack.at(-1)?.meta.set('apeiro:elements', ids);
    this.refresh();
    return result;
  }
  private available(item: { meta: Map<unknown, unknown> } | undefined): boolean {
    if (!item) return false;
    const ids = item.meta.get('apeiro:elements') as Set<string> | undefined;
    return !ids || [...ids].every(this.canEdit);
  }
  /** IDs in a local scene batch, merged while a gesture is grouped. */
  record(ids: Iterable<string>): void {
    const item = this.manager.undoStack.at(-1);
    if (!item) return;
    const touched =
      (item.meta.get('apeiro:elements') as Set<string> | undefined) ?? new Set<string>();
    for (const id of ids) touched.add(id);
    item.meta.set('apeiro:elements', touched);
    this.refresh();
  }
  refresh(): void {
    this.emit();
  }
  private travel(action: () => unknown): string[] {
    const ids = new Set<string>();
    const unsubscribe = this.scene.subscribe((changes) => {
      for (const id of changes.previous.keys()) ids.add(id);
    });
    try {
      action();
    } finally {
      unsubscribe();
    }
    return [...ids].filter((id) => this.scene.has(id));
  }
  beginGroup(): void {
    if (this.depth++ === 0) {
      this.manager.stopCapturing();
      this.manager.captureTimeout = Infinity;
    }
  }
  endGroup(): void {
    if (this.depth === 0 || --this.depth > 0) return;
    this.manager.stopCapturing();
    this.manager.captureTimeout = 0;
  }
  batch<T>(action: () => T): T {
    this.beginGroup();
    try {
      return this.scene.transact(action);
    } finally {
      this.endGroup();
    }
  }
  clear(): void {
    this.manager.clear();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit = (): void => {
    for (const listener of this.listeners) listener();
  };
  dispose(): void {
    this.manager.destroy();
    this.listeners.clear();
  }
}
