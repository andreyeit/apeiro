import {
  canHoldText,
  clipboardFromHtml,
  clipboardText,
  clipboardToHtml,
  type BoardClipboard,
  type Scene,
  type Vec2,
} from '@apeiro/core';
import { isTypingTarget } from '../input/keyboard';
import { activeBoard } from './active-board';

/** What the page listeners of a mounted board need from its editor. */
export interface BoardListenerHost {
  readonly scene: Scene;
  isReadOnly(): boolean;
  hasSelection(): boolean;
  /** This board copied something (`takeCopy`, `copy`). */
  hasCopy(): boolean;
  /** False once the board this mount belongs to is unmounted. */
  isCurrentMount(): boolean;
  clientToWorld(clientX: number, clientY: number): Vec2;
  /** Opens the text of a shape for typing right away. */
  startEditing(id: string): void;
  /** The pointer moved over the board (world point) or left it (null). */
  setPointer(world: Vec2 | null): void;
  /** A pointer gesture started or ended. */
  setInteracting(interacting: boolean): void;
  /** Copies the selection to the board's own clipboard only. */
  takeCopy(): BoardClipboard | null;
  copy(): void;
  cut(): void;
  deleteSelection(): void;
  duplicate(): void;
  paste(data?: BoardClipboard): void;
  pasteText(text: string): void;
  pasteFromClipboard(): Promise<unknown>;
  addFiles(files: File[], at?: Vec2): Promise<unknown>;
}

/**
 * The DOM listeners of a mounted board besides its pointer controls: double click to edit
 * text, the pointer position, files dropped on it, and the clipboard and keyboard shortcuts
 * (copy, cut, paste, duplicate) for the board in use on the page.
 */
export class BoardListeners {
  /** The pointer is over the board (shortcuts go to it before any board was pressed). */
  private inside = false;
  private disposers: Array<() => void> = [];

  constructor(
    stage: HTMLElement,
    /** The page-level owner of the board, as registered with `activeBoard`. */
    private readonly board: object,
    private readonly host: BoardListenerHost,
  ) {
    this.listenToStage(stage);
    this.listenToClipboard();
  }

  get pointerInside(): boolean {
    return this.inside;
  }

  dispose(): void {
    for (const dispose of this.disposers.reverse()) dispose();
    this.disposers = [];
  }

  private listen<K extends keyof WindowEventMap & keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void {
    target.addEventListener(type, listener as EventListener);
    this.disposers.push(() => target.removeEventListener(type, listener as EventListener));
  }

  private listenToStage(stage: HTMLElement): void {
    const host = this.host;
    // Double click on a shape edits its text (images, audio and pen strokes have none).
    this.listen(stage, 'dblclick', (event) => {
      const hit = host.scene.hitTest(host.clientToWorld(event.clientX, event.clientY));
      if (canHoldText(hit) && !host.isReadOnly()) host.startEditing(hit.id);
    });
    // Where the pointer is: pasted content lands there.
    this.listen(stage, 'pointermove', (event) => {
      this.inside = true;
      host.setPointer(host.clientToWorld(event.clientX, event.clientY));
    });
    this.listen(stage, 'pointerleave', () => {
      this.inside = false;
      host.setPointer(null);
    });
    // Files dropped on the board.
    this.listen(stage, 'dragover', (event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    });
    this.listen(stage, 'drop', (event) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      void host.addFiles(files, host.clientToWorld(event.clientX, event.clientY));
    });
    // Keyboard and clipboard shortcuts go to the board in use: the one pressed last or,
    // before any press, the one under the pointer.
    this.listen(stage, 'pointerdown', () => {
      activeBoard.pressed(this.board);
      host.setInteracting(true);
    });
    const release = () => host.setInteracting(false);
    this.listen(window, 'pointerup', release);
    this.listen(window, 'pointercancel', release);
    this.disposers.push(release);
  }

  /** Never while typing in a field or in board text, and only for the board in use. */
  private accepts(target: EventTarget | null): boolean {
    return !isTypingTarget(target) && activeBoard.accepts(this.board, this.inside);
  }

  private listenToClipboard(): void {
    const host = this.host;
    // Native clipboard events carry the data both ways without asking for permission, and
    // work between tabs and boards. `fired`: the browser sent one for the last shortcut.
    let fired = false;
    const onCopy = (event: ClipboardEvent, cut: boolean) => {
      fired = true;
      if (!this.accepts(event.target) || !host.hasSelection()) return;
      // Text selected on the page is copied as usual.
      const textSelection = getSelection();
      if (textSelection && !textSelection.isCollapsed) return;
      const data = host.takeCopy();
      if (!data || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData('text/html', clipboardToHtml(data));
      event.clipboardData.setData('text/plain', clipboardText(data));
      if (cut) host.deleteSelection();
    };
    this.listen(window, 'copy', (event) => onCopy(event, false));
    this.listen(window, 'cut', (event) => onCopy(event, true));
    this.listen(window, 'paste', (event) => {
      fired = true;
      if (!this.accepts(event.target)) return;
      const transfer = event.clipboardData;
      const files = [...(transfer?.files ?? [])];
      const data = clipboardFromHtml(transfer?.getData('text/html') ?? '');
      const text = transfer?.getData('text/plain') ?? '';
      if (files.length > 0) void host.addFiles(files);
      else if (data) host.paste(data);
      else if (text.trim()) host.pasteText(text);
      // Nothing usable on the system clipboard: what was copied on this board.
      else if (host.hasCopy()) host.paste();
      else return;
      event.preventDefault();
    });
    this.listen(window, 'keydown', (event) => {
      const command = event.ctrlKey || event.metaKey;
      if (!command || event.altKey || event.shiftKey || !this.accepts(event.target)) return;
      if (event.code === 'KeyD') {
        event.preventDefault(); // not the browser's bookmark
        host.duplicate();
        return;
      }
      const code = event.code;
      if (code !== 'KeyC' && code !== 'KeyX' && code !== 'KeyV') return;
      // Some browsers (Safari) send no clipboard event without a text selection or a field:
      // then copy and paste through the async clipboard API instead.
      fired = false;
      setTimeout(() => {
        if (fired || !host.isCurrentMount()) return;
        if (code === 'KeyC') host.copy();
        else if (code === 'KeyX') host.cut();
        else void host.pasteFromClipboard();
      }, 0);
    });
  }
}
