# Apeiro

An infinite canvas whiteboard for the web, with WebGPU rendering and a WebGL2 fallback.
It supports sticky notes, shapes, connectors, rich text, pen strokes, images, audio and
undo/redo. Use it with React or directly from JavaScript. Your application owns persistence
and sharing; the board reports content changes through `onChange`.

## Install

```sh
npm install apeiro
```

React 18.2 or 19 is a peer dependency when using `apeiro/react`. The framework-free entry
does not require React. Import `apeiro/styles.css` once in your application.

## Quick start

```tsx
// app/layout.tsx
import 'apeiro/styles.css';
```

```tsx
// app/page.tsx
import { Board } from 'apeiro/react';

export default function Page() {
  return <Board style={{ height: '100vh' }} />;
}
```

Declare elements as React components, using board coordinates:

```tsx
import { Board, Rect, Sticky, Text } from 'apeiro/react';

export function Canvas() {
  return (
    <Board style={{ height: '100vh' }}>
      <Sticky id="note" x={100} y={100} text="Edit me" fill="#fde68a" />
      <Rect id="box" x={360} y={100} width={200} height={120} fill="#bfdbfe" />
      <Text id="label" x={100} y={320} width={300} text="Hello, React" />
    </Board>
  );
}
```

`Rect`, `Ellipse`, `Polygon`, `Sticky` and `Text` use the same editable scene as the
tools. `Shape` accepts a `type` for those kinds; `Element` accepts an `element` object
for any kind, including connectors, images and ink. Colors accept packed RGBA numbers
or hex strings. Rotation is in radians; `z` controls paint order and otherwise follows
mount order. Omit `id` on shapes to generate one, or provide a stable id for saved or
shared elements. Use React `key` when rendering a list.

Changed props update the element. Unchanged props preserve moves, text edits and remote
changes. `onChange(element)` reports edits outside React, and receives `undefined` for
deletion. A deleted element stays deleted until its component is remounted. Unmounting
a component removes its element; an existing element with its id is adopted without
resetting its saved state. Components also work directly under `BoardProvider`.

For Yjs, use `Board collaboration={{ document, awareness }}` to connect before element
components mount. Use adapter `initialElements` for shared starter data with stable ids;
declare subsequent JSX elements on the client that creates them.

Add a toolbar and connect the board to your own storage:

```tsx
'use client';
import type { BoardElement } from 'apeiro';
import { Board, useBoard, useHistory, useTool } from 'apeiro/react';

export function Whiteboard({
  saved,
  save,
}: {
  saved: BoardElement[];
  save: (elements: BoardElement[]) => void;
}) {
  return (
    <Board style={{ height: '100vh' }} config={{ initialElements: saved, onChange: save }}>
      <Toolbar />
    </Board>
  );
}

function Toolbar() {
  const board = useBoard();
  const tool = useTool();
  const { canUndo } = useHistory();
  return (
    <div style={{ position: 'absolute', left: 12, top: 12 }}>
      <button aria-pressed={tool === 'sticky'} onClick={() => board.tools.activate('sticky')}>
        Sticky
      </button>
      <button disabled={!canUndo} onClick={board.history.undo}>
        Undo
      </button>
    </div>
  );
}
```

Children of `<Board>` are drawn over the canvas. Give the board or its parent a size.
`useBoard()` gives access to commands; the hooks subscribe to state for rendering.

## Components

- `<Board>` — the canvas.
- `<BoardProvider>` — for UI outside the canvas:

```tsx
<BoardProvider config={{ initialElements: saved, onChange: save }}>
  <Sidebar />
  <Board style={{ height: '100vh' }} />
</BoardProvider>
```

Pass `config` to the provider when using one; `config` on a nested `<Board>` is ignored.
The provider can also receive an existing `editor={board}`. In that case it does not
destroy the editor on unmount, and the editor's creation options remain in effect.

The board is configured by one object, `config` (of `<Board>` or `<BoardProvider>`); the
props of `<Board>` are only about how it is shown. Define a config once and reuse or
extend it:

```ts
import type { BoardOptions } from 'apeiro/react';

const boardConfig = {
  theme: 'system',
  grid: 'dots',
} satisfies BoardOptions;
```

```tsx
<Board config={boardConfig} style={{ height: '100vh' }} />
<Board config={{ ...boardConfig, readOnly: true }} />
```

`theme`, `readOnly` and the callbacks can change at any time (the theme and read-only mode
follow the config only); the other options are read once, when the board is created (give
the component a new `key` to start over).

| Option                  | Default         | Description                                                                |
| ----------------------- | --------------- | -------------------------------------------------------------------------- |
| `initialElements`       | empty           | Initial board content                                                      |
| `onChange`              | —               | `(elements, changes) => void`; see [Saving data](#saving-data)             |
| `onReady`               | —               | `(board) => void` when the renderer starts                                 |
| `onError`               | `console.error` | Reports renderer startup, file, clipboard, listener and custom tool errors |
| `theme`                 | `'light'`       | `'light'`, `'dark'` or `'system'`                                          |
| `readOnly`              | `false`         | Allow viewing and selection, but prevent edits                             |
| `grid`                  | `'lines'`       | `'lines'`, `'dots'` or `'none'`                                            |
| `backend`               | `'auto'`        | `'auto'`, `'webgpu'` or `'webgl'`                                          |
| `snapping`              | `true`          | Show smart guides while moving or resizing                                 |
| `smoothCamera`          | `true`          | Animate zoom and pan                                                       |
| `upload`                | object URLs     | `(file) => Promise<string>`; store imported images and audio               |
| `mediaOrigins`          | `[]`            | Additional allowed origins for images and audio                            |
| `openLink`              | new tab         | `(href) => void` for links in board text                                   |
| `onComment`             | —               | `(point) => void` when the comment tool is used                            |
| `scene`, `history`      | new instances   | Provide a scene or undo history                                            |
| `camera`                | —               | Initial camera options                                                     |
| `preserveDrawingBuffer` | `false`         | Preserve rendered frames for screenshots; forces WebGL                     |

Set zoom limits, step and wheel/pinch sensitivity in `config.camera`:

```tsx
<Board
  config={{
    camera: {
      minZoom: 0.1,
      maxZoom: 8,
      zoomStep: 1.1,
      wheelZoomSensitivity: 0.5,
    },
    smoothCamera: true,
  }}
/>
```

`zoomStep` is a multiplier of at least 1 (default 1.25); 1 leaves the zoom unchanged. It applies to
`camera.zoomTo('in' / 'out')` and the `+` / `−` shortcuts, with or without Ctrl/⌘.
Zoom-out divides by the same factor, so the two steps cancel each other.
`wheelZoomSensitivity` is a positive multiplier (default 1); 0.5 makes Ctrl/⌘+wheel
and trackpad pinch half as sensitive, while 2 makes them twice as sensitive.
Ordinary scrolling still pans. These camera options are read when the board is created.

`<Board>` props: `className`, `style`, `children`, `fallback` (until the board runs, e.g. a
spinner) and `errorFallback` (instead of the board when neither WebGPU nor WebGL2 works; a
function gets the error).

On the server and while hydrating, `<Board>` renders its fallback and waits to start the
renderer in the browser. In Next.js, components with hooks or callback props belong in a
client module (`'use client'`).

## Commands

`useBoard()` is the board itself (`BoardEditor`, the same object as without React). Its
commands are grouped by what they work on, bound and stable: pass them to `onClick`
directly. Commands that change the board do nothing on a read-only one, except
`elements.load`, which can replace its content.

| Group       | Commands                                                                                                              | State                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `tools`     | `activate(tool, { repeat })`, `setDefaults(kind, style)`, `getDefaults(kind)`, `register`                             | `current`                                                      |
| `selection` | `set`, `clear`, `all`, `update(patch)`, `delete`, `reorder('front')`, `group`, `ungroup`                              | `ids`, `elements()`, `bounds()`                                |
| `elements`  | `create(kind, { at, box, style, text, select })`, `createText`, `add`, `addFiles`, `update`, `remove`, `load`, `crop` | `getAll()`                                                     |
| `text`      | `edit(id)`, `stop()`, `apply(command)`                                                                                | `editing`, `format`                                            |
| `history`   | `undo`, `redo`, `batch(fn)`                                                                                           | `canUndo`, `canRedo`                                           |
| `camera`    | `zoomTo('in' \| 'out' \| 'fit' \| 'selection' \| 'reset' \| zoom)`, `set({ x, y, zoom })`                             | `x`, `y`, `zoom`, `center()`, `clientToWorld`, `worldToScreen` |
| `clipboard` | `copy`, `cut`, `paste({ at })`, `duplicate`                                                                           | `content`                                                      |
| `preview`   | `show(draft)`, `apply`, `discard`                                                                                     | `draft`                                                        |
|             | `exportImage({ scale, ids, area })` → PNG `Blob`, `setTheme`, `setReadOnly` (in React: the config), `on`              | `scene`, `theme`, `readOnly`                                   |

`elements.create` makes a sticky or shape as its tool does, styled and labelled in one undo
step: `board.elements.create('rect', { box, style: { fill: hexColor('#fde68a') }, text: 'Idea' })`.
`tools.getDefaults(kind)` is the full style the tool creates (e.g. the current pen color).
Built-in tool names are `select`, `hand`, `connector`, `text`, `pen`, `eraser`, `comment`,
`sticky`, `rect`, `ellipse` and `polygon`. Use `onComment` to provide a comment UI.

`elements.load` replaces the entire board, validates elements and clears undo history; it is
not undoable. `history.batch(fn)` combines scene changes into one undo step. A preview can
show proposed `add`, `update` and `remove` changes before `preview.apply()` commits them.

## Hooks

Hooks return state and re-render only when what they return changes.

| Hook                                                       | Returns                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `useBoardState((board) => …)`                              | Any state                                                        |
| `useTool()`, `useBoardTheme()`, `useZoomPercent()`         | The tool, the theme, `83`                                        |
| `useSelectedIds()`, `useSelectedElements()`                | Selection                                                        |
| `useElement(id)`                                           | Content                                                          |
| `useHistory()`, `useClipboard()`                           | `{ canUndo, canRedo }`, `{ canCopy, canCut, canPaste, hasCopy }` |
| `usePreview()`                                             | The previewed draft                                              |
| `useSelectionScreenBounds()`, `useElementScreenBounds(id)` | Boxes on screen                                                  |
| `useTextEditing()`                                         | `{ id, format, bounds }`                                         |
| `useFloating(box)`                                         | `{ ref, style }` next to a box                                   |
| `useBoardChange(fn)`, `useBoardEvent(event, fn)`           | Callbacks, no re-rendering                                       |

`useBoardState` tracks what the selector reads through its argument: `(board) =>
board.camera.zoom` re-runs on camera changes only. A selector that uses a board from a
closure can't be tracked and warns.

## Text formatting

The board has no formatting toolbar: show your own while a text is edited. Put it inside
`data-ap-text-controls`: pressing it keeps the text open, and its buttons keep the text's
selection.

```tsx
import { useBoard, useFloating, useTextEditing } from 'apeiro/react';

function TextToolbar() {
  const editing = useTextEditing();
  const floating = useFloating(editing?.bounds); // above the text, inside the board
  const board = useBoard();
  if (!editing) return null;
  return (
    <div ref={floating.ref} style={floating.style} data-ap-text-controls>
      <button
        aria-pressed={editing.format.bold}
        onClick={() => board.text.apply({ type: 'toggle', style: 'bold' })}
      >
        B
      </button>
    </div>
  );
}
```

Commands: `toggle` (bold, italic, underline, strike), `color`, `font`, `fontSize` (a number, or
`'auto'`: the text fills its box, the default of stickies),
`stepSize`, `list`, `indent`, `align`, `link` (`href: null` removes it). Keyboard
shortcuts (Ctrl+B/I/U, Ctrl+Shift+X/7/8, Ctrl+Shift+< />, Tab) still work.

## Without React

The same object and commands:

```ts
import { BoardEditor } from 'apeiro';
import 'apeiro/styles.css';

const host = document.getElementById('board');
if (!host) throw new Error('Board container not found');

const board = new BoardEditor();
await board.mount(host); // rejects if the renderer cannot start
const unsubscribe = board.on('selection', () => console.log(board.selection.ids));

// Later: unsubscribe(); board.destroy();
```

Give the container a width and height. Use `board.elements.load(saved)` to restore content
and `board.elements.getAll()` to read it. `board.on(...)` returns an unsubscribe function.

## Saving data

The application is responsible for saving and restoring the array of `BoardElement` values.
Pass it as `initialElements` when creating a React board, or use `elements.load` later.
`onChange(elements, changes)` reports the full current array and a `BoardChanges` object:
`added` and `updated` contain whole elements, `removed` contains IDs, and `origin` is
`undefined` for local edits, `'history'` for undo/redo, or `'load'` for `elements.load`.
Changes made together are grouped; a drag or stroke is reported when it ends.
`initialElements` does not trigger `onChange`. These callbacks provide data for your own
storage or synchronization; they do not implement collaboration.

By default imported images and audio use temporary object URLs. To restore them in another
session or share them, supply `upload` to store files and return persistent URLs. Add any
external media origins to `mediaOrigins` as needed.

## Collaboration with Yjs

`apeiro/yjs` connects the same editor to Yjs in React or plain JavaScript. Yjs is
optional: applications that do not import this entry do not need it installed.

```sh
npm install apeiro yjs
# For presence, also install your provider's y-protocols peer:
npm install y-protocols
```

Create a Yjs document and connect it with your preferred provider (WebSocket, WebRTC,
offline persistence, or your own transport). Pass that document to the binding:

```ts
import { BoardEditor } from 'apeiro';
import { bindYjs } from 'apeiro/yjs';
import * as Y from 'yjs';
import 'apeiro/styles.css';

const sharedDocument = new Y.Doc();
// Connect your provider to sharedDocument here.
const board = new BoardEditor({ upload: uploadFile });
const binding = bindYjs(board, {
  document: sharedDocument,
  // awareness: provider.awareness, // optional remote cursors and selections
  user: { name: 'Alice', color: '#2563eb' },
  onError: (error) => console.error('Collaboration:', error),
});

await board.mount(container);

// On leaving: board.destroy() also disconnects its binding.
board.destroy();
// The application separately destroys its provider and sharedDocument when no longer used.
```

The shared document owns the content: connecting replaces any existing elements in the
editor with shared elements. A provider can sync later; received elements appear as they
arrive. For a saved board, prefer restoring persisted Yjs updates. To import a JSON board,
add its elements with `board.elements.add(savedElements)` **once**, after initial provider
sync, under application/server control. Every joining client must not seed the document;
checking whether a document is empty does not coordinate concurrent clients.

In React, pass document/provider settings directly to `Board`:

```tsx
import { Board, type DocumentCollaborationOptions } from 'apeiro/react';

export function SharedBoard(options: DocumentCollaborationOptions) {
  return (
    <Board
      collaboration={options}
      style={{ height: '100vh' }}
      fallback={<p>Connecting…</p>}
      errorFallback={(error) => <p>{String(error)}</p>}
    />
  );
}

// The application creates and owns its document and network provider.
// <SharedBoard document={doc} awareness={provider.awareness} user={currentUser} />
```

The adapter connects before descendants mount, so JSX elements declared under the
provider or inside `Board` can safely use the shared scene. It handles subscriptions,
shared history, cursors, selection reservations and cleanup, including StrictMode.
The configuration may be created inline: equivalent connection options do not reconnect or reset
undo history. `user`, `showPresence` and `onError` update live. Changing `document`,
`awareness`, `name` or `whenSynced` replaces the connection. The document and network
provider remain owned by your application and are never destroyed by the adapter.

Pass your provider's initial-sync promise as `whenSynced` when remote data has not loaded
yet. The provider shows its `fallback` until sync and initialization finish; errors go to
`config.onError` and `errorFallback`. Without `whenSynced`, the supplied document is used
immediately. `initialElements`, if needed, belongs in `collaboration`, rather than the React config:

```tsx
<Board
  collaboration={{
    document: doc,
    awareness: provider.awareness,
    whenSynced: initialSync,
    initialElements: starterElements,
    user: currentUser,
  }}
  style={{ height: '100vh' }}
/>
```

Seeding runs after initial sync, preserves existing shared content, and is recorded as
initialized in the document, so deleting every element does not seed it again. It adds
no undo step. Provide the same initial data with stable ids on every client; concurrent
seeds then converge to the same elements. JSX components remain available for subsequent
declarative changes. `bindYjs` is also available for manual lifecycle control or use
without React.

Binding options:

| Option         | Description                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------- |
| `document`     | Application-owned `Y.Doc`; required                                                          |
| `name`         | Collection name, default `'apeiro'`; use different names for multiple boards in one document |
| `awareness`    | Provider's Awareness instance; enables presence                                              |
| `user`         | `{ name, color, id? }`; use a CSS hex color such as `'#2563eb'`                              |
| `showPresence` | Draw remote cursors and selected bounds; default `true`                                      |
| `onError`      | Reports invalid remote data, retaining the last valid scene; default `console.error`         |

The returned binding exposes `document`, `peers`, `setUser(user)`, `setShowPresence(show)`,
`subscribePresence(listener)` and `destroy()`. You can render your own participants UI
from `peers`; `showPresence: false` turns off built-in drawing. With Awareness, selecting
an element reserves it for that participant: other clients cannot select, move, resize,
edit or delete it, including through React props and undo/redo. Deselecting or removing
the participant's Awareness state releases the reservation. Simultaneous claims resolve
to one owner consistently on every client. Reservations also apply with drawing hidden.
`board.isElementLocked(id)` reports whether another participant has reserved an element.

`destroy()` is idempotent,
retains the visible content and restores a fresh local undo history. It never destroys
your document, Awareness instance or provider. Destroying the editor or shared document
also disconnects the binding. One editor can have one binding at a time.

Element fields merge independently; simultaneous edits to the same field resolve through
Yjs. Nested values such as connector ends and media metadata are atomic fields. Rich text
uses `Y.Text`, with inline formatting and paragraph styles. Undo/redo tracks this binding's
edits; remote changes do not become local undo steps. Existing board history controls and
gesture grouping continue to work. A text editor connected to a shared history uses that
history for undo instead of restoring whole local text snapshots.

Changes stream while dragging. Camera, tools, previews and playback stay local. Cursors and
selections use Awareness and are excluded from the persistent board content. `onChange`
still works for application notifications; collaboration subscribes directly to the scene.
`elements.load` replaces shared content too, so use it only for an intentional shared reset.
For images and audio, supply `upload` with persistent URLs accessible to participants.

### Socket.IO transport

`Board` connects using a plain `collaboration` configuration object. Install its optional peers:

```sh
npm install apeiro yjs y-protocols socket.io-client
```

```tsx
import { Board } from 'apeiro/react';
import 'apeiro/styles.css';

export function SharedBoard({ roomId }: { roomId: string }) {
  return (
    <Board
      style={{ height: '100vh' }}
      config={{ grid: 'dots', theme: 'system' }}
      collaboration={{
        url: 'http://localhost:3001',
        roomId,
        // document: doc, // optional application-owned Y.Doc
        user: { name: 'Alice', color: '#2563eb' },
        // socketOptions: { auth: { token: sessionToken } },
      }}
      fallback={<p>Syncing…</p>}
      errorFallback={(error) => <p>{String(error)}</p>}
    />
  );
}
```

A configuration with `url` and `roomId` selects Socket.IO. Its optional dependencies
load only when the board connects. A configuration with only `document`, `awareness`
and optional `whenSynced` uses your existing Yjs provider without opening a socket.

The adapter creates the socket, Awareness and (unless supplied) the Yjs document only
when the board connects. It waits for synchronization before mounting descendants and
cleans up on unmount, including StrictMode. No application effect or provider state is
needed. Application-owned `document` and `awareness` are never destroyed.

Use `BoardProvider` when toolbars or panels need board context outside the canvas.
For a single canvas, pass `config` and `collaboration` directly to `Board`.

On a Node server, install `apeiro yjs y-protocols socket.io` and attach the matching
protocol to your Socket.IO server:

```ts
import { Server } from 'socket.io';
import { attachSocketRooms } from 'apeiro/socket.io/server';

const io = new Server(3001, { cors: { origin: 'http://localhost:5173' } });
const rooms = attachSocketRooms(io);

// During application shutdown:
// rooms.destroy();
// await io.close();
```

The adapter exchanges document updates and Awareness and resynchronizes offline edits
after Socket.IO reconnects. Disconnecting releases selection reservations; reconnecting
starts with a fresh selection. Transient connection errors retry; rejected room access
renders `errorFallback`.

`collaboration` accepts `url`, `roomId`, optional `document` / `awareness`, `socketOptions`
(auth, path, transports and other Socket.IO options), `syncTimeout` (default 10000 ms),
`user`, `name`, `showPresence`, `initialElements` and `onError`.
Optional `onStatusChange(status, error)` supports connection UI. Equivalent inline
socket configuration does not reconnect or reset undo history. User and presence settings
update live; changing the URL, room, document, Awareness, collection name, timeout or socket
configuration replaces the connection. Keep function-valued socket options stable when
passing configuration inline.

The server keeps rooms in memory until `rooms.destroy()`. Supply `authorize(socket, roomId)`
to check access before reading or changing a room; return `false` to reject access.
Use `load(roomId)` to restore a persisted Yjs snapshot and `onUpdate(roomId, update)` to
persist incremental updates. Awaiting `load` delays initial sync for all joining clients;
persistence errors are sent to `onError`. Without these hooks, rooms are open and content
lasts for the lifetime of this server. Use one server process per room: a Socket.IO Redis
adapter alone does not replicate the in-memory Yjs documents between processes.

Try the real network playground with two terminals:

```sh
pnpm --filter apeiro build
pnpm --filter @apeiro/playground dev:collaboration
```

```sh
pnpm dev
```

Open `http://localhost:5173/collaboration.html?room=demo` in multiple tabs. Vite proxies
Socket.IO to port 3001. Each page shows two independent clients and connection status.

## Data model

A board is an array of `BoardElement`: shapes (`rect`, `ellipse`, `polygon`, `sticky`,
`text`, `image`, `audio`, `ink`) and connectors. Elements have an ID, position, dimensions,
rotation and paint order (`z`). Colors use `0xRRGGBBAA`; `hexColor('#ff0000')` and `rgba`
are exported from `apeiro`. The public TypeScript types describe each element's fields.

## Styling

CSS custom properties on `.ap-board`: `--ap-accent`, `--ap-surface`, `--ap-foreground`,
`--ap-border`, `--ap-muted`, `--ap-font`, `--ap-radius-sm`, `--ap-radius-md`, `--ap-shadow`.

## Fonts

Board text can use Geist (the default), Inter, PT Serif, JetBrains Mono and Caveat
(`FONT_FAMILIES`); offer them in your own text toolbar. Load the font files yourself
(`@font-face`, e.g. from Google Fonts), otherwise the system fallbacks are drawn.
`--ap-font` is the font of the board's own UI, not of its text.

## Development

This repository uses Node.js 22 and pnpm. Install dependencies with `pnpm install`, then
run `pnpm dev` for the playground. Use `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
and `pnpm build` to check the workspace. The package build copies this README into
`packages/engine` for publication.
