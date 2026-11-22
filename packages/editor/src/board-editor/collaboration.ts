import type { BoardEditor } from './board-editor';

/** A connected collaboration adapter; the application owns its document and transport. */
export interface BoardCollaborationConnection {
  /** Initial synchronization and setup, before React element components are mounted. */
  readonly ready?: PromiseLike<unknown>;
  destroy(): void;
}

/** Optional collaboration protocol, independent of React and any particular transport. */
export interface BoardCollaboration {
  /** Connection identity. Equivalent adapters may be created inline on every render. */
  readonly key: readonly unknown[];
  connect(board: BoardEditor, onError: (error: unknown) => void): BoardCollaborationConnection;
  /** Apply live settings without reconnecting or resetting undo history. */
  update?(connection: BoardCollaborationConnection): void;
}
