import {
  newId,
  isConnector,
  isShape,
  patchedElement,
  Scene,
  validateElement,
  type BoardElement,
  type ConnectorEnd,
  type ElementPatch,
  type SceneChanges,
  type ShapeElement,
} from '@apeiro/core';

/**
 * Proposed changes to the board, e.g. what an AI assistant suggests: shown as a preview
 * that only this user sees until it is applied (`BoardEditor.showPreview`).
 */
export interface BoardDraft {
  /**
   * New elements. Their ids are their own: ones that clash with the board's get new ids
   * (connector ends and groups among them follow). Connectors may attach to the board's
   * existing shapes by id. Drawn above the board in the order of their `z`.
   */
  add?: readonly BoardElement[];
  /** Changes of existing elements (e.g. stickers rearranged into groups), by id. */
  update?: ReadonlyArray<{ id: string } & ElementPatch>;
  /** Ids of existing elements that would be deleted (outlined in red meanwhile). */
  remove?: readonly string[];
}

/** A draft checked against the board: what applying it does. */
export interface NormalizedDraft {
  /** New elements with the ids they will have and z above the board. */
  add: BoardElement[];
  /** Updates of elements that exist. */
  update: Array<{ id: string } & ElementPatch>;
  /** Existing elements to delete. */
  remove: string[];
}

/**
 * The draft against the board's current content: clashing ids renamed, z placed above
 * everything, updates and removals of missing elements dropped. Throws if an element
 * (new, or existing after its update) is invalid, naming it.
 */
export function normalizeDraft(scene: Scene, draft: BoardDraft): NormalizedDraft {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const element of draft.add ?? []) {
    const id =
      scene.has(element.id) || taken.has(element.id)
        ? newId(isConnector(element) ? 'c' : 's')
        : element.id;
    taken.add(id);
    if (!ids.has(element.id)) ids.set(element.id, id);
  }
  const groups = new Map<string, string>();
  const group = (groupId: string | undefined) => {
    if (groupId === undefined) return undefined;
    let id = groups.get(groupId);
    if (!id) groups.set(groupId, (id = newId('g')));
    return id;
  };
  const end = (connectorEnd: ConnectorEnd): ConnectorEnd =>
    connectorEnd.kind === 'element' && ids.has(connectorEnd.id)
      ? { ...connectorEnd, id: ids.get(connectorEnd.id)! }
      : connectorEnd;
  // New elements go above the board, keeping their order among themselves.
  const base = scene.size > 0 ? scene.maxZ() + 1 : 0;
  const add = [...(draft.add ?? [])]
    .sort((first, second) => first.z - second.z)
    .map((element, index): BoardElement => {
      const next: BoardElement = { ...element, id: ids.get(element.id)!, z: base + index };
      if (element.groupId !== undefined) next.groupId = group(element.groupId);
      if (isConnector(next)) {
        next.start = end(next.start);
        next.end = end(next.end);
      }
      return next;
    });
  for (const element of add) {
    const problem = validateElement(element);
    if (problem) throw new Error(`apeiro: draft element ${element.id}: ${problem}`);
  }
  const update = (draft.update ?? []).filter((update) => {
    const element = scene.get(update.id);
    if (!element) return false;
    const problem = validateElement(patchedElement(element, update));
    if (problem) throw new Error(`apeiro: draft update of ${update.id}: ${problem}`);
    return true;
  });
  const remove = [...new Set(draft.remove ?? [])].filter((id) => scene.has(id));
  return { add, update, remove };
}

/** A copy of a board shape that draws nothing but keeps its outline, for connectors to attach. */
function invisible(element: ShapeElement): ShapeElement {
  const copy: ShapeElement = {
    id: element.id,
    type: element.type === 'ellipse' || element.type === 'polygon' ? element.type : 'rect',
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    rotation: element.rotation,
    z: element.z,
    fill: 0,
    stroke: 0,
    strokeWidth: 0,
    radius: element.radius,
  };
  if (element.sides !== undefined) copy.sides = element.sides;
  return copy;
}

/**
 * What the preview draws, as a scene of its own: the new elements, updated elements as they
 * would become, and invisible copies of the board's shapes that draft connectors attach to
 * (kept in step with the board, so those lines follow when someone moves the shapes).
 */
export class DraftScene {
  readonly scene = new Scene();
  /** Board shapes copied invisibly, for the draft's connectors. */
  private readonly anchors = new Set<string>();
  private readonly updated = new Map<string, ElementPatch>();

  constructor(
    private readonly board: Scene,
    readonly draft: NormalizedDraft,
  ) {
    const own = new Set(draft.add.map((element) => element.id));
    for (const update of draft.update) this.updated.set(update.id, update);
    for (const element of [...draft.add, ...draft.update.map((update) => board.get(update.id)!)]) {
      if (!isConnector(element)) continue;
      for (const connectorEnd of [element.start, element.end])
        if (
          connectorEnd.kind === 'element' &&
          !own.has(connectorEnd.id) &&
          !this.updated.has(connectorEnd.id)
        )
          this.anchors.add(connectorEnd.id);
    }
    this.scene.transact(() => {
      for (const id of this.anchors) {
        const element = board.get(id);
        if (element && isShape(element)) this.scene.add(invisible(element));
      }
      for (const [id, patch] of this.updated) this.scene.add(this.merged(id, patch)!);
      for (const element of draft.add) this.scene.add(element);
    }, 'load');
  }

  private merged(id: string, patch: ElementPatch): BoardElement | null {
    const element = this.board.get(id);
    return element ? patchedElement(element, patch) : null;
  }

  /** Follows changes of the board: shapes the draft attaches to or updates moved or went away. */
  boardChanged(changes: SceneChanges): void {
    const touched = new Set<string>();
    for (const element of changes.updated) touched.add(element.id);
    for (const element of changes.added) touched.add(element.id);
    for (const id of changes.removed) touched.add(id);
    this.scene.transact(() => {
      for (const id of touched) {
        const anchored = this.anchors.has(id);
        const patch = this.updated.get(id);
        if (!anchored && !patch) continue;
        const element = this.board.get(id);
        const next = !element
          ? null
          : patch
            ? this.merged(id, patch)
            : isShape(element)
              ? invisible(element)
              : null;
        // Replaced whole (one batch: an update for the renderer), so dropped fields go too.
        if (this.scene.has(id)) this.scene.remove(id);
        if (next) this.scene.add(next);
      }
    }, 'load');
  }
}
