import type { SceneChanges } from '@apeiro/core';
import type { BoardEditor, BoardEditorEvent } from '@apeiro/editor';

/** What a hook can depend on: an editor event, or the scene's content. */
export type Dependency =
  | BoardEditorEvent
  | 'scene'
  | 'selectionScene'
  | 'sceneSize'
  | `element:${string}`;

type Listener = () => void;
type SceneListener = (changes: SceneChanges) => void;

/**
 * Which state each public member of `BoardEditor` reads, for `useBoardState`'s dependency
 * tracking; `null`: anything (commands, which a selector shouldn't call). A member missing
 * here is a type error, so new editor API has to say what it depends on.
 */
const MEMBER_DEPENDENCIES: Record<keyof BoardEditor, readonly Dependency[] | null> = {
  scene: ['scene'],
  getElements: ['scene'],
  camera: ['camera'],
  animator: ['camera'],
  view: ['camera'],
  viewCenter: ['camera', 'mount'],
  clientToWorld: ['camera', 'mount'],
  tools: ['tool'],
  tool: ['tool'],
  history: ['history'],
  canUndo: ['history'],
  canRedo: ['history'],
  selection: ['selection'],
  selectedElements: ['selection', 'selectionScene'],
  selectionBounds: ['selection', 'selectionScene'],
  editing: ['editing'],
  textFormat: ['textFormat'],
  theme: ['theme'],
  isInteracting: ['gesture'],
  pointer: ['pointer'],
  renderer: ['mount'],
  overlay: ['mount'],
  isMounted: ['mount'],
  isDestroyed: [],
  clipboard: ['clipboard'],
  readOnly: ['readOnly'],
  preview: ['preview'],
  // Commands.
  setReadOnly: null,
  exportImage: null,
  showPreview: null,
  applyPreview: null,
  discardPreview: null,
  setHistory: null,
  setTool: null,
  setConnectorStyle: null,
  setPenStyle: null,
  select: null,
  selectAll: null,
  clearSelection: null,
  setTheme: null,
  on: null,
  undo: null,
  redo: null,
  batch: null,
  addElements: null,
  updateElements: null,
  updateSelection: null,
  deleteSelection: null,
  removeElements: null,
  reorderSelection: null,
  group: null,
  ungroup: null,
  zoomTo: null,
  place: null,
  addText: null,
  editText: null,
  stopEditing: null,
  formatText: null,
  addFiles: null,
  copy: null,
  cut: null,
  paste: null,
  pasteFromClipboard: null,
  duplicate: null,
  pasteText: null,
  cropImage: null,
  load: null,
  mount: null,
  unmount: null,
  destroy: null,
};

/** Every dependency there is (a selector that reads something unknown). */
const ALL: ReadonlySet<Dependency> = new Set<Dependency>([
  'mount',
  'tool',
  'selection',
  'history',
  'camera',
  'editing',
  'theme',
  'pointer',
  'clipboard',
  'gesture',
  'readOnly',
  'preview',
  'scene',
]);

/** The dependencies being collected by `track`, and how many members were read. */
let tracking: {
  dependencies: Set<Dependency>;
  reads: number;
  unknown: boolean;
  sceneRead: boolean;
  sceneObserved: boolean;
} | null = null;

/**
 * The hooks' view of one editor: a single subscription per editor event and to the scene,
 * shared by every hook of every component, with listeners per event, per element and for
 * scene changes. Created on first use, kept as long as the editor.
 */
export class BoardStore {
  private readonly events = new Map<BoardEditorEvent, Set<Listener>>();
  private readonly offEvents = new Map<BoardEditorEvent, () => void>();
  private readonly sceneListeners = new Set<SceneListener>();
  private readonly elementListeners = new Map<string, Set<Listener>>();
  private offScene: (() => void) | null = null;
  private readonly bound = new Map<PropertyKey, unknown>();
  /** The editor as selectors see it: records what they read (see `track`). */
  private readonly tracked: BoardEditor;

  constructor(readonly editor: BoardEditor) {
    const bound = this.bound;
    const sceneMethods = new Map<PropertyKey, unknown>();
    const elementReads = new Set<PropertyKey>(['get', 'has', 'getBounds', 'connectorGeometry']);
    const scene = new Proxy(editor.scene, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'size') {
          if (tracking) {
            tracking.sceneObserved = true;
            tracking.dependencies.add('sceneSize');
          }
          return value;
        }
        if (!elementReads.has(property) && tracking) {
          tracking.sceneObserved = true;
          tracking.dependencies.add('scene');
        }
        if (typeof value !== 'function') return value;
        let method = sceneMethods.get(property);
        if (!method) {
          method = (...args: unknown[]) => {
            if (elementReads.has(property) && tracking) {
              tracking.sceneObserved = true;
              tracking.dependencies.add(`element:${String(args[0])}`);
            }
            return Reflect.apply(value, target, args) as unknown;
          };
          sceneMethods.set(property, method);
        }
        return method;
      },
    });
    this.tracked = new Proxy(editor, {
      get(target, property) {
        if (property === 'scene') {
          if (tracking) {
            tracking.reads++;
            tracking.sceneRead = true;
          }
          return scene;
        }
        if (tracking) {
          tracking.reads++;
          const dependencies =
            typeof property === 'string' && Object.hasOwn(MEMBER_DEPENDENCIES, property)
              ? MEMBER_DEPENDENCIES[property as keyof BoardEditor]
              : null;
          if (dependencies)
            for (const dependency of dependencies) tracking.dependencies.add(dependency);
          else tracking.unknown = true;
        }
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        // Methods run on the editor itself, so their internals aren't tracked.
        let method = bound.get(property);
        if (!method)
          bound.set(property, (method = (value as (...args: unknown[]) => unknown).bind(target)));
        return method;
      },
    });
  }

  /** Listens to an editor event. */
  on(event: BoardEditorEvent, listener: Listener): () => void {
    let set = this.events.get(event);
    if (!set) {
      const listeners = (set = new Set());
      this.events.set(event, listeners);
      this.offEvents.set(
        event,
        this.editor.on(event, () => {
          for (const listener of listeners) listener();
        }),
      );
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size > 0 || this.events.get(event) !== set) return;
      this.events.delete(event);
      this.offEvents.get(event)?.();
      this.offEvents.delete(event);
    };
  }

  /** Listens to every batch of scene changes. */
  onScene(listener: SceneListener): () => void {
    this.sceneListeners.add(listener);
    this.retainScene();
    return () => {
      this.sceneListeners.delete(listener);
      this.releaseScene();
    };
  }

  /** Listens to changes of one element (added, updated — re-routes included — or removed). */
  onElement(id: string, listener: Listener): () => void {
    let set = this.elementListeners.get(id);
    if (!set) this.elementListeners.set(id, (set = new Set()));
    set.add(listener);
    this.retainScene();
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.elementListeners.get(id) === set) this.elementListeners.delete(id);
      this.releaseScene();
    };
  }

  /** Listens to several dependencies at once; `onScene` (default: any change) for `scene`. */
  watch(
    dependencies: Iterable<Dependency>,
    listener: Listener,
    onScene: SceneListener = () => listener(),
  ): () => void {
    const unsubscribers: Array<() => void> = [];
    for (const dependency of dependencies) {
      if (dependency === 'scene') unsubscribers.push(this.onScene(onScene));
      else if (dependency === 'selectionScene')
        unsubscribers.push(
          this.onScene((changes) => {
            if (touches(changes, idSet(this.editor.selection))) listener();
          }),
        );
      else if (dependency === 'sceneSize')
        unsubscribers.push(
          this.onScene((changes) => {
            if (changes.added.length > 0 || changes.removed.length > 0) listener();
          }),
        );
      else if (dependency.startsWith('element:'))
        unsubscribers.push(this.onElement(dependency.slice('element:'.length), listener));
      else unsubscribers.push(this.on(dependency as BoardEditorEvent, listener));
    }
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }

  /**
   * Runs `select` on the editor and reports what it read: the dependencies to listen to
   * for its result to stay current. Reading nothing known (e.g. an editor captured from a
   * closure instead of the argument) depends on everything.
   */
  track<T>(select: (editor: BoardEditor) => T): {
    value: T;
    dependencies: ReadonlySet<Dependency>;
  } {
    const outer = tracking;
    const current = {
      dependencies: new Set<Dependency>(),
      reads: 0,
      unknown: false,
      sceneRead: false,
      sceneObserved: false,
    };
    tracking = current;
    try {
      const value = select(this.tracked);
      if (current.sceneRead && !current.sceneObserved) current.dependencies.add('scene');
      return {
        value,
        dependencies: current.unknown || current.reads === 0 ? ALL : current.dependencies,
      };
    } finally {
      tracking = outer;
    }
  }

  private retainScene(): void {
    if (this.offScene) return;
    this.offScene = this.editor.scene.subscribe(this.dispatchScene);
  }

  private releaseScene(): void {
    if (!this.offScene || this.sceneListeners.size > 0 || this.elementListeners.size > 0) return;
    this.offScene();
    this.offScene = null;
  }

  private readonly dispatchScene = (changes: SceneChanges): void => {
    for (const listener of this.sceneListeners) listener(changes);
    const byId = this.elementListeners;
    if (byId.size === 0) return;
    const fire = (id: string) => {
      const set = byId.get(id);
      if (set) for (const listener of set) listener();
    };
    for (const element of changes.added) fire(element.id);
    for (const element of changes.updated) fire(element.id);
    for (const id of changes.removed) fire(id);
  };
}

const stores = new WeakMap<BoardEditor, BoardStore>();

/** The store of an editor (one per editor, shared by all hooks). */
export function storeOf(editor: BoardEditor): BoardStore {
  let store = stores.get(editor);
  if (!store) stores.set(editor, (store = new BoardStore(editor)));
  return store;
}

/** Same dependencies (by content). */
export function sameDependencies(
  first: ReadonlySet<Dependency> | null,
  second: ReadonlySet<Dependency>,
): boolean {
  if (first === second) return true;
  if (!first || first.size !== second.size) return false;
  for (const dependency of first) if (!second.has(dependency)) return false;
  return true;
}

/** Whether a batch touches any of `ids` (e.g. the selection). */
export function touches(changes: SceneChanges, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  for (const element of changes.updated) if (ids.has(element.id)) return true;
  for (const id of changes.removed) if (ids.has(id)) return true;
  for (const element of changes.added) if (ids.has(element.id)) return true;
  return false;
}

const idSets = new WeakMap<readonly string[], ReadonlySet<string>>();

/** A set of the ids of an array that is replaced, never mutated (`editor.selection`). */
export function idSet(ids: readonly string[]): ReadonlySet<string> {
  let set = idSets.get(ids);
  if (!set) idSets.set(ids, (set = new Set(ids)));
  return set;
}
