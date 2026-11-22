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
/** What a member reads; `null`: anything (commands, which a selector shouldn't call). */
type Dependencies = readonly Dependency[] | null;

/** The groups of the editor's API (`editor.selection`…), tracked member by member. */
type GroupName =
  | 'tools'
  | 'selection'
  | 'elements'
  | 'text'
  | 'history'
  | 'camera'
  | 'clipboard'
  | 'preview';

/**
 * Which state each public member of `BoardEditor` reads, for `useBoardState`'s dependency
 * tracking. A member missing here is a type error, so new editor API has to say what it
 * depends on.
 */
const MEMBER_DEPENDENCIES: { readonly [K in Exclude<keyof BoardEditor, GroupName>]: Dependencies } =
  {
    scene: ['scene'],
    theme: ['theme'],
    readOnly: ['readOnly'],
    isElementLocked: ['locks'],
    setLockedElements: null,
    isInteracting: ['gesture'],
    pointer: ['pointer'],
    renderer: ['mount'],
    overlay: ['mount'],
    isMounted: ['mount'],
    isDestroyed: [],
    setTheme: null,
    setReadOnly: null,
    on: null,
    exportImage: null,
    mount: null,
    unmount: null,
    destroy: null,
  };

const GROUP_DEPENDENCIES: {
  readonly [G in GroupName]: { readonly [K in keyof BoardEditor[G]]: Dependencies };
} = {
  tools: {
    current: ['tool'],
    getDefaults: ['tool'],
    activate: null,
    setDefaults: null,
    register: null,
  },
  selection: {
    ids: ['selection'],
    elements: ['selection', 'selectionScene'],
    bounds: ['selection', 'selectionScene'],
    set: null,
    all: null,
    clear: null,
    update: null,
    delete: null,
    reorder: null,
    group: null,
    ungroup: null,
  },
  elements: {
    getAll: ['scene'],
    create: null,
    createText: null,
    add: null,
    addFiles: null,
    update: null,
    remove: null,
    load: null,
    crop: null,
  },
  text: {
    editing: ['editing'],
    format: ['textFormat', 'mount'],
    edit: null,
    stop: null,
    apply: null,
  },
  history: {
    canUndo: ['history', 'readOnly'],
    canRedo: ['history', 'readOnly'],
    undo: null,
    redo: null,
    batch: null,
    replace: null,
  },
  camera: {
    x: ['camera'],
    y: ['camera'],
    zoom: ['camera'],
    center: ['camera', 'mount'],
    clientToWorld: ['camera', 'mount'],
    worldToScreen: ['camera', 'mount'],
    screenToWorld: ['camera', 'mount'],
    set: null,
    zoomTo: null,
  },
  clipboard: { content: ['clipboard'], copy: null, cut: null, paste: null, duplicate: null },
  preview: { draft: ['preview'], show: null, apply: null, discard: null },
};

const isGroup = (property: PropertyKey): property is GroupName =>
  typeof property === 'string' && Object.hasOwn(GROUP_DEPENDENCIES, property);

/** Every dependency there is (a selector that reads something unknown). */
const ALL: ReadonlySet<Dependency> = new Set<Dependency>([
  'mount',
  'tool',
  'selection',
  'history',
  'camera',
  'editing',
  'textFormat',
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

/** Records a read of a member that depends on `dependencies`. */
function record(dependencies: Dependencies | undefined): void {
  if (!tracking) return;
  tracking.reads++;
  if (dependencies) for (const dependency of dependencies) tracking.dependencies.add(dependency);
  else tracking.unknown = true;
}

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
    // Each group read member by member; its functions are bound already.
    const groups = new Map<GroupName, object>();
    const groupOf = (name: GroupName): object => {
      let tracked = groups.get(name);
      if (!tracked) {
        const dependencies = GROUP_DEPENDENCIES[name] as Readonly<
          Record<PropertyKey, Dependencies>
        >;
        tracked = new Proxy(editor[name], {
          get(target, property) {
            record(Object.hasOwn(dependencies, property) ? dependencies[property] : null);
            return Reflect.get(target, property, target) as unknown;
          },
        });
        groups.set(name, tracked);
      }
      return tracked;
    };
    this.tracked = new Proxy(editor, {
      get(target, property) {
        if (property === 'scene') {
          if (tracking) {
            tracking.reads++;
            tracking.sceneRead = true;
          }
          return scene;
        }
        if (isGroup(property)) return groupOf(property);
        record(
          typeof property === 'string' && Object.hasOwn(MEMBER_DEPENDENCIES, property)
            ? MEMBER_DEPENDENCIES[property as keyof typeof MEMBER_DEPENDENCIES]
            : null,
        );
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
            if (touches(changes, idSet(this.editor.selection.ids))) listener();
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
    /** Nothing was read through the argument. */
    untracked: boolean;
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
        untracked: current.reads === 0,
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

/** A set of the ids of an array that is replaced, never mutated (`editor.selection.ids`). */
export function idSet(ids: readonly string[]): ReadonlySet<string> {
  let set = idSets.get(ids);
  if (!set) idSets.set(ids, (set = new Set(ids)));
  return set;
}
