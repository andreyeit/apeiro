import { validateElement, type BoardElement } from '@apeiro/core';
import type { BoardCollaboration, BoardCollaborationConnection, BoardEditor } from '@apeiro/editor';
import { bindYjs, type YjsBinding, type YjsOptions } from './binding';

export interface YjsCollaborationOptions extends YjsOptions {
  /** Your provider's initial-sync promise. Descendants wait until it resolves. */
  whenSynced?: PromiseLike<unknown>;
  /** Seed a new document after sync. Use the same stable element ids on every client. */
  initialElements?: readonly BoardElement[];
}

interface Session {
  options: YjsCollaborationOptions;
  binding: YjsBinding;
}
const sessions = new WeakMap<BoardCollaborationConnection, Session>();
const INITIALIZE_ORIGIN = 'apeiro:initialize';

function initialize(board: BoardEditor, options: YjsCollaborationOptions): void {
  if (!options.initialElements) return;
  const name = options.name ?? 'apeiro';
  const initialized = options.document.getMap<boolean>('apeiro:initialized');
  if (initialized.get(name)) return;
  const elements = options.document.getMap(`${name}:elements`);
  const ids = new Set<string>();
  if (elements.size === 0) {
    for (const element of options.initialElements) {
      const problem = validateElement(element);
      if (problem) throw new Error(`Invalid initial element ${element?.id}: ${problem}`);
      if (ids.has(element.id)) throw new Error(`Duplicate initial element ${element.id}`);
      ids.add(element.id);
    }
  }
  options.document.transact(() => {
    if (elements.size === 0)
      board.scene.transact(() => {
        for (const element of options.initialElements!) board.scene.add(element);
      }, INITIALIZE_ORIGIN);
    initialized.set(name, true);
  }, INITIALIZE_ORIGIN);
}

/**
 * Optional adapter for <BoardProvider collaboration={yjs({...})}>. No connections are
 * opened until the provider commits. The document and provider remain application-owned.
 */
export function yjs(options: YjsCollaborationOptions): BoardCollaboration {
  return {
    key: [yjs, options.document, options.awareness, options.name ?? 'apeiro', options.whenSynced],
    connect(board, onError) {
      const state: { options: YjsCollaborationOptions } = { options };
      const binding = bindYjs(board, {
        ...options,
        onError: (error) => (state.options.onError ?? onError)(error),
      });
      let active = true;
      const connection: BoardCollaborationConnection = {
        ready: Promise.resolve(options.whenSynced).then(() => {
          if (!active) return;
          if (board.isDestroyed || options.document.isDestroyed) {
            throw new Error(
              'Cannot initialize collaboration after the board or document was destroyed',
            );
          }
          initialize(board, options);
        }),
        destroy() {
          active = false;
          binding.destroy();
          sessions.delete(connection);
        },
      };
      // Keep one mutable options reference for the error callback and live settings.
      const session: Session = {
        get options() {
          return state.options;
        },
        set options(next) {
          state.options = next;
        },
        binding,
      };
      sessions.set(connection, session);
      return connection;
    },
    update(connection) {
      const session = sessions.get(connection);
      if (!session) return;
      const previous = session.options;
      session.options = options;
      if (
        previous.user?.name !== options.user?.name ||
        previous.user?.color !== options.user?.color ||
        previous.user?.id !== options.user?.id
      ) {
        session.binding.setUser(options.user ?? { name: 'Anonymous', color: '#2563eb' });
      }
      if (previous.showPresence !== options.showPresence) {
        session.binding.setShowPresence(options.showPresence !== false);
      }
    },
  };
}
