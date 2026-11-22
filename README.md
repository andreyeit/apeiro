# Apeiro

An infinite canvas whiteboard for the web on WebGPU/WebGL2: sticky notes, shapes,
connectors, text, pen, images, undo/redo, with React bindings. Drawing and editing only: storing and sharing
boards is up to you (`onChange` gives every change).

## Install

```sh
npm install apeiro
```

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

Your own toolbar and saving:

```tsx
'use client';
import { Board, useBoard, useHistory, useTool } from 'apeiro/react';

export function Whiteboard({ saved }) {
  return (
    <Board style={{ height: '100vh' }} config={{ initialElements: saved, onChange: save }}>
      <Toolbar />
    </Board>
  );
}

function Toolbar() {
  const board = useBoard();
  const [tool, setTool] = useTool();
  const { canUndo } = useHistory();
  return (
    <div style={{ position: 'absolute', left: 12, top: 12 }}>
      <button aria-pressed={tool === 'sticky'} onClick={() => setTool('sticky')}>
        Sticky
      </button>
      <button disabled={!canUndo} onClick={board.history.undo}>
        Undo
      </button>
    </div>
  );
}
```

Children of `<Board>` are drawn over the canvas.

## Components

- `<Board>` — the canvas.
- `<BoardProvider>` — for UI outside the canvas:

```tsx
<BoardProvider config={{ initialElements: saved, onChange: save }}>
  <Sidebar />
  <Board style={{ flex: 1 }} />
</BoardProvider>
```

The board is configured by one object, `config` (`<Board>` or `<BoardProvider>`). Define
it once with `boardOptions` (typed, like `queryOptions` of TanStack Query) and reuse or
extend it:

```tsx
// board-config.ts
import { boardOptions } from 'apeiro/react';

export const boardConfig = boardOptions({
  theme: 'system',
  grid: 'dots',
  onChange: (elements) => save(elements),
});

// page.tsx
<Board config={boardConfig} style={{ height: '100vh' }} />
<Board config={{ ...boardConfig, readOnly: true }} />
```

`theme`, `readOnly` and the callbacks can change at any time; the other options are read
once, when the board is created (give the component a new `key` to start over).

| Option            | Default         |                                   |
| ----------------- | --------------- | --------------------------------- |
| `initialElements` |                 | Initial content                   |
| `onChange`        |                 | `(elements, changes) => void`     |
| `theme`           | `'light'`       | `'light'`, `'dark'`, `'system'`   |
| `readOnly`        | `false`         | View only                         |
| `onError`         | `console.error` | No WebGPU/WebGL2, or a file error |
| `grid`            | `'lines'`       | `'lines'`, `'dots'`, `'none'`     |
| `upload`          | object URLs     | `(file) => Promise<url>`          |

## Commands

`useBoard()`:

| Group       | Commands                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------- |
| `tools`     | `activate(tool, { repeat })`, `setDefaults(kind, style)`, `register(name, customTool)`        |
| `selection` | `set`, `clear`, `all`, `update(patch)`, `delete`, `reorder('front')`, `group`, `ungroup`      |
| `elements`  | `create(kind, { at })`, `createText`, `add`, `addFiles`, `update`, `remove`, `load`, `getAll` |
| `text`      | `edit(id)`, `stop()`, `format(command)`                                                       |
| `history`   | `undo`, `redo`, `batch(fn)`                                                                   |
| `camera`    | `zoomTo('in' \| 'out' \| 'fit' \| 'selection' \| 'reset' \| zoom)`                            |
| `clipboard` | `copy`, `cut`, `paste`, `duplicate`                                                           |
| `preview`   | `show(draft)`, `apply`, `discard`                                                             |
|             | `exportImage({ scale, ids, area })` → PNG `Blob`                                              |

## Hooks

| Hook                                                       | Returns                    |
| ---------------------------------------------------------- | -------------------------- |
| `useBoardState((board) => …)`                              | Any state                  |
| `useTool()`, `useBoardTheme()`                             | `[value, setValue]`        |
| `useSelectedIds()`, `useSelectedElements()`                | Selection                  |
| `useElement(id)`                                           | Content                    |
| `useHistory()`, `useClipboard()`, `usePreview()`           | State and actions          |
| `useZoom()`                                                | Zoom                       |
| `useSelectionScreenBounds()`, `useElementScreenBounds(id)` | Boxes on screen            |
| `useTextFormat()`                                          | Text being edited          |
| `useBoardChange(fn)`, `useBoardEvent(event, fn)`           | Callbacks, no re-rendering |
| `useEditor()`                                              | `BoardEditor`              |

## Text formatting

The board has no formatting toolbar: show your own while a text is edited. Put it inside
`data-ap-text-controls` so pressing it keeps the text open, and keep buttons from taking
the focus:

```tsx
function TextToolbar() {
  const format = useTextFormat();
  const board = useBoard();
  if (!format) return null;
  return (
    <div data-ap-text-controls onMouseDown={(event) => event.preventDefault()}>
      <button
        aria-pressed={format.bold}
        onClick={() => board.text.format({ type: 'toggle', style: 'bold' })}
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

```ts
import { BoardEditor } from 'apeiro';
import 'apeiro/styles.css';

const editor = new BoardEditor();
await editor.mount(document.getElementById('board')!);
editor.load(saved);
editor.on('selection', () => console.log(editor.selection));
// editor.getElements() to save, editor.destroy() to remove
```

## Data

A board is an array of `BoardElement`: shapes (`rect`, `ellipse`, `polygon`, `sticky`,
`text`, `image`, `audio`, `ink`) and `connector`. Fields: `x, y, width, height, rotation, z`;
colors are `0xRRGGBBAA` (`hexColor('#ff0000')`).

## Styling

CSS custom properties on `.ap-board`: `--ap-accent`, `--ap-surface`, `--ap-foreground`,
`--ap-border`, `--ap-muted`, `--ap-font`, `--ap-radius-sm`, `--ap-radius-md`, `--ap-shadow`.

## Fonts

Board text can use Geist (the default), Inter, PT Serif, JetBrains Mono and Caveat
(`FONT_FAMILIES`); offer them in your own text toolbar. Load the font files yourself
(`@font-face`, e.g. from Google Fonts), otherwise the system fallbacks are drawn.
`--ap-font` is the font of the board's own UI, not of its text.
