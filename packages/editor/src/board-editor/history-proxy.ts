import type { UndoHistory } from '@apeiro/core';

/**
 * Forwards to whatever history the editor currently has (see `BoardEditor.setHistory`).
 * The controls and the text editor keep this one object, so a new history takes effect
 * without remounting.
 */
export class HistoryProxy implements UndoHistory {
  constructor(private readonly current: () => UndoHistory) {}
  get canUndo(): boolean {
    return this.current().canUndo;
  }
  get canRedo(): boolean {
    return this.current().canRedo;
  }
  undo(): string[] {
    return this.current().undo();
  }
  redo(): string[] {
    return this.current().redo();
  }
  beginGroup(): void {
    this.current().beginGroup();
  }
  endGroup(): void {
    this.current().endGroup();
  }
  batch<T>(run: () => T): T {
    return this.current().batch(run);
  }
  clear(): void {
    this.current().clear();
  }
  subscribe(listener: () => void): () => void {
    return this.current().subscribe(listener);
  }
  /** The proxy owns nothing: disposing the real history is the editor's job. */
  dispose(): void {}
}
