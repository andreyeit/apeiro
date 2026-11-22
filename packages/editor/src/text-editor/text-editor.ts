import {
  applyStyle,
  clampFontSize,
  commonStyle,
  cssColor,
  defaultTextBlock,
  fitTextPatch,
  fontFamily,
  hasStyle,
  indentList,
  isAllowedLink,
  isShape,
  LINE_HEIGHT,
  linkAt,
  LIST_GAP_EM,
  MIXED,
  normalizeLink,
  paragraphAt,
  paragraphRange,
  paragraphStyle,
  plainText,
  remapParagraphs,
  replaceBlockText,
  replaceText,
  runsLength,
  stepFontSize,
  stepTextSize,
  textArea,
  toggleList,
  toggleStyle,
  updateParagraphs,
  withFont,
  withFontSize,
  withParagraphs,
  type BoardElement,
  type BooleanStyle,
  type Camera,
  type ListKind,
  type Scene,
  type ShapeElement,
  type TextAlign,
  type TextBlock,
  type TextRun,
  type TextStyle,
  type UndoHistory,
} from '@apeiro/core';
import type { BoardRenderer } from '@apeiro/renderer';
import { keyLetter } from '../input/keyboard';
import { offsetOf, parse, positionOf, render } from './dom';

const JUSTIFY = { top: 'flex-start', middle: 'center', bottom: 'flex-end' } as const;

/** Text and selection to return to on undo/redo. */
interface Snapshot {
  block: TextBlock;
  from: number;
  to: number;
}
const MAX_UNDO = 200;

/** Typed at the start of a line, these turn it into a list item (like Notion and Miro). */
const LIST_SHORTCUTS: Array<[RegExp, ListKind]> = [
  [/^[-*•] $/, 'bullet'],
  [/^1[.)] $/, 'ordered'],
];

/**
 * Maps offsets in `before` to offsets in `after`, assuming one contiguous change between
 * them (what one remote edit looks like): offsets before the change stay, offsets after it
 * shift by the change in length, offsets inside it move to the end of the new text.
 */
export function offsetMapper(before: string, after: string): (offset: number) => number {
  const maximum = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < maximum && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < maximum - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  )
    suffix++;
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  return (offset) => {
    if (offset <= prefix) return offset;
    if (offset >= oldEnd) return offset + after.length - before.length;
    return newEnd;
  };
}

/** A formatting change for `BoardEditor.formatText`, applied to the text being edited. */
export type TextFormatCommand =
  /** Bold, italic, underline or strikethrough on/off (with a caret: for what is typed next). */
  | { type: 'toggle'; style: BooleanStyle }
  /** Text color (with a caret: for what is typed next). */
  | { type: 'color'; color: number }
  /** Font family id (see `FONT_FAMILIES`): of the selection, or of the whole text. */
  | { type: 'font'; font: string }
  /**
   * Font size as shown (after autoFit): of the selection, or of the whole text. `auto`: the
   * text grows or shrinks to fill its box, as the default size of stickies in Miro; a number
   * switches that off.
   */
  | { type: 'fontSize'; size: number | 'auto' }
  /** One step bigger or smaller, like Ctrl+Shift+> / <. */
  | { type: 'stepSize'; direction: 1 | -1 }
  /** Bulleted or numbered list on/off for the selected paragraphs. */
  | { type: 'list'; kind: ListKind }
  /** Indents (1) or outdents (-1) the selected list items, like Tab / Shift+Tab. */
  | { type: 'indent'; direction: 1 | -1 }
  | { type: 'align'; align: TextAlign }
  /**
   * Links the selection (or the link around the caret) to `href`; null removes the link.
   * With a caret outside a link, inserts the address as linked text.
   */
  | { type: 'link'; href: string | null };

/**
 * Formatting at the selection of the text being edited, for the app's own controls.
 * `null` where the selection mixes values.
 */
export interface TextFormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** Font family id. */
  font: string | null;
  /** Font size as shown (after autoFit), rounded to 0.1. */
  fontSize: number | null;
  /** The size is automatic (`fontSize: 'auto'`): it follows the box. */
  autoSize: boolean;
  /** Text color (RGBA); `null` when the selection mixes colors. */
  color: number | null;
  align: TextAlign;
  /** List kind shared by all selected paragraphs, or null. */
  list: ListKind | null;
  /** Address of the link at the caret, or shared by the whole selection. */
  link: string | null;
}

/**
 * Marks the app's formatting controls (`<div data-ap-text-controls>`): pressing or focusing
 * something inside keeps the text editor open. Buttons should also prevent `mousedown`'s
 * default so the text keeps its selection; fields may take the focus (the selection is
 * remembered and formatting applies to it).
 */
export const TEXT_CONTROLS_ATTRIBUTE = 'data-ap-text-controls';

function isTextControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(`[${TEXT_CONTROLS_ATTRIBUTE}]`);
}

function sameFormat(first: TextFormatState | null, second: TextFormatState | null): boolean {
  if (first === second) return true;
  if (!first || !second) return false;
  for (const key of Object.keys(first) as Array<keyof TextFormatState>)
    if (first[key] !== second[key]) return false;
  return true;
}

/** Opens a link from text in a new tab, never giving the page a handle on the opener. */
export function openLink(href: string): void {
  if (isAllowedLink(href)) window.open(href, '_blank', 'noopener,noreferrer');
}

/** Ctrl/⌘ + letter (by physical key) toggles a style: Shift+X strikes through. */
const STYLE_SHORTCUTS: Readonly<Record<string, BooleanStyle>> = {
  B: 'bold',
  I: 'italic',
  U: 'underline',
};

/**
 * Rich text editor laid exactly over an element. Every change is written to the scene,
 * so other views (and later other users) see it live. While it is open, the editor shows
 * the text and the board hides its own: the caret and the selection are where the browser
 * drew the letters, whatever the browser's or the board's zoom, so they never drift off them
 * (the browser's text layout can differ from the board's by fractions of a pixel).
 *
 * Per-character: bold/italic/underline/strike (Ctrl+B/I/U, Ctrl+Shift+X), color, font
 * family, size and links (Ctrl+K). Per paragraph: bulleted and numbered lists
 * (Ctrl+Shift+8/7, or "- " / "1. " at the start of a line), nested with Tab / Shift+Tab.
 * Size and font apply to the selection, or to the whole text when nothing is selected.
 * With a collapsed caret, a toggled style applies to what is typed next.
 *
 * There is no built-in formatting UI: the app shows its own controls (marked with
 * `TEXT_CONTROLS_ATTRIBUTE`), reads `format` and changes it with `apply`.
 */
export class TextEditor {
  private root = document.createElement('div');
  private input = document.createElement('div');
  /** Last caret/selection inside the text, to restore after an app control took focus. */
  private lastSelection: [number, number] | null = null;
  private formatState: TextFormatState | null = null;
  /** Called when editing of element `id` begins (e.g. to hide the selection handles). */
  onStart: (id: string) => void = () => undefined;
  /** Called when editing ends, with the element id (null if it was removed for being empty). */
  onStop: (id: string | null) => void = () => undefined;
  /** `format` changed (selection moved, text restyled, editing started or ended). */
  onFormat: () => void = () => undefined;
  private id: string | null = null;
  private block: TextBlock | null = null;
  private pending: TextStyle | null = null;
  private inputStart = 0;
  private composing = false;
  /**
   * Undo/redo of this editing session. The DOM is re-rendered on every change, so the
   * browser's own undo stack is useless here; Ctrl+Z goes through these instead.
   */
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastTypingAt = 0;
  /** Selection when the current input began (before the browser changed the DOM). */
  private beforeSelection: [number, number] = [0, 0];
  private disposers: Array<() => void> = [];

  constructor(
    container: HTMLElement,
    private scene: Scene,
    private camera: Camera,
    private renderer: BoardRenderer,
    /**
     * Board undo history: one editing session (open → close) becomes one step there.
     * Inside the session Ctrl+Z is handled by the editor's own finer-grained undo.
     */
    private history?: Pick<UndoHistory, 'beginGroup' | 'endGroup'>,
  ) {
    this.root.className = 'ap-text-editor';
    this.input.className = 'ap-text-editor-input';
    try {
      this.input.contentEditable = 'plaintext-only';
    } catch {
      this.input.contentEditable = 'true';
    }
    this.input.spellcheck = false;
    this.root.append(this.input);
    this.root.hidden = true;
    container.append(this.root);

    this.input.addEventListener('beforeinput', (event) => this.onBeforeInput(event));
    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
      this.onInput();
    });
    this.input.addEventListener('blur', (event) => {
      if (!isTextControl(event.relatedTarget)) this.stop();
    });
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event));
    // Ctrl/Cmd+click opens a link (a plain click places the caret, as in any editor).
    this.input.addEventListener('click', (event) => {
      const href = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-href]')
        ?.dataset.href;
      if (href && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        openLink(href);
      }
    });
    const onSelectionChange = () => {
      const selection = getSelection();
      if (
        this.id &&
        selection &&
        selection.rangeCount > 0 &&
        this.input.contains(selection.anchorNode)
      )
        this.lastSelection = this.selection();
      this.syncFormat();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    // A press anywhere else closes the editor before the board handles it (capture phase,
    // ahead of blur), so the text edit and the next gesture are separate undo steps.
    const onOutsidePointer = (event: Event) => {
      const target = event.target as Node | null;
      if (this.id && !this.root.contains(target) && !isTextControl(target)) this.stop();
    };
    window.addEventListener('pointerdown', onOutsidePointer, true);
    this.disposers.push(() => window.removeEventListener('pointerdown', onOutsidePointer, true));
    this.root.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.disposers.push(
      () => document.removeEventListener('selectionchange', onSelectionChange),
      renderer.onAfterRender(() => this.sync()),
      scene.subscribe((changes) => this.onSceneChanges(changes.updated)),
    );
  }

  /** Removes the editor from the page and stops listening to the document and the scene. */
  destroy(): void {
    this.stop();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.root.remove();
  }

  /**
   * The edited element's text changed from elsewhere (another view, later another user):
   * show that instead of overwriting it with the next keystroke.
   */
  private onSceneChanges(updated: readonly BoardElement[]): void {
    if (!this.id || !this.block || this.composing) return;
    const element = updated.find((candidate) => candidate.id === this.id);
    if (!element || !isShape(element) || !element.text || element.text === this.block) return;
    const [from, to] = this.selection();
    // Someone else typed: keep the caret on the same characters, not the same offset.
    const mapOffset = offsetMapper(plainText(this.block), plainText(element.text));
    this.block = element.text;
    this.undoStack = [];
    this.redoStack = [];
    this.render(this.input, this.block);
    const length = runsLength(this.block.runs);
    this.select(Math.min(mapOffset(from), length), Math.min(mapOffset(to), length));
    this.sync();
  }

  get editing(): string | null {
    return this.id;
  }

  /**
   * Adds a new element and opens it for typing, as one undo step with the typing: closing
   * it while still empty removes it again, leaving no trace in the history (Figma, Miro).
   */
  create(element: ShapeElement): void {
    this.stop();
    this.history?.beginGroup();
    try {
      this.scene.add(element);
      this.start(element.id);
    } finally {
      this.history?.endGroup(); // the step stays open until `stop` (start nests a group)
    }
  }

  start(id: string): void {
    const element = this.scene.get(id);
    if (!element || !isShape(element)) return;
    this.stop();
    this.history?.beginGroup();
    this.id = id;
    const block = element.text ?? defaultTextBlock(element.type);
    // The editor only writes '\n' line breaks; '\r\n' from elsewhere becomes one.
    this.block = block.runs.some((run) => run.text.includes('\r'))
      ? {
          ...block,
          runs: block.runs.map((run) => ({ ...run, text: run.text.replace(/\r\n?/g, '\n') })),
        }
      : block;
    this.lastSelection = null;
    this.pending = null;
    this.undoStack = [];
    this.redoStack = [];
    this.lastTypingAt = 0;
    this.render(this.input, this.block);
    this.renderer.setTextHidden(id, true);
    this.root.hidden = false;
    this.sync();
    this.input.focus();
    const end = runsLength(this.block.runs);
    this.select(end, end);
    this.onStart(id);
    this.syncFormat();
  }

  stop(): void {
    if (!this.id) return;
    const id = this.id;
    this.renderer.setTextHidden(id, false);
    this.id = null;
    // A hidden editor must not keep the focus: keys would go to it, not to the board.
    if (this.input.contains(document.activeElement)) this.input.blur();
    this.block = null;
    this.root.hidden = true;
    // An empty text box has nothing to show: it goes away (shapes keep their box).
    const element = this.scene.get(id);
    const removed =
      !!element && element.type === 'text' && (!element.text || plainText(element.text) === '');
    if (removed) this.scene.remove(id);
    this.history?.endGroup();
    this.onStop(removed || !element ? null : id);
    this.syncFormat();
  }

  /**
   * Renders `block` into `root` in the colors the board draws the edited element's text with.
   */
  private render(root: HTMLElement, block: TextBlock): void {
    const type = this.id ? this.scene.get(this.id)?.type : undefined;
    render(root, block, (color) => (type ? this.renderer.drawnColor(type, color) : color));
  }

  /**
   * Shows the text in the board's current colors again, after its color theme changed (the
   * caret and selection stay).
   */
  restyle(): void {
    if (!this.id || !this.block || this.composing) return;
    const [from, to] = this.selection();
    this.render(this.input, this.block);
    this.select(from, to);
    this.sync();
  }

  /** Positions the editor over the element; called after every frame. */
  sync(): void {
    if (!this.id || !this.block) return;
    const element = this.scene.get(this.id);
    if (!element || !isShape(element)) {
      this.stop();
      return;
    }
    const zoom = this.camera.zoom;
    const center = this.camera.worldToScreen({
      x: element.x + element.width / 2,
      y: element.y + element.height / 2,
    });
    const area = textArea(element);
    const layout = this.renderer.textLayout(element);
    const scale = layout?.scale ?? 1;
    const style = this.root.style;
    style.width = `${element.width}px`;
    style.height = `${element.height}px`;
    style.transform = `translate(${center.x}px, ${center.y}px) scale(${zoom}) rotate(${element.rotation}rad) translate(-50%, -50%)`;
    style.padding = `${area.minY}px ${element.width - area.maxX}px ${element.height - area.maxY}px ${area.minX}px`;
    style.justifyContent = JUSTIFY[this.block.verticalAlign];
    const inputStyle = this.input.style;
    inputStyle.fontFamily = fontFamily(this.block.font).css;
    inputStyle.fontSize = `${this.block.fontSize * scale}px`;
    inputStyle.setProperty('--k', String(scale));
    inputStyle.setProperty('--gap', `${LIST_GAP_EM * this.block.fontSize * scale}px`);
    inputStyle.lineHeight = String(LINE_HEIGHT);
    inputStyle.textAlign = this.block.align;
    // As drawn on the board: a dark theme may show the stored color differently. The caret
    // takes the text's color.
    inputStyle.color = cssColor(this.renderer.drawnColor(element.type, this.block.color));
    inputStyle.caretColor = inputStyle.color;
    // Auto-width text never wraps; the box grows with it instead.
    inputStyle.whiteSpace =
      element.type === 'text' && this.block.sizing === 'auto-width' ? 'pre' : '';
    this.syncFormat(); // autoFit may have changed the shown size
  }

  private onKeyDown(event: KeyboardEvent): void {
    event.stopPropagation(); // board shortcuts (Delete, Ctrl+A) must not fire while typing
    if (event.key === 'Escape') {
      this.input.blur();
      return;
    }
    if (event.key === 'Tab') {
      // Nest list items; elsewhere Tab must not move focus out of the text.
      event.preventDefault();
      this.indentAtSelection(event.shiftKey ? -1 : 1);
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.shiftKey && (event.code === 'Period' || event.code === 'Comma')) {
      event.preventDefault();
      this.stepSize(event.code === 'Period' ? 1 : -1);
      return;
    }
    if (event.shiftKey && (event.code === 'Digit7' || event.code === 'Digit8')) {
      event.preventDefault();
      this.toggleListAtSelection(event.code === 'Digit7' ? 'ordered' : 'bullet');
      return;
    }
    // By physical key, like the board's shortcuts: they work with any keyboard layout.
    const letter = keyLetter(event);
    if (letter === 'Z' || letter === 'Y') {
      event.preventDefault();
      if (letter === 'Y' || event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    const toggle = event.shiftKey
      ? letter === 'X'
        ? 'strike'
        : undefined
      : STYLE_SHORTCUTS[letter];
    if (toggle) {
      event.preventDefault();
      this.toggle(toggle);
    }
  }

  private onBeforeInput(event: InputEvent): void {
    const [from, to] = this.selection();
    this.inputStart = from;
    this.beforeSelection = [from, to];
    if (!this.block) return;
    const runs = this.block.runs;
    const paragraph = paragraphAt(runs, from);
    const style = paragraphStyle(this.block, paragraph);
    const atLineStart = from === to && (from === 0 || plainText(this.block)[from - 1] === '\n');
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      // Insert a plain '\n' ourselves: browsers otherwise disagree on <div>/<br>.
      event.preventDefault();
      const lineEmpty = atLineStart && (plainText(this.block)[from] ?? '\n') === '\n';
      if (style.list && lineEmpty) {
        // Enter on an empty item leaves the list (one level up first), like word processors.
        this.write(
          updateParagraphs(this.block, paragraph, paragraph, (style) =>
            style.indent ? { ...style, indent: style.indent - 1 } : {},
          ),
          from,
          to,
        );
        return;
      }
      this.replace(from, to, '\n');
    } else if (event.inputType === 'deleteContentBackward' && style.list && atLineStart) {
      // Backspace at the start of an item turns it back into a plain line first.
      event.preventDefault();
      this.write(
        updateParagraphs(this.block, paragraph, paragraph, () => ({})),
        from,
        to,
      );
    } else if (
      event.inputType.startsWith('delete') &&
      this.deleteAtEdges(event.inputType, from, to)
    ) {
      event.preventDefault();
    } else if (event.inputType.startsWith('format')) {
      event.preventDefault(); // formatting goes through our model only
    } else if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault(); // menu/gesture undo: ours, not the browser's (it doesn't know our DOM)
      if (event.inputType === 'historyUndo') this.undo();
      else this.redo();
    }
  }

  /**
   * Deletions the browser gets wrong in our DOM, done on the model instead: a selection,
   * and anything that crosses a line break or the ends of the text (browsers then remove or
   * merge our paragraph blocks and leave filler `<br>`s, e.g. Backspace in an empty text
   * would come back as a new line). Inside a line the browser deletes (grapheme clusters,
   * words). Returns true when handled.
   */
  private deleteAtEdges(inputType: string, from: number, to: number): boolean {
    if (!this.block) return false;
    if (from !== to) {
      this.replace(from, to, '');
      return true;
    }
    const text = plainText(this.block);
    const backward = inputType.endsWith('Backward');
    if (backward) {
      if (from === 0) return true; // nothing before the caret
      if (text[from - 1] !== '\n') return false;
      this.replace(from - 1, from, ''); // joins the line with the previous one
      return true;
    }
    if (from >= text.length) return true; // nothing after the caret
    if (text[from] !== '\n') return false;
    this.replace(from, from + 1, ''); // joins the next line to this one
    return true;
  }

  undo(): void {
    this.travel(this.undoStack, this.redoStack);
  }

  redo(): void {
    this.travel(this.redoStack, this.undoStack);
  }

  private travel(from: Snapshot[], to: Snapshot[]): void {
    const target = from.pop();
    if (!target || !this.block) return;
    const [selectionFrom, selectionTo] = this.selection();
    to.push({ block: this.block, from: selectionFrom, to: selectionTo });
    this.lastTypingAt = 0; // the next keystroke starts a new undo step
    this.write(target.block, target.from, target.to, 'none');
  }

  /** Remembers the state before a change. Consecutive typing within a second is one step. */
  private record(kind: 'typing' | 'other'): void {
    if (!this.block) return;
    const now = performance.now();
    const merge = kind === 'typing' && now - this.lastTypingAt < 1000;
    this.lastTypingAt = kind === 'typing' ? now : 0;
    this.redoStack = [];
    if (merge) return;
    // For typing the DOM (and caret) already changed: use the selection from before it.
    const [from, to] = kind === 'typing' ? this.beforeSelection : this.selection();
    this.undoStack.push({ block: this.block, from, to });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  private onInput(): void {
    if (!this.block || this.composing) return;
    const caret = this.selection()[1];
    const parsed = parse(this.input);
    let runs = parsed.runs;
    let paragraphs = parsed.paragraphs;
    if (this.pending && caret > this.inputStart) {
      runs = applyStyle(runs, this.inputStart, caret, this.pending);
    }
    this.pending = null;
    let block = withParagraphs({ ...this.block, runs }, paragraphs);
    let at = caret;
    // "- " or "1. " typed at the start of a plain line: make it a list item.
    const text = plainText(block);
    const paragraph = paragraphAt(runs, caret);
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    const typed = text.slice(lineStart, caret);
    const shortcut = LIST_SHORTCUTS.find(([pattern]) => pattern.test(typed));
    if (shortcut && !paragraphStyle(block, paragraph).list) {
      // First record the plain typing, so Ctrl+Z brings the "- " back.
      this.write(block, caret, caret, 'typing');
      runs = replaceText(runs, lineStart, caret, '');
      paragraphs = remapParagraphs(block.runs, block.paragraphs, lineStart, caret, '');
      block = withParagraphs({ ...block, runs }, paragraphs);
      block = updateParagraphs(block, paragraph, paragraph, (style) => ({
        ...style,
        list: shortcut[1],
      }));
      at = lineStart;
      this.write(block, at, at, 'other');
      return;
    }
    this.write(block, at, at, 'typing', true);
  }

  private replace(from: number, to: number, text: string): void {
    if (!this.block) return;
    const caret = from + text.length;
    this.write(replaceBlockText(this.block, from, to, text, this.pending), caret, caret);
  }

  // --- Formatting from the app --------------------------------------------------------

  /**
   * Formatting at the selection (the remembered one while an app control has the focus);
   * null when nothing is edited. Same object until it changes (`onFormat`).
   */
  get format(): TextFormatState | null {
    return this.formatState;
  }

  /**
   * Applies a formatting change to the text being edited and returns the focus to it.
   * False when nothing is edited, or for a link whose address is not allowed.
   */
  apply(command: TextFormatCommand): boolean {
    if (!this.id || !this.block) return false;
    let applied = true;
    switch (command.type) {
      case 'toggle':
        this.toggle(command.style);
        break;
      case 'color':
        this.setColor(command.color);
        break;
      case 'font':
        this.setFont(command.font);
        break;
      case 'fontSize':
        if (command.size === 'auto') this.setAutoSize();
        else this.setFontSize(command.size);
        break;
      case 'stepSize':
        this.stepSize(command.direction);
        break;
      case 'list':
        this.toggleListAtSelection(command.kind);
        break;
      case 'indent':
        this.indentAtSelection(command.direction);
        break;
      case 'align':
        this.setBlock({ align: command.align });
        break;
      case 'link':
        applied = this.setLink(command.href);
        break;
    }
    this.refocus();
    this.syncFormat();
    return applied;
  }

  private computeFormat(): TextFormatState | null {
    const block = this.block;
    if (!this.id || !block) return null;
    const [from, to] = this.lastSelectionOrCurrent();
    const pending = from === to ? this.pending : null;
    const style = (key: BooleanStyle) => pending?.[key] ?? hasStyle(block.runs, from, to, key);
    const [first, last] = paragraphRange(block.runs, from, to);
    let list: ListKind | null = paragraphStyle(block, first).list ?? null;
    for (let i = first + 1; i <= last && list; i++)
      if (paragraphStyle(block, i).list !== list) list = null;
    const rangeLink = commonStyle(block.runs, from, to, 'link');
    const link =
      (from === to ? linkAt(block.runs, from)?.href : undefined) ??
      (typeof rangeLink === 'string' ? rangeLink : null);
    const font = commonStyle(block.runs, from, to, 'font');
    const size = this.sizeAtSelection();
    const color =
      pending && 'color' in pending ? pending.color : commonStyle(block.runs, from, to, 'color');
    return {
      bold: style('bold'),
      italic: style('italic'),
      underline: style('underline'),
      strike: style('strike'),
      font: font === MIXED ? null : fontFamily(font ?? block.font).id,
      fontSize: size === null ? null : Math.round(size * this.scale() * 10) / 10,
      color: color === MIXED ? null : (color ?? block.color),
      align: block.align,
      autoSize: !!(block.autoFit && block.autoGrow),
      list,
      link,
    };
  }

  private syncFormat(): void {
    const next = this.computeFormat();
    if (sameFormat(next, this.formatState)) return;
    this.formatState = next;
    this.onFormat();
  }

  private toggle(key: BooleanStyle): void {
    if (!this.block) return;
    const [from, to] = this.lastSelectionOrCurrent();
    if (from === to) {
      // No selection: affects what is typed next.
      const current = this.pending?.[key] ?? hasStyle(this.block.runs, from, to, key);
      this.pending = { ...this.pending, [key]: !current };
      this.syncFormat();
      return;
    }
    this.update(toggleStyle(this.block.runs, from, to, key), from, to);
  }

  private setColor(color: number): void {
    if (!this.block) return;
    const [from, to] = this.lastSelectionOrCurrent();
    const value = color === this.block.color ? undefined : color;
    if (from === to) {
      this.pending = { ...this.pending, color: value };
      return;
    }
    this.update(applyStyle(this.block.runs, from, to, { color: value }), from, to);
  }

  // --- Size and font: the selection, or the whole text ---------------------------

  /** Font size (before autoFit) at the selection; null when the selection mixes sizes. */
  private sizeAtSelection(): number | null {
    if (!this.block) return null;
    const [from, to] = this.lastSelectionOrCurrent();
    const size = commonStyle(this.block.runs, from, to, 'size');
    return size === MIXED ? null : (size ?? this.block.fontSize);
  }

  /**
   * The text with its automatic size switched off, as choosing a size does in Miro: every
   * size becomes the one shown now, so nothing jumps. And the scale it is shown at then.
   */
  private withFixedSize(block: TextBlock): { block: TextBlock; scale: number } {
    const scale = this.scale();
    if (!block.autoGrow) return { block, scale };
    const fixed: TextBlock = {
      ...block,
      fontSize: clampFontSize(block.fontSize * scale),
      runs: block.runs.map((run) =>
        run.size === undefined ? run : { ...run, size: clampFontSize(run.size * scale) },
      ),
    };
    delete fixed.autoGrow;
    return { block: fixed, scale: 1 };
  }

  /** Back to the automatic size: the text grows or shrinks to fill its box. */
  private setAutoSize(): void {
    if (!this.block || this.block.autoGrow) return;
    const [from, to] = this.lastSelectionOrCurrent();
    this.write({ ...this.block, autoFit: true, autoGrow: true }, from, to);
    this.refocus();
  }

  private setFontSize(size: number): void {
    if (!this.block) return;
    const { block, scale } = this.withFixedSize(this.block);
    const fontSize = clampFontSize(size / scale);
    const [from, to] = this.lastSelectionOrCurrent();
    if (from === to) {
      // The whole text gets this size.
      this.write(withFontSize(block, fontSize), from, to);
    } else {
      const value = fontSize === block.fontSize ? undefined : fontSize;
      this.write({ ...block, runs: applyStyle(block.runs, from, to, { size: value }) }, from, to);
    }
    this.refocus();
  }

  private stepSize(direction: 1 | -1): void {
    if (!this.block) return;
    const [from, to] = this.lastSelectionOrCurrent();
    if (from !== to) {
      // From the size actually shown: an auto-fitted sticky may be smaller than its maximum.
      const shown = (this.sizeAtSelection() ?? this.block.fontSize) * this.scale();
      this.setFontSize(stepFontSize(shown, direction));
      return;
    }
    // Whole text: every size steps by the same ratio, so headings stay bigger.
    const { block, scale } = this.withFixedSize(this.block);
    this.write(stepTextSize(block, direction, scale), from, to);
    this.refocus();
  }

  private setFont(id: string): void {
    if (!this.block) return;
    const [from, to] = this.lastSelectionOrCurrent();
    if (from === to) {
      this.write(withFont(this.block, id), from, to);
    } else {
      const value = fontFamily(id).id === fontFamily(this.block.font).id ? undefined : id;
      this.write(
        { ...this.block, runs: applyStyle(this.block.runs, from, to, { font: value }) },
        from,
        to,
      );
    }
    this.refocus();
  }

  /** autoFit factor the text is shown at (sizes in the model are before it). */
  private scale(): number {
    const element = this.id ? this.scene.get(this.id) : undefined;
    return element && isShape(element) ? (this.renderer.textLayout(element)?.scale ?? 1) : 1;
  }

  // --- Lists -----------------------------------------------------------------------

  private toggleListAtSelection(kind: ListKind): void {
    if (!this.block) return;
    const [from, to] = this.lastSelectionOrCurrent();
    const [first, last] = paragraphRange(this.block.runs, from, to);
    this.write(toggleList(this.block, first, last, kind), from, to);
    this.refocus();
  }

  private indentAtSelection(direction: 1 | -1): void {
    if (!this.block) return;
    const [from, to] = this.selection();
    const [first, last] = paragraphRange(this.block.runs, from, to);
    const next = indentList(this.block, first, last, direction);
    if (next.paragraphs !== this.block.paragraphs) this.write(next, from, to);
  }

  // --- Links -----------------------------------------------------------------------

  /**
   * Links the selection, or the link around the caret, to `address` (null or empty removes
   * the link). With a caret outside a link the address itself is inserted as linked text.
   * False if the address is not an allowed link.
   */
  private setLink(address: string | null): boolean {
    if (!this.block) return false;
    const [selectionFrom, selectionTo] = this.lastSelectionOrCurrent();
    const around = selectionFrom === selectionTo ? linkAt(this.block.runs, selectionFrom) : null;
    const [from, to] = around ? [around.from, around.to] : [selectionFrom, selectionTo];
    const raw = address?.trim() ?? '';
    const href = raw === '' ? undefined : normalizeLink(raw);
    if (href === null) return false;
    if (from === to) {
      if (href) {
        const caret = from + raw.length;
        this.write(replaceBlockText(this.block, from, to, raw, { link: href }), caret, caret);
      }
    } else {
      this.write(
        { ...this.block, runs: applyStyle(this.block.runs, from, to, { link: href }) },
        to,
        to,
      );
    }
    this.refocus();
    return true;
  }

  // --- Writing ---------------------------------------------------------------------

  /** Changes block-level attributes (size, alignment) of the whole text. */
  private setBlock(patch: Partial<TextBlock>): void {
    if (!this.block) return;
    const [from, to] = this.lastSelectionOrCurrent();
    this.write({ ...this.block, ...patch }, from, to);
    this.refocus();
  }

  private update(
    runs: TextRun[],
    selectionFrom: number,
    selectionTo: number,
    history: 'typing' | 'other' | 'none' = 'other',
  ): void {
    if (!this.block) return;
    this.write({ ...this.block, runs }, selectionFrom, selectionTo, history);
  }

  /**
   * Writes a whole block: to the scene (an auto-sized text box is refitted in the same
   * update), to the DOM, and restores the selection.
   */
  private write(
    block: TextBlock,
    selectionFrom: number,
    selectionTo: number,
    history: 'typing' | 'other' | 'none' = 'other',
    /**
     * The browser has just typed into the DOM itself. When that DOM is already what the block
     * renders to, it stays as it is, caret included: rebuilding it on every keystroke loses
     * the caret's side at a soft line break (it jumps between lines) and the browser's own
     * state of the field.
     */
    typedByBrowser = false,
  ): void {
    if (!this.id || !this.block) return;
    const element = this.scene.get(this.id);
    if (!element || !isShape(element)) return;
    if (history !== 'none') this.record(history);
    this.block = block;
    const rendered = document.createElement('div');
    this.render(rendered, block);
    if (!typedByBrowser || rendered.innerHTML !== this.input.innerHTML) {
      this.input.replaceChildren(...rendered.childNodes);
      this.select(selectionFrom, selectionTo);
    }
    this.lastSelection = [selectionFrom, selectionTo];
    this.scene.update(this.id, {
      text: block,
      ...fitTextPatch(element, this.renderer.measurer, block),
    });
    this.sync(); // autoFit may have changed the font size; syncs `format` too
  }

  /** Back to typing after an app control took the focus, with the selection it had. */
  private refocus(): void {
    if (!this.id || document.activeElement === this.input) return;
    const [from, to] = this.lastSelectionOrCurrent();
    this.input.focus();
    this.select(from, to);
  }

  private lastSelectionOrCurrent(): [number, number] {
    const selection = getSelection();
    if (selection && selection.rangeCount > 0 && this.input.contains(selection.anchorNode))
      return this.selection();
    return this.lastSelection ?? this.selection();
  }

  private selection(): [number, number] {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0 || !this.input.contains(selection.anchorNode)) {
      if (this.lastSelection) return this.lastSelection;
      const end = this.block ? runsLength(this.block.runs) : 0;
      return [end, end];
    }
    const range = selection.getRangeAt(0);
    const startOffset = offsetOf(this.input, range.startContainer, range.startOffset);
    const endOffset = offsetOf(this.input, range.endContainer, range.endOffset);
    return [Math.min(startOffset, endOffset), Math.max(startOffset, endOffset)];
  }

  private select(from: number, to: number): void {
    const selection = getSelection();
    if (!selection) return;
    const start = positionOf(this.input, from);
    const end = positionOf(this.input, to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}
