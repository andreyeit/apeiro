import { canHoldText, translateElements } from '@apeiro/core';
import { groupSelection, ungroupSelection } from '../selection/grouping';
import { VIEW_TOOLS } from '../tools/tool-state';
import { ARROWS, SHIFT_TOOL_KEYS, SHIFT_ZOOM, TOOL_KEYS } from './constants';
import type { InputContext } from './context';
import { stopCrop, toggleCrop } from './crop';

/** Keys typed into a form field or editable text of the page are not board shortcuts. */
export const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLSelectElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable);

/** Latin letter of the key (by its position), or the typed key when the code is unknown. */
export const keyLetter = (event: KeyboardEvent): string =>
  event.code.startsWith('Key') ? event.code.slice(3) : event.key.toUpperCase();

/**
 * Board shortcuts (Figma/Miro). Shortcuts go by physical key (`event.code`) where a letter is
 * involved, so they work with any keyboard layout. `cancelGesture` handles Esc mid-gesture.
 */
export function handleShortcut(
  context: InputContext,
  event: KeyboardEvent,
  cancelGesture: () => boolean,
): void {
  const { overlay, scene, tools, hooks } = context;
  const command = event.ctrlKey || event.metaKey;
  const plain = !command && !event.altKey;
  const readOnly = context.readOnly();
  const letter = keyLetter(event);

  if (event.code === 'Space') {
    if (context.spaceDown) return;
    context.spaceDown = true;
    if (context.mode.kind === 'idle') context.setCursor('grab');
    event.preventDefault();
    return;
  }
  if (event.key === 'Escape') {
    if (cancelGesture()) return;
    if (stopCrop(context)) return; // Esc leaves crop mode, keeping the image selected
    overlay.selection = new Set();
    tools.setTool('select');
    overlay.request();
    return;
  }
  if (context.mode.kind !== 'idle') return; // no other shortcuts mid-gesture

  if (
    hooks.history &&
    !readOnly &&
    command &&
    !event.altKey &&
    (event.code === 'KeyZ' || event.code === 'KeyY')
  ) {
    event.preventDefault();
    const redo = event.code === 'KeyY' || event.shiftKey;
    const ids = redo ? hooks.history.redo() : hooks.history.undo();
    overlay.selection = new Set(ids);
    overlay.hover = null;
    overlay.anchorsFor = null;
    overlay.request();
  } else if (ARROWS[event.key] && overlay.selection.size > 0 && !command && !readOnly) {
    // Nudge like in Figma: 1 unit, 10 with Shift.
    event.preventDefault();
    const [deltaX, deltaY] = ARROWS[event.key]!;
    const step = event.shiftKey ? 10 : 1;
    context.applyPatches(
      translateElements(context.selectedElements(), deltaX * step, deltaY * step),
    );
    overlay.request();
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && !readOnly) {
    scene.removeWithConnectors(overlay.selection);
    overlay.selection = new Set();
    overlay.request();
  } else if (command && !event.altKey && letter === 'A') {
    event.preventDefault();
    overlay.selection = new Set(Array.from(scene.all(), (element) => element.id));
    overlay.request();
  } else if (
    plain &&
    !event.shiftKey &&
    TOOL_KEYS[letter] &&
    (!readOnly || VIEW_TOOLS.has(TOOL_KEYS[letter]!))
  ) {
    tools.setTool(TOOL_KEYS[letter]!);
  } else if (plain && event.shiftKey && SHIFT_TOOL_KEYS[letter] && !readOnly) {
    tools.setTool(SHIFT_TOOL_KEYS[letter]!);
  } else if (command && !event.altKey && event.code === 'KeyG' && !readOnly) {
    // Ctrl+G groups, Ctrl+Shift+G ungroups.
    event.preventDefault();
    const next = event.shiftKey
      ? ungroupSelection(scene, overlay.selection)
      : groupSelection(scene, overlay.selection);
    if (next) overlay.selection = next;
    overlay.request();
  } else if (command && event.shiftKey && !event.altKey && letter === 'K' && !readOnly) {
    event.preventDefault();
    hooks.pickImage?.();
  } else if (plain && event.shiftKey && hooks.zoom && SHIFT_ZOOM[event.code]) {
    event.preventDefault();
    hooks.zoom(SHIFT_ZOOM[event.code]!);
  } else if (
    hooks.zoom &&
    command &&
    !event.altKey &&
    (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '_')
  ) {
    event.preventDefault(); // not the browser's page zoom
    hooks.zoom(event.key === '-' || event.key === '_' ? 'out' : 'in');
  } else if (plain && event.key === 'Enter' && overlay.selection.size === 1 && !readOnly) {
    const only = scene.get(overlay.selection.values().next().value!);
    if (only?.type === 'image') {
      event.preventDefault();
      toggleCrop(context, only.id);
    } else if (canHoldText(only)) {
      event.preventDefault(); // the Enter must not reach the editor as a new line
      hooks.editText?.(only.id);
    }
  } else if (plain && (event.key === '=' || event.key === '+')) {
    zoomStep(context, 1.25);
  } else if (plain && (event.key === '-' || event.key === '_')) {
    zoomStep(context, 0.8);
  }
}

/** Zooms around the middle of the viewport. */
function zoomStep(context: InputContext, factor: number): void {
  const { camera } = context;
  context.animator.zoomAt({ x: camera.viewportWidth / 2, y: camera.viewportHeight / 2 }, factor);
}
