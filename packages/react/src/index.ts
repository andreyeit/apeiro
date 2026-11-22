// Components: a provider that owns the board, and the canvas that shows it.
export {
  Board,
  BoardProvider,
  type BoardOptions,
  type BoardProps,
  type BoardProviderProps,
  type BoardTheme,
  type BoardViewProps,
} from './board';
export {
  Element,
  Shape,
  Rect,
  Ellipse,
  Polygon,
  Sticky,
  Text,
  type ElementProps,
  type ElementData,
  type ShapeProps,
  type ElementColor,
  type DeclarativeShapeKind,
} from './elements';
// The board: its editor, with every command (`board.selection.delete()`…).
export { useBoard } from './editor-context';
// State.
export * from './hooks';
export type { BoardChangeListener, BoardChanges } from './changes';
export type { BoardCollaboration, BoardCollaborationConnection } from '@apeiro/editor';
