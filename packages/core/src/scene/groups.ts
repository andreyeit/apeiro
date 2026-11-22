import type { BoardElement } from '../elements/element';
import type { Scene } from './scene';

/**
 * Groups are flat: an element has at most one `groupId`, and every element sharing it is
 * in the group. Grouping elements that are already in groups merges them into one new
 * group. A "group" left with a single element (the others were deleted) acts as none.
 */

/** Live members of the element's group, or null if it isn't in a group of two or more. */
export function groupOf(scene: Scene, element: BoardElement | undefined): string[] | null {
  if (!element?.groupId) return null;
  const members = scene.groupMembers(element.groupId);
  return members.length >= 2 ? members : null;
}

/** The ids plus every other member of the groups they touch. */
export function expandToGroups(scene: Scene, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const id of ids) {
    out.add(id);
    const groupId = scene.get(id)?.groupId;
    if (!groupId || seen.has(groupId)) continue;
    seen.add(groupId);
    for (const member of scene.groupMembers(groupId)) out.add(member);
  }
  return out;
}

/** True if the ids are exactly the members of one group. */
export function isWholeGroup(scene: Scene, ids: ReadonlySet<string>): boolean {
  if (ids.size < 2) return false;
  const first = scene.get(ids.values().next().value!);
  const members = groupOf(scene, first);
  return !!members && members.length === ids.size && members.every((id) => ids.has(id));
}

/** Can these ids be grouped: two or more elements that aren't already exactly one group. */
export function canGroup(scene: Scene, ids: ReadonlySet<string>): boolean {
  let count = 0;
  for (const id of ids) if (scene.has(id)) count++;
  return count >= 2 && !isWholeGroup(scene, ids);
}

/** Can these ids be ungrouped: at least one of them is in a group. */
export function canUngroup(scene: Scene, ids: Iterable<string>): boolean {
  for (const id of ids) if (groupOf(scene, scene.get(id))) return true;
  return false;
}

/**
 * Puts the elements (and the rest of any group they are in) into a new group `groupId`.
 * One scene batch. Returns the ids of the group, or null if there is nothing to group.
 */
export function groupElements(
  scene: Scene,
  ids: Iterable<string>,
  groupId: string,
): string[] | null {
  const members = [...expandToGroups(scene, ids)].filter((id) => scene.has(id));
  if (members.length < 2) return null;
  scene.transact(() => {
    for (const id of members) scene.update(id, { groupId });
  });
  return members;
}

/**
 * Dissolves every group the elements are in (all of its members leave it, not only the
 * listed ones). One scene batch. Returns the ids that were in those groups.
 */
export function ungroupElements(scene: Scene, ids: Iterable<string>): string[] {
  const members = [...expandToGroups(scene, ids)].filter((id) => scene.get(id)?.groupId);
  scene.transact(() => {
    for (const id of members) scene.update(id, { groupId: undefined });
  });
  return members;
}
