import { createElement } from 'react';
import {
  Board as ReactBoard,
  BoardProvider as ReactBoardProvider,
  type BoardProps as ReactBoardProps,
  type BoardProviderProps as ReactBoardProviderProps,
} from '@apeiro/react';
import type { BoardCollaboration } from '@apeiro/editor';
import { collaborationAdapter, type CollaborationOptions } from './collaboration';

export interface BoardProps extends Omit<ReactBoardProps, 'collaboration'> {
  /** Plain Socket.IO or Yjs options. Network dependencies load only when connecting. */
  collaboration?: CollaborationOptions | BoardCollaboration;
}
export interface BoardProviderProps extends Omit<ReactBoardProviderProps, 'collaboration'> {
  collaboration?: CollaborationOptions | BoardCollaboration;
}

export function Board({ collaboration, ...props }: BoardProps) {
  return createElement(ReactBoard, {
    ...props,
    collaboration: collaborationAdapter(collaboration),
  });
}

export function BoardProvider({ collaboration, ...props }: BoardProviderProps) {
  return createElement(ReactBoardProvider, {
    ...props,
    collaboration: collaborationAdapter(collaboration),
  });
}
