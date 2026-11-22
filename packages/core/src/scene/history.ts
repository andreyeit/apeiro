import type { BoardElement } from '../elements/element';
import { HISTORY_ORIGIN, type Scene, type SceneChanges } from './scene';

/** One undo step: each element touched, as it was before and after (undefined: absent). */
interface Entry {
  before: Map<string, BoardElement | undefined>;
  after: Map<string, BoardElement | undefined>;
}

/**
 * What the board editor needs from an undo history. `History` (below) implements it.
 */
export interface UndoHistory {
  /** Shared histories handle text undo as operations, rather than local snapshots. */
  readonly collaborative?: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Reverts the last step; returns the ids it touched that still exist. */
  undo(): string[];
  /** Re-applies the last undone step; returns the ids it touched that exist afterwards. */
  redo(): string[];
  /** Merges everything until the matching `endGroup` into one step. Nestable. */
  beginGroup(): void;
  endGroup(): void;
  /** Runs `action` as one step. */
  batch<T>(action: () => T): T;
  /** Forgets all steps. */
  clear(): void;
  /** Called whenever canUndo/canRedo may have changed. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface HistoryOptions {
  /** Steps kept; the oldest are dropped. */
  limit?: number;
  /**
   * Which batches are user edits worth undoing. By default only untagged ones
   * (`scene.transact(action)` without an origin): remote changes, loading a board,
   * animations etc. pass an origin and stay out of the history.
   */
  record?: (origin: string | undefined) => boolean;
}

/**
 * Undo/redo for a Scene. Records the inverse of every local batch from the scene's change
 * events, so nothing else needs to know about it: any code that edits the scene is undoable.
 *
 * A gesture (dragging, drawing a connector, editing text) produces many batches; wrap it
 * in `beginGroup()`/`endGroup()` to make it one step. A group whose net effect is nothing
 * (e.g. a drag cancelled with Esc) leaves no step.
 *
 * Undo restores whole elements, so it also brings back deleted elements with their
 * connectors and z order. Elements changed since by someone else are overwritten with
 * the recorded state (last writer wins, like a local edit).
 */
export class History implements UndoHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private group: Entry | null = null;
  private groupDepth = 0;
  private listeners = new Set<() => void>();
  private readonly limit: number;
  private readonly shouldRecord: (origin: string | undefined) => boolean;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly scene: Scene,
    options: HistoryOptions = {},
  ) {
    this.limit = options.limit ?? 200;
    this.shouldRecord = options.record ?? ((origin) => origin === undefined);
    this.unsubscribe = scene.subscribe((changes) => this.onChanges(changes));
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Called whenever canUndo/canRedo may have changed (e.g. to update buttons). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts merging batches into one step. Nestable: the step ends with the outermost `endGroup`. */
  beginGroup(): void {
    if (this.groupDepth++ === 0) this.group = { before: new Map(), after: new Map() };
  }

  endGroup(): void {
    if (this.groupDepth === 0) return;
    if (--this.groupDepth > 0) return;
    const entry = this.group;
    this.group = null;
    if (entry) this.push(entry);
  }

  /** Runs `action` as one undo step. */
  batch<T>(action: () => T): T {
    this.beginGroup();
    try {
      return this.scene.transact(action);
    } finally {
      this.endGroup();
    }
  }

  /** Reverts the last step. Returns the ids it touched that still exist (e.g. to select them). */
  undo(): string[] {
    return this.travel(this.undoStack, this.redoStack, 'before');
  }

  /** Re-applies the last undone step. Returns the ids it touched that exist afterwards. */
  redo(): string[] {
    return this.travel(this.redoStack, this.undoStack, 'after');
  }

  /** Forgets everything, e.g. after loading another board. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    if (this.group) this.group = { before: new Map(), after: new Map() };
    this.emit();
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private onChanges(changes: SceneChanges): void {
    if (changes.origin === HISTORY_ORIGIN || !this.shouldRecord(changes.origin)) return;
    if (changes.previous.size === 0) return;
    const entry = this.group ?? { before: new Map(), after: new Map() };
    for (const [id, was] of changes.previous) {
      // In a group the first "before" wins; "after" is always the latest state.
      if (!entry.before.has(id)) entry.before.set(id, was);
      entry.after.set(id, this.scene.get(id));
    }
    if (!this.group) this.push(entry);
  }

  private push(entry: Entry): void {
    for (const [id, before] of entry.before) {
      if (sameElement(before, entry.after.get(id))) {
        entry.before.delete(id);
        entry.after.delete(id);
      }
    }
    if (entry.before.size === 0) return; // e.g. a drag that ended where it started
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }

  private travel(from: Entry[], to: Entry[], side: 'before' | 'after'): string[] {
    const entry = from.pop();
    if (!entry) return [];
    const target = entry[side];
    const scene = this.scene;
    scene.transact(() => {
      // Remove first, then (re)create: an element may come back with a different z or type.
      for (const [id, element] of target) {
        if (scene.has(id) && element !== scene.get(id)) scene.remove(id);
      }
      for (const element of target.values())
        if (element && !scene.has(element.id)) scene.add(element);
    }, HISTORY_ORIGIN);
    to.push(entry);
    this.emit();
    return [...target.keys()].filter((id) => scene.has(id));
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Structural equality of two element snapshots (plain JSON-like data). */
function sameElement(first: BoardElement | undefined, second: BoardElement | undefined): boolean {
  if (first === second) return true;
  if (!first || !second) return false;
  return deepEqual(first, second);
}

function deepEqual(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (typeof first !== 'object' || typeof second !== 'object' || first === null || second === null)
    return false;
  if (Array.isArray(first) !== Array.isArray(second)) return false;
  const firstKeys = Object.keys(first).filter(
    (key) => (first as Record<string, unknown>)[key] !== undefined,
  );
  const secondKeys = Object.keys(second).filter(
    (key) => (second as Record<string, unknown>)[key] !== undefined,
  );
  if (firstKeys.length !== secondKeys.length) return false;
  for (const key of firstKeys) {
    if (
      !deepEqual((first as Record<string, unknown>)[key], (second as Record<string, unknown>)[key])
    )
      return false;
  }
  return true;
}
