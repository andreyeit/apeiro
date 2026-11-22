import {
  attachedIds,
  connectorCrossesBox,
  hitTestConnector,
  resolveConnector,
  type ConnectorElement,
  type ConnectorGeometry,
} from '../connectors';
import {
  elementBounds,
  isShape,
  patchedElement,
  type BoardElement,
  type ElementPatch,
  type ShapeElement,
} from '../elements/element';
import { hitTestElement } from '../elements/hit-test';
import { validateElement } from '../elements/validation';
import { boxAroundPoint, boxContainsBox, boxIntersects, boxUnion, type Box } from '../geometry/box';
import type { Vec2 } from '../geometry/vector';
import { SpatialIndex, type SpatialIndexOptions } from '../geometry/spatial-index';

/** Origin of the batches `History` applies itself; never recorded. */
export const HISTORY_ORIGIN = 'history';

/**
 * One batch of changes, emitted once per outermost `transact`.
 * Elements are immutable snapshots: an update replaces the object,
 * so consumers can compare by reference.
 *
 * A connector appears in `updated` also when only its geometry changed because
 * an attached shape moved; in that case the element object is the same.
 */
export interface SceneChanges {
  added: BoardElement[];
  updated: BoardElement[];
  removed: string[];
  /**
   * True if an existing element's z changed, i.e. paint order must be rebuilt.
   * Added elements don't set this flag: consumers place them by z themselves
   * (usually they go on top, which needs no re-sort). An element removed and re-added
   * in one batch is reported as updated; it sets the flag if its z or type changed.
   */
  orderChanged: boolean;
  /**
   * Every element added, updated or removed by this batch as it was before the batch
   * (undefined: it didn't exist). Connectors that were only re-routed are not listed.
   * Lets consumers such as undo history compute the inverse of the batch.
   */
  previous: ReadonlyMap<string, BoardElement | undefined>;
  /** Tag passed to the outermost `transact` (e.g. 'remote', 'history'); undefined for local edits. */
  origin: string | undefined;
}

type ChangeListener = (changes: SceneChanges) => void;
type Pending = 'added' | 'updated';

export type BoxQueryMode = 'intersect' | 'contain';

export interface SceneOptions {
  index?: SpatialIndexOptions;
  /**
   * Deep-freeze stored elements, so code that mutates an element (or its text, media or
   * connector ends) after handing it to the scene fails loudly instead of changing the
   * scene behind its back. Meant for development and tests.
   */
  freeze?: boolean;
}

/**
 * In-memory source of truth for what is drawn. Knows nothing about rendering
 * or networking: the renderer and the editor subscribe to it.
 *
 * Connector geometry is derived here: when a shape changes, connectors attached to it
 * (and elbow routes it may now block or unblock) are recomputed in the same batch.
 * Recomputation is deferred to the end of the batch, so a connector between two moved
 * shapes is routed once; reads in the middle of a batch settle pending routes first.
 */
export class Scene {
  private elements = new Map<string, BoardElement>();
  private index: SpatialIndex<string>;
  private listeners = new Set<ChangeListener>();
  /** Shape id → connectors attached to it (the shape may not exist yet). */
  private attachments = new Map<string, Set<string>>();
  private geometry = new Map<string, ConnectorGeometry | null>();
  /** Group id → ids of its elements. */
  private groups = new Map<string, Set<string>>();
  /** Elbow connectors: their routes depend on nearby shapes, not only on their ends. */
  private elbows = new Set<string>();
  /** Connectors whose geometry must be recomputed before the next read or flush. */
  private dirtyRoutes = new Set<string>();
  /** Areas where shapes appeared/moved/vanished: elbow routes there may need a re-route. */
  private dirtyAreas: Box[] = [];
  private readonly getShape = (id: string): ShapeElement | undefined => {
    const element = this.elements.get(id);
    return element && isShape(element) ? element : undefined;
  };

  /**
   * Paint order cache for `sortedByZ`, with each id's index in it: edits that keep the order
   * (moves, recolors, typing) patch it in place instead of sorting the board again.
   */
  private zOrder: { elements: BoardElement[]; index: Map<string, number> } | null = null;

  private depth = 0;
  private pending = new Map<string, Pending>();
  /** Removed in this batch: id → the element as it was, so a re-add can be compared. */
  private pendingRemoved = new Map<string, BoardElement>();
  private orderChanged = false;
  /** State before the batch of every element it touched (see `SceneChanges.previous`). */
  private before = new Map<string, BoardElement | undefined>();
  private origin: string | undefined = undefined;
  /** Cached highest z; null when it must be recomputed. */
  private zMax: number | null = 0;
  private readonly freeze: boolean;
  private guard: ((id: string) => boolean) | null = null;

  constructor(options: SceneOptions = {}) {
    this.index = new SpatialIndex(options.index);
    this.freeze = options.freeze ?? false;
  }

  get size(): number {
    return this.elements.size;
  }

  get(id: string): BoardElement | undefined {
    return this.elements.get(id);
  }

  has(id: string): boolean {
    return this.elements.has(id);
  }

  all(): IterableIterator<BoardElement> {
    return this.elements.values();
  }

  /**
   * Groups several mutations into one change event. Nestable; `origin` of the outermost
   * call tags the event (e.g. `load` passes one so the undo history ignores it).
   */
  transact<T>(action: () => T, origin?: string): T {
    if (this.depth === 0) this.origin = origin;
    this.depth++;
    try {
      return action();
    } finally {
      this.depth--;
      if (this.depth === 0) this.flush();
    }
  }

  /**
   * Refuses local edits of some elements, e.g. all of them on a read-only board: while
   * `canEdit(id)` is false, `add`, `update` and `remove` of that element change nothing
   * (the last two return false) in local batches (no origin, or the undo history's).
   * Tagged batches (e.g. loading) are not checked. `null` removes the guard.
   */
  setEditGuard(canEdit: ((id: string) => boolean) | null): void {
    this.guard = canEdit;
  }

  /** Whether the edit guard refuses changing `id` in the current batch. */
  private blocked(id: string): boolean {
    if (!this.guard) return false;
    const origin = this.depth === 0 ? undefined : this.origin;
    return (origin === undefined || origin === HISTORY_ORIGIN) && !this.guard(id);
  }

  /**
   * Adds an element. Throws if the id exists or the element is invalid (see
   * `validateElement`); does nothing if the edit guard refuses it (see `setEditGuard`).
   */
  add(element: BoardElement): void {
    if (this.blocked(element.id)) return;
    if (this.elements.has(element.id)) throw new Error(`Element ${element.id} already exists`);
    const problem = validateElement(element);
    if (problem) throw new Error(`Invalid element ${element.id}: ${problem}`);
    this.transact(() => {
      this.remember(element.id);
      const snapshot = this.snapshot({ ...element });
      this.elements.set(element.id, snapshot);
      this.joinGroup(snapshot.id, snapshot.groupId);
      if (this.zMax !== null && snapshot.z > this.zMax) this.zMax = snapshot.z;
      if (snapshot.type === 'connector') {
        this.attach(snapshot);
        this.dirtyRoutes.add(element.id);
      } else {
        this.placeShape(snapshot);
      }
      const removed = this.pendingRemoved.get(element.id);
      if (removed) {
        // Removed and re-added in one batch (undo, a whole element replaced): consumers
        // see an update, so a different z or type must force a re-sort.
        this.pendingRemoved.delete(element.id);
        this.pending.set(element.id, 'updated');
        if (removed.z !== snapshot.z || removed.type !== snapshot.type) this.orderChanged = true;
      } else {
        this.pending.set(element.id, 'added');
      }
      if (isShape(snapshot)) this.shapeChanged(element.id, undefined);
    });
  }

  /**
   * Applies a patch. Unknown ids are ignored and reported via the return value.
   * Throws, changing nothing, if the result would be invalid.
   */
  update(id: string, patch: ElementPatch): boolean {
    const previous = this.elements.get(id);
    if (!previous) return false;
    if (this.blocked(id)) return false;
    const next = patchedElement(previous, patch);
    const problem = validateElement(next);
    if (problem) throw new Error(`Invalid update of ${id}: ${problem}`);
    this.transact(() => {
      this.snapshot(next);
      this.remember(id);
      const previousBox = this.index.getBox(id);
      this.elements.set(id, next);
      if (previous.groupId !== next.groupId) {
        this.leaveGroup(id, previous.groupId);
        this.joinGroup(id, next.groupId);
      }
      if (next.type === 'connector') {
        if (previous.type === 'connector') this.detach(previous);
        this.attach(next);
        this.dirtyRoutes.add(id);
      } else if (isShape(previous) && shapeGeometryChanged(previous, next)) {
        this.placeShape(next);
        this.shapeChanged(id, previousBox);
      }
      this.markUpdated(id);
      if (next.z !== previous.z) {
        this.orderChanged = true;
        if (this.zMax !== null) {
          if (next.z > this.zMax) this.zMax = next.z;
          else if (previous.z === this.zMax) this.zMax = null;
        }
      }
    });
    return true;
  }

  remove(id: string): boolean {
    const element = this.elements.get(id);
    if (!element) return false;
    if (this.blocked(id)) return false;
    this.transact(() => {
      this.remember(id);
      const previousBox = this.index.getBox(id);
      this.elements.delete(id);
      this.index.delete(id);
      this.leaveGroup(id, element.groupId);
      if (element.z === this.zMax) this.zMax = null;
      if (element.type === 'connector') {
        this.detach(element);
        this.geometry.delete(id);
        this.elbows.delete(id);
        this.dirtyRoutes.delete(id);
      }
      const was = this.pending.get(id);
      this.pending.delete(id);
      // Added and removed within one batch: consumers never need to hear about it.
      if (was !== 'added') this.pendingRemoved.set(id, element);
      if (isShape(element)) this.shapeChanged(id, previousBox);
    });
    return true;
  }

  /** Removes elements and every connector attached to any of them (like deleting in Miro). */
  removeWithConnectors(ids: Iterable<string>): void {
    this.transact(() => {
      for (const id of ids) {
        for (const connectorId of this.connectorsOf(id)) this.remove(connectorId);
        this.remove(id);
      }
    });
  }

  clear(): void {
    this.transact(() => {
      for (const id of [...this.elements.keys()]) this.remove(id);
    });
  }

  /** Ids of the elements in a group (empty for an unknown group). */
  groupMembers(groupId: string): string[] {
    return [...(this.groups.get(groupId) ?? [])];
  }

  private joinGroup(id: string, groupId: string | undefined): void {
    if (groupId === undefined) return;
    let members = this.groups.get(groupId);
    if (!members) this.groups.set(groupId, (members = new Set()));
    members.add(id);
  }

  private leaveGroup(id: string, groupId: string | undefined): void {
    if (groupId === undefined) return;
    const members = this.groups.get(groupId);
    if (!members) return;
    members.delete(id);
    if (members.size === 0) this.groups.delete(groupId);
  }

  /** Connectors attached to a shape. */
  connectorsOf(shapeId: string): string[] {
    return [...(this.attachments.get(shapeId) ?? [])];
  }

  /** Resolved polyline of a connector, or null if an attached shape is missing. */
  connectorGeometry(id: string): ConnectorGeometry | null {
    this.settle();
    return this.geometry.get(id) ?? null;
  }

  /** Elements sorted bottom-to-top. Ties are broken by id so every client gets the same order. */
  sortedByZ(): BoardElement[] {
    if (!this.zOrder) {
      const elements = [...this.elements.values()].sort(compareZ);
      this.zOrder = {
        elements,
        index: new Map(elements.map((element, index) => [element.id, index])),
      };
    }
    return this.zOrder.elements.slice();
  }

  /** Keeps the paint order cache in step with a batch (see `zOrder`). */
  private updateZOrder(changes: SceneChanges): void {
    const cache = this.zOrder;
    if (!cache) return;
    if (changes.added.length > 0 || changes.removed.length > 0 || changes.orderChanged) {
      this.zOrder = null;
      return;
    }
    for (const element of changes.updated) {
      const index = cache.index.get(element.id);
      if (index === undefined) {
        this.zOrder = null;
        return;
      }
      cache.elements[index] = element;
    }
  }

  /** Highest z on the board, at least 0. Cached: O(1) unless the topmost element just went away. */
  maxZ(): number {
    if (this.zMax === null) {
      let z = 0;
      for (const element of this.elements.values()) if (element.z > z) z = element.z;
      this.zMax = z;
    }
    return Math.max(0, this.zMax);
  }

  /** Topmost element under the point, or undefined. */
  hitTest(point: Vec2, tolerance = 0): BoardElement | undefined {
    this.settle();
    const candidates = this.index.query(boxAroundPoint(point, tolerance));
    let best: BoardElement | undefined;
    for (const id of candidates) {
      const element = this.elements.get(id)!;
      if (best && compareZ(element, best) <= 0) continue;
      if (this.hits(element, point, tolerance)) best = element;
    }
    return best;
  }

  /** Topmost shape under the point, ignoring connectors (e.g. to attach a connector end). */
  hitTestShape(
    point: Vec2,
    tolerance = 0,
    exclude?: (id: string) => boolean,
  ): ShapeElement | undefined {
    let best: ShapeElement | undefined;
    for (const id of this.index.query(boxAroundPoint(point, tolerance))) {
      const element = this.elements.get(id)!;
      if (!isShape(element) || exclude?.(id)) continue;
      if (best && compareZ(element, best) <= 0) continue;
      if (hitTestElement(element, point, tolerance)) best = element;
    }
    return best;
  }

  /** Elements in a box, e.g. for marquee selection or culling. Unordered. */
  queryBox(box: Box, mode: BoxQueryMode = 'intersect'): BoardElement[] {
    this.settle();
    const found: BoardElement[] = [];
    for (const id of this.index.query(box)) {
      if (mode === 'contain' && !boxContainsBox(box, this.index.getBox(id)!)) continue;
      found.push(this.elements.get(id)!);
    }
    return found;
  }

  getBounds(id: string): Box | undefined {
    this.settle();
    return this.index.getBox(id);
  }

  /** Combined world bounds of all elements, or a selection. Missing/unresolved ids are skipped. */
  bounds(ids: Iterable<string> = this.elements.keys()): Box | null {
    this.settle();
    let bounds: Box | null = null;
    for (const id of ids) {
      const box = this.index.getBox(id);
      if (box) bounds = bounds ? boxUnion(bounds, box) : { ...box };
    }
    return bounds;
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private hits(element: BoardElement, point: Vec2, tolerance: number): boolean {
    if (isShape(element)) return hitTestElement(element, point, tolerance);
    const geometry = this.geometry.get(element.id);
    return !!geometry && hitTestConnector(element, geometry, point, tolerance);
  }

  private placeShape(element: ShapeElement): void {
    this.index.set(element.id, elementBounds(element));
  }

  /** Recomputes a connector's geometry (routing elbows around nearby shapes) and indexes it. */
  private placeConnector(element: ConnectorElement): void {
    const ends = new Set(attachedIds(element));
    const geometry = resolveConnector(element, this.getShape, (area) => {
      const obstacles: Box[] = [];
      for (const id of this.index.query(area)) {
        if (ends.has(id)) continue;
        const other = this.elements.get(id);
        if (other && isShape(other)) obstacles.push(this.index.getBox(id)!);
      }
      return obstacles;
    });
    this.geometry.set(element.id, geometry);
    if (geometry) this.index.set(element.id, geometry.bounds);
    else this.index.delete(element.id);
    if (element.route === 'elbow') this.elbows.add(element.id);
    else this.elbows.delete(element.id);
  }

  /** A shape was added, moved/resized, or removed (`previousBox`: where it was). */
  private shapeChanged(id: string, previousBox: Box | undefined): void {
    const attached = this.attachments.get(id);
    if (attached)
      for (const connectorId of attached)
        if (this.elements.has(connectorId)) this.dirtyRoutes.add(connectorId);
    if (this.elbows.size === 0) return;
    // Routes near where the shape was (may straighten) and where it is now (may need a detour).
    if (previousBox) this.dirtyAreas.push(previousBox);
    const box = this.index.getBox(id);
    if (box && this.elements.has(id)) this.dirtyAreas.push(box);
  }

  /** Recomputes pending connector geometry. Called before reads and at the end of a batch. */
  private settleRoutes(): void {
    if (this.dirtyAreas.length > 0) {
      const areas = this.dirtyAreas;
      this.dirtyAreas = [];
      // Only routes the change can affect: ones it now blocks, or detours that may straighten.
      const check = (id: string, area: Box) => {
        if (!this.elbows.has(id) || this.dirtyRoutes.has(id)) return;
        const geometry = this.geometry.get(id);
        if (geometry && (geometry.routed || connectorCrossesBox(geometry, area)))
          this.dirtyRoutes.add(id);
      };
      if (areas.length <= this.elbows.size) {
        for (const area of areas) for (const id of this.index.query(area)) check(id, area);
      } else {
        // Many changed shapes (e.g. dragging a big selection): index the areas and test
        // each elbow once against the areas near it instead of querying the scene per area.
        const areaIndex = new SpatialIndex<number>();
        areas.forEach((area, index) => areaIndex.set(index, area));
        for (const id of this.elbows) {
          const geometry = this.geometry.get(id);
          if (!geometry) continue;
          for (const index of areaIndex.query(geometry.bounds)) {
            if (this.dirtyRoutes.has(id)) break;
            const area = areas[index]!;
            if (boxIntersects(area, geometry.bounds)) check(id, area);
          }
        }
      }
    }
    if (this.dirtyRoutes.size === 0) return;
    const ids = [...this.dirtyRoutes];
    this.dirtyRoutes.clear();
    for (const id of ids) {
      const connector = this.elements.get(id);
      if (!connector || connector.type !== 'connector') continue;
      this.placeConnector(connector);
      this.markUpdated(id);
    }
  }

  private settle(): void {
    if (this.dirtyRoutes.size > 0 || this.dirtyAreas.length > 0) this.settleRoutes();
  }

  /** Keeps the state an element had before the current batch first touched it. */
  private remember(id: string): void {
    if (!this.before.has(id)) this.before.set(id, this.elements.get(id));
  }

  private markUpdated(id: string): void {
    if (this.pending.get(id) !== 'added') this.pending.set(id, 'updated');
  }

  private attach(connector: ConnectorElement): void {
    for (const id of attachedIds(connector)) {
      let connectors = this.attachments.get(id);
      if (!connectors) this.attachments.set(id, (connectors = new Set()));
      connectors.add(connector.id);
    }
  }

  private detach(connector: ConnectorElement): void {
    for (const id of attachedIds(connector)) {
      const connectors = this.attachments.get(id);
      if (!connectors) continue;
      connectors.delete(connector.id);
      if (connectors.size === 0) this.attachments.delete(id);
    }
  }

  private flush(): void {
    this.settleRoutes();
    const previous = this.before;
    this.before = new Map();
    const origin = this.origin;
    this.origin = undefined;
    if (this.pending.size === 0 && this.pendingRemoved.size === 0) {
      this.orderChanged = false;
      return;
    }
    // Added and removed within the batch: nothing happened as far as consumers can tell.
    for (const [id, was] of previous)
      if (was === undefined && !this.elements.has(id)) previous.delete(id);
    const changes: SceneChanges = {
      added: [],
      updated: [],
      removed: [...this.pendingRemoved.keys()],
      orderChanged: this.orderChanged,
      previous,
      origin,
    };
    for (const [id, kind] of this.pending) changes[kind].push(this.elements.get(id)!);
    this.pending.clear();
    this.pendingRemoved.clear();
    this.orderChanged = false;
    this.updateZOrder(changes);
    // A failing listener must not leave the others out of sync: notify all, then rethrow.
    let failed = false;
    let error: unknown;
    for (const listener of this.listeners) {
      try {
        listener(changes);
      } catch (failure) {
        if (!failed) error = failure;
        failed = true;
      }
    }
    if (failed) throw error;
  }

  private snapshot<T extends BoardElement>(element: T): T {
    return this.freeze ? deepFreeze(element) : element;
  }
}

export function compareZ(first: BoardElement, second: BoardElement): number {
  return first.z - second.z || (first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
}

/** Only contour changes affect the spatial index and attached/nearby connector routes. */
function shapeGeometryChanged(first: ShapeElement, second: ShapeElement): boolean {
  return (
    first.x !== second.x ||
    first.y !== second.y ||
    first.width !== second.width ||
    first.height !== second.height ||
    first.rotation !== second.rotation ||
    first.strokeWidth !== second.strokeWidth ||
    first.radius !== second.radius ||
    first.sides !== second.sides
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
