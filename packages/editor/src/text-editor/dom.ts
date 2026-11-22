import {
  cssColor,
  fontFamily,
  LINK_COLOR,
  listMarkers,
  normalizeParagraphs,
  normalizeRuns,
  paragraphCount,
  paragraphIndent,
  paragraphStyle,
  type ParagraphStyle,
  type TextBlock,
  type TextRun,
  type TextStyle,
} from '@apeiro/core';

/**
 * The editor's DOM is a canonical rendering of a `TextBlock`, read back after the browser
 * changed it (typing, IME, paste, deleting across lines):
 *
 *   input > div[data-p] (one per paragraph; list items carry data-list/indent/marker)
 *         > span (one per run piece: data-b/i/u/s, data-c color, data-size, data-font,
 *                 data-href) > text
 *
 * An empty paragraph holds a `<br data-sentinel>` so it has a line box and a caret spot.
 * Sizes and indents are written as `calc(var(--k) * Npx)`, where the editor sets `--k` to
 * the layout's autoFit scale, so the DOM shrinks exactly like the board text.
 *
 * While editing, this DOM is what shows the text (the board hides its own), so colors are
 * written as the board draws them: `drawnColor` maps a stored color to the shown one (a dark
 * theme may show it differently). Links without a color of their own take `LINK_COLOR`, and a
 * list marker takes the color of its paragraph's first run (`--mc`), as on the board.
 */

const scaled = (pixels: number) => `calc(var(--k, 1) * ${pixels}px)`;

/** Splits runs at line breaks: the runs of each paragraph. */
function splitParagraphs(runs: readonly TextRun[]): TextRun[][] {
  const paragraphs: TextRun[][] = [[]];
  for (const run of runs) {
    run.text.split('\n').forEach((text, index) => {
      if (index > 0) paragraphs.push([]);
      if (text) paragraphs[paragraphs.length - 1]!.push({ ...run, text });
    });
  }
  return paragraphs;
}

export function render(
  root: HTMLElement,
  block: TextBlock,
  drawnColor: (color: number) => number = (color) => color,
): void {
  root.replaceChildren();
  const paragraphs = splitParagraphs(block.runs);
  const markers = block.paragraphs ? listMarkers(block, paragraphs.length) : [];
  paragraphs.forEach((runs, index) => {
    const paragraph = document.createElement('div');
    paragraph.dataset.p = '1';
    const style = paragraphStyle(block, index);
    if (style.list) {
      const indent = paragraphIndent(style, block.fontSize);
      paragraph.dataset.list = style.list;
      if (style.indent) paragraph.dataset.indent = String(style.indent);
      paragraph.dataset.marker = markers[index] ?? '';
      paragraph.style.paddingLeft = scaled(indent);
      paragraph.style.setProperty('--mw', scaled(indent));
      const first = runs[0];
      const markerColor = first?.color ?? (first?.link ? LINK_COLOR : block.color);
      paragraph.style.setProperty('--mc', cssColor(drawnColor(markerColor)));
    }
    for (const run of runs) paragraph.append(span(run, drawnColor));
    if (runs.length === 0) {
      const lineBreak = document.createElement('br');
      lineBreak.dataset.sentinel = '1';
      paragraph.append(lineBreak);
    }
    root.append(paragraph);
  });
}

function span(run: TextRun, drawnColor: (color: number) => number): HTMLSpanElement {
  const span = document.createElement('span');
  const data = span.dataset;
  if (run.bold) data.b = '1';
  if (run.italic) data.i = '1';
  if (run.underline) data.u = '1';
  if (run.strike) data.s = '1';
  if (run.color !== undefined) {
    data.c = String(run.color);
    span.style.color = cssColor(drawnColor(run.color));
  } else if (run.link !== undefined) {
    span.style.color = cssColor(drawnColor(LINK_COLOR));
  }
  if (run.size !== undefined) {
    data.size = String(run.size);
    span.style.fontSize = scaled(run.size);
  }
  if (run.font !== undefined) {
    data.font = run.font;
    span.style.fontFamily = fontFamily(run.font).css;
  }
  if (run.link !== undefined) {
    data.href = run.link;
    span.title = run.link;
  }
  span.textContent = run.text;
  return span;
}

const isBlock = (node: Node, root: HTMLElement): node is HTMLElement =>
  node !== root &&
  node instanceof HTMLElement &&
  (node.tagName === 'DIV' || node.tagName === 'P' || node.tagName === 'LI');

/** Whether a node shows anything: text, a line break, an image… (not empty wrappers). */
function hasContent(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '') !== '';
  if (!(node instanceof HTMLElement)) return false;
  if (node.tagName === 'BR') return !node.dataset.sentinel;
  for (const child of node.childNodes) if (hasContent(child)) return true;
  return false;
}

/**
 * A `<br>` with nothing after it in its paragraph only gives an empty line its height
 * (browsers add one after deleting or merging lines): it is not a line break. Like in HTML
 * rendering, where such a trailing `<br>` adds no line.
 */
function isFillerBreak(lineBreak: HTMLElement, root: HTMLElement): boolean {
  if (lineBreak.dataset.sentinel) return true;
  for (let node: Node = lineBreak; node !== root && !isBlock(node, root); node = node.parentNode!) {
    for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
      if (isBlock(sibling, root)) return true; // the next paragraph ends this line anyway
      if (hasContent(sibling)) return false;
    }
    if (!node.parentNode) break;
  }
  return true;
}

function blockStyle(element: HTMLElement): ParagraphStyle {
  const list = element.dataset.list;
  if (list !== 'bullet' && list !== 'ordered') return {};
  const indent = Number(element.dataset.indent ?? 0);
  return indent > 0 ? { list, indent } : { list };
}

/**
 * Text and paragraph styles of the editor DOM, read the same way it is rendered. A new
 * line inside a list item (pasted text, a `<br>`) continues that list.
 */
export function parse(root: HTMLElement): { runs: TextRun[]; paragraphs?: ParagraphStyle[] } {
  const runs: TextRun[] = [];
  const styles: ParagraphStyle[] = [{}];
  let any = false;
  const newline = (style: ParagraphStyle) => {
    runs.push({ text: '\n' });
    styles.push(style);
    any = true;
  };
  const walk = (node: Node, style: TextStyle, paragraph: ParagraphStyle) => {
    if (node.nodeType === Node.TEXT_NODE) {
      (node.textContent ?? '').split('\n').forEach((text, index) => {
        if (index > 0) newline(paragraph);
        if (text) runs.push({ ...style, text });
      });
      any = true;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') {
      if (!isFillerBreak(node, root)) newline(paragraph);
      return;
    }
    let next = paragraph;
    if (isBlock(node, root)) {
      // Each block is a paragraph: the first one styles paragraph 0, the rest start new ones.
      next = blockStyle(node);
      if (any) newline(next);
      else styles[0] = next;
      any = true;
    }
    const data = node.dataset;
    const styled: TextStyle = { ...style };
    if (data.b) styled.bold = true;
    if (data.i) styled.italic = true;
    if (data.u) styled.underline = true;
    if (data.s) styled.strike = true;
    if (data.c) styled.color = Number(data.c);
    if (data.size && Number(data.size) > 0) styled.size = Number(data.size);
    if (data.font) styled.font = data.font;
    if (data.href) styled.link = data.href;
    for (const child of node.childNodes) walk(child, styled, next);
  };
  walk(root, {}, {});
  const normalized = normalizeRuns(runs);
  const paragraphs = normalizeParagraphs(styles, paragraphCount(normalized));
  return paragraphs ? { runs: normalized, paragraphs } : { runs: normalized };
}

/** Plain-text offset of a DOM position inside `root` (same counting as `parse`). */
export function offsetOf(root: HTMLElement, target: Node, targetOffset: number): number {
  let count = 0;
  let found = -1;
  let any = false;
  const walk = (node: Node): boolean => {
    if (isBlock(node, root)) {
      if (any) count += 1;
      any = true;
    }
    if (node === target && node.nodeType !== Node.TEXT_NODE) {
      // Offset counts child nodes.
      for (let child = 0; child < targetOffset && child < node.childNodes.length; child++)
        walk(node.childNodes[child]!);
      found = count;
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      any = true;
      if (node === target) {
        found = count + targetOffset;
        return true;
      }
      count += node.textContent?.length ?? 0;
      return false;
    }
    if (node instanceof HTMLElement && node.tagName === 'BR') {
      if (!isFillerBreak(node, root)) {
        count += 1;
        any = true;
      }
      return false;
    }
    for (const child of node.childNodes) if (walk(child)) return true;
    return false;
  };
  walk(root);
  return found < 0 ? count : found;
}

/** DOM position for a plain-text offset in a canonical (rendered) editor. */
export function positionOf(root: HTMLElement, offset: number): { node: Node; offset: number } {
  let remaining = offset;
  const blocks = [...root.children].filter((child) => (child as HTMLElement).dataset.p);
  for (const paragraph of blocks) {
    const texts: Node[] = [];
    for (const child of paragraph.children)
      if (child.firstChild?.nodeType === Node.TEXT_NODE) texts.push(child.firstChild);
    const length = texts.reduce((total, text) => total + (text.textContent?.length ?? 0), 0);
    if (remaining <= length) {
      for (const text of texts) {
        const textLength = text.textContent?.length ?? 0;
        if (remaining <= textLength) return { node: text, offset: remaining };
        remaining -= textLength;
      }
      return { node: paragraph, offset: 0 }; // empty paragraph: before its <br>
    }
    remaining -= length + 1;
  }
  // Not canonical (e.g. mid-edit): fall back to the end.
  const last = blocks[blocks.length - 1];
  return last ? { node: last, offset: last.childNodes.length } : { node: root, offset: 0 };
}
