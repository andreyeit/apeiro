import type { Vec2 } from '@apeiro/core';
import type { BoardEditor, OverlayLayer } from '@apeiro/editor';
import { presenceCursor } from './presence-cursor';
/** Structural interface accepted by standard Yjs providers; no protocol import is required. */
export interface PresenceAwareness {
  readonly clientID: number;
  getLocalState(): Record<string, unknown> | null;
  getStates(): Map<number, Record<string, unknown>>;
  setLocalState(state: Record<string, unknown> | null): void;
  setLocalStateField(field: string, value: unknown): void;
  on(event: 'change', listener: () => void): void;
  off(event: 'change', listener: () => void): void;
}

export interface PresenceUser {
  name: string;
  /** CSS hex color, e.g. #2563eb. */
  color: string;
  id?: string;
}
export interface BoardPresence {
  clientId: number;
  user: PresenceUser;
  cursor: Vec2 | null;
  selection: readonly string[];
}

export function bindPresence(
  board: BoardEditor,
  awareness: PresenceAwareness,
  name: string,
  initialUser: PresenceUser | undefined,
  show: boolean,
) {
  const field = `apeiro:${name}`;
  let user = initialUser ?? { name: 'Anonymous', color: '#2563eb' };
  const listeners = new Set<() => void>();
  let peers: BoardPresence[] = [];
  let removeLayer: (() => void) | undefined;
  let visible = show;
  const cursor = presenceCursor();
  let clock = 0;
  let selectionClaims = new Map<string, number>();
  let updating = false;
  let pending = false;
  let online = awareness.getLocalState() !== null;
  const publish = () => {
    if (awareness.getLocalState() === null) return;
    const selection = [...board.selection.ids];
    const next = new Map<string, number>();
    for (const id of selection) next.set(id, selectionClaims.get(id) ?? ++clock);
    selectionClaims = next;
    awareness.setLocalStateField(field, {
      user,
      cursor: board.pointer,
      selection,
      selectionClaims: Object.fromEntries(selectionClaims),
    });
  };
  const update = () => {
    if (updating) {
      pending = true;
      return;
    }
    updating = true;
    try {
      do {
        pending = false;
        const active = awareness.getLocalState() !== null;
        if (!active) {
          selectionClaims.clear();
          board.selection.clear();
        }
        const restored = active && !online;
        online = active;
        if (restored) publish();
        peers = [];
        const owners = new Map<string, { clientId: number; order: number }>();
        for (const [clientId, state] of awareness.getStates()) {
          const value = state[field] as
            | (Partial<BoardPresence> & { selectionClaims?: unknown })
            | undefined;
          if (
            !value?.user ||
            typeof value.user.name !== 'string' ||
            typeof value.user.color !== 'string'
          )
            continue;
          const selection = Array.isArray(value.selection)
            ? value.selection.filter((id): id is string => typeof id === 'string')
            : [];
          const claims = value.selectionClaims;
          for (const id of selection) {
            const claim =
              claims && typeof claims === 'object' && Object.hasOwn(claims, id)
                ? (claims as Record<string, unknown>)[id]
                : undefined;
            const order =
              typeof claim === 'number' && Number.isSafeInteger(claim) && claim > 0 ? claim : 0;
            clock = Math.max(clock, order);
            const previous = owners.get(id);
            // Existing claims win; simultaneous claims converge by client id.
            if (
              !previous ||
              order < previous.order ||
              (order === previous.order && clientId < previous.clientId)
            ) {
              owners.set(id, { clientId, order });
            }
          }
          if (clientId === awareness.clientID) continue;
          peers.push({
            clientId,
            user: value.user,
            cursor:
              value.cursor && Number.isFinite(value.cursor.x) && Number.isFinite(value.cursor.y)
                ? value.cursor
                : null,
            selection,
          });
        }
        board.setLockedElements(
          [...owners]
            .filter(([, owner]) => owner.clientId !== awareness.clientID)
            .map(([id]) => id),
        );
      } while (pending);
    } finally {
      updating = false;
    }
    board.overlay?.request();
    for (const listener of listeners) listener();
  };
  const draw: OverlayLayer = (context, zoom) => {
    context.save();
    for (const peer of peers) {
      const color = /^#[0-9a-f]{6}$/i.test(peer.user.color) ? peer.user.color : '#2563eb';
      board.overlay?.drawTintedSelection(new Set(peer.selection), color);
      if (!peer.cursor) continue;
      const { x, y } = peer.cursor;
      context.save();
      context.translate(x, y);
      context.scale(1 / zoom, 1 / zoom);
      cursor.draw(context, peer.user.name.slice(0, 80), color);
      context.restore();
    }
    context.restore();
  };
  const mount = () => {
    removeLayer?.();
    removeLayer = visible ? board.overlay?.addLayer(draw) : undefined;
    publish();
  };
  const disposers = [
    board.on('pointer', publish),
    board.on('selection', publish),
    board.on('mount', mount),
  ];
  awareness.on('change', update);
  update();
  mount();
  return {
    get peers(): readonly BoardPresence[] {
      return peers;
    },
    setUser(next: PresenceUser) {
      user = next;
      publish();
    },
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      removeLayer?.();
      removeLayer = visible ? board.overlay?.addLayer(draw) : undefined;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      for (const dispose of disposers) dispose();
      awareness.off('change', update);
      // Remove only our own field, preserving the application's other presence data.
      const state = awareness.getLocalState();
      if (state) {
        const next = { ...state };
        delete next[field];
        awareness.setLocalState(next);
      }
      removeLayer?.();
      if (!board.isDestroyed) board.setLockedElements([]);
      listeners.clear();
    },
  };
}
