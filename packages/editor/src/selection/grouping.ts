import {
  newId,
  canGroup,
  canUngroup,
  groupElements,
  groupOf,
  ungroupElements,
  type Scene,
} from '@apeiro/core';

/**
 * Selection after a press on element `hit`, Miro/Figma style:
 * - a press on a grouped element selects the whole group;
 * - when exactly that group is selected, a click (no drag) on one of its elements selects
 *   just that element;
 * - once inside a group, presses on its other elements select them one by one;
 * - Shift adds the whole group (or the lone element), or removes it if already selected;
 * - `deep` (Ctrl/⌘ held, as in Figma) ignores groups: the element itself is selected,
 *   or with Shift added/removed, straight through its group.
 *
 * `onClick`: the selection to switch to if the press ends without a drag (going inside
 * a group, Shift-removing). Deferred so that a drag still moves what was selected, e.g.
 * Shift+drag of a selected element moves it along one axis instead of deselecting it.
 */
export function selectionAfterPress(
  scene: Scene,
  selection: ReadonlySet<string>,
  hit: string,
  shift: boolean,
  deep = false,
): { selection: Set<string>; onClick: Set<string> | null } {
  const group = groupOf(scene, scene.get(hit));
  if (deep && !shift) {
    // Keep a selection of loose elements (so it can be dragged), but pick the element
    // out of its group even when the whole group is selected.
    const groupSelected = !!group && group.every((id) => selection.has(id));
    const keep = selection.has(hit) && !groupSelected;
    return { selection: keep ? new Set(selection) : new Set([hit]), onClick: null };
  }
  const members = deep ? null : group;
  const target = members ?? [hit];
  if (shift) {
    const next = new Set(selection);
    if (target.every((id) => next.has(id))) {
      for (const id of target) next.delete(id);
      return { selection: new Set(selection), onClick: next };
    }
    for (const id of target) next.add(id);
    return { selection: next, onClick: null };
  }
  if (!members) {
    return { selection: selection.has(hit) ? new Set(selection) : new Set([hit]), onClick: null };
  }
  const inside = selection.size > 0 && [...selection].every((id) => members.includes(id));
  const whole = members.every((id) => selection.has(id));
  if (inside && !whole) {
    // Already inside the group: pick its elements one by one.
    return { selection: selection.has(hit) ? new Set(selection) : new Set([hit]), onClick: null };
  }
  if (whole) return { selection: new Set(selection), onClick: inside ? new Set([hit]) : null };
  return { selection: new Set(members), onClick: null };
}

/** The group the selection is inside of (part of one group, not all of it), or null. */
export function enteredGroup(scene: Scene, selection: ReadonlySet<string>): string[] | null {
  if (selection.size === 0) return null;
  const members = groupOf(scene, scene.get(selection.values().next().value!));
  if (!members || members.length === selection.size) return null;
  return [...selection].every((id) => members.includes(id)) ? members : null;
}

/** Ctrl+G: groups the selection. Returns the new selection, or null if nothing changed. */
export function groupSelection(scene: Scene, selection: ReadonlySet<string>): Set<string> | null {
  if (!canGroup(scene, selection)) return null;
  const ids = groupElements(scene, selection, newId('g'));
  return ids ? new Set(ids) : null;
}

/** Ctrl+Shift+G: dissolves the selected groups. Returns the new selection, or null. */
export function ungroupSelection(scene: Scene, selection: ReadonlySet<string>): Set<string> | null {
  if (!canUngroup(scene, selection)) return null;
  return new Set(ungroupElements(scene, selection));
}
