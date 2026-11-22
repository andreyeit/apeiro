import {
  clipboardFromHtml,
  clipboardText,
  clipboardToHtml,
  type BoardClipboard,
} from '@apeiro/core';

/** Puts board data on the system clipboard (HTML for boards, plain text for other apps). */
export async function writeSystemClipboard(data: BoardClipboard): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return;
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([clipboardToHtml(data)], { type: 'text/html' }),
          'text/plain': new Blob([clipboardText(data)], { type: 'text/plain' }),
        }),
      ]);
    }
  } catch {
    // Not allowed outside a user gesture, or denied: the editor's own clipboard still works.
  }
}

/** What the system clipboard holds that a board can paste. */
export type SystemClipboardContent =
  | { kind: 'image'; file: File }
  | { kind: 'board'; data: BoardClipboard }
  | { kind: 'text'; text: string };

/**
 * Reads the system clipboard: an image, board elements or non-blank text, whichever comes
 * first. Null when it holds none of them, or reading is not allowed.
 */
export async function readSystemClipboard(): Promise<SystemClipboardContent | null> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const image = item.types.find((type) => type.startsWith('image/'));
      if (image) {
        const blob = await item.getType(image);
        return { kind: 'image', file: new File([blob], 'pasted-image', { type: image }) };
      }
      if (item.types.includes('text/html')) {
        const data = clipboardFromHtml(await (await item.getType('text/html')).text());
        if (data) return { kind: 'board', data };
      }
      if (item.types.includes('text/plain')) {
        const text = await (await item.getType('text/plain')).text();
        if (text.trim()) return { kind: 'text', text };
      }
    }
  } catch {
    // No permission or no async clipboard.
  }
  return null;
}
