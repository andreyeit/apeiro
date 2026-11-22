import {
  clampListIndent,
  paragraphAt,
  paragraphCount,
  type ListKind,
  type ParagraphStyle,
  type TextBlock,
  type TextRun,
} from './text-block';

// Editing rich text: styling ranges of runs, links, and the paragraph styles (lists) that
// follow the text through edits. Offsets are UTF-16 code units, the same as DOM selections.

/** Style attributes of a run (everything except the text). */
export type TextStyle = Omit<TextRun, 'text'>;
export type StyleKey = keyof TextStyle;

const STYLE_KEYS: StyleKey[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'color',
  'size',
  'font',
  'link',
];
/** On/off attributes, toggled by B/I/U/S. */
export type BooleanStyle = 'bold' | 'italic' | 'underline' | 'strike';

/** `false` and absent mean the same. */
const valueOf = (style: TextStyle, key: StyleKey) =>
  style[key] === false ? undefined : style[key];

function styleOf(run: TextRun): TextStyle {
  const style: TextStyle = {};
  for (const key of STYLE_KEYS) {
    const value = valueOf(run, key);
    if (value !== undefined) (style as Record<string, unknown>)[key] = value;
  }
  return style;
}

export function sameStyle(first: TextStyle, second: TextStyle): boolean {
  return STYLE_KEYS.every((key) => valueOf(first, key) === valueOf(second, key));
}

export const runsLength = (runs: readonly TextRun[]): number =>
  runs.reduce((total, run) => total + run.text.length, 0);

/** Drops empty runs and merges neighbours with equal style. Always returns at least one run. */
export function normalizeRuns(runs: readonly TextRun[]): TextRun[] {
  const normalized: TextRun[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const previous = normalized[normalized.length - 1];
    if (previous && sameStyle(previous, run)) previous.text += run.text;
    else normalized.push({ ...styleOf(run), text: run.text });
  }
  if (normalized.length === 0) normalized.push({ ...(runs[0] ? styleOf(runs[0]) : {}), text: '' });
  return normalized;
}

/**
 * Applies `patch` to the range [from, to).
 * `undefined`/`false` values remove the attribute.
 */
export function applyStyle(
  runs: readonly TextRun[],
  from: number,
  to: number,
  patch: TextStyle,
): TextRun[] {
  if (to <= from) return normalizeRuns(runs);
  const styled: TextRun[] = [];
  let position = 0;
  for (const run of runs) {
    const start = position;
    const end = position + run.text.length;
    position = end;
    const overlapStart = Math.max(from, start);
    const overlapEnd = Math.min(to, end);
    if (overlapStart >= overlapEnd) {
      styled.push({ ...run });
      continue;
    }
    if (overlapStart > start)
      styled.push({ ...run, text: run.text.slice(0, overlapStart - start) });
    const piece: TextRun = {
      ...run,
      text: run.text.slice(overlapStart - start, overlapEnd - start),
    };
    for (const key of Object.keys(patch) as StyleKey[]) {
      const value = patch[key];
      if (value === undefined || value === false) delete piece[key];
      else (piece as unknown as Record<string, unknown>)[key] = value;
    }
    styled.push(piece);
    if (overlapEnd < end) styled.push({ ...run, text: run.text.slice(overlapEnd - start) });
  }
  return normalizeRuns(styled);
}

/**
 * Replaces [from, to) with `text`, styled like the run it lands in plus `style` (e.g. what
 * the user toggled with a collapsed caret, or a link).
 */
export function replaceText(
  runs: readonly TextRun[],
  from: number,
  to: number,
  text: string,
  style: TextStyle | null = null,
): TextRun[] {
  const replaced: TextRun[] = [];
  let position = 0;
  let inserted = false;
  for (const run of runs) {
    const start = position;
    const end = position + run.text.length;
    position = end;
    if (end <= from || start >= to) {
      replaced.push(run);
      if (!inserted && end === from) {
        replaced.push({ ...run, ...style, text });
        inserted = true;
      }
      continue;
    }
    replaced.push({ ...run, text: run.text.slice(0, Math.max(0, from - start)) });
    if (!inserted) {
      replaced.push({ ...run, ...style, text });
      inserted = true;
    }
    replaced.push({ ...run, text: run.text.slice(Math.max(0, to - start)) });
  }
  if (!inserted) replaced.unshift({ ...style, text });
  return normalizeRuns(replaced);
}

/** The run a collapsed caret at `offset` types into: the one with the character before it. */
function runBeforeCaret(runs: readonly TextRun[], offset: number): TextRun | undefined {
  let position = 0;
  let found: TextRun | undefined = runs[0];
  for (const run of runs) {
    if (position < offset) found = run;
    position += run.text.length;
  }
  return found;
}

/** Runs with text that overlap [from, to). */
function* runsIn(runs: readonly TextRun[], from: number, to: number): Generator<TextRun> {
  let position = 0;
  for (const run of runs) {
    const start = position;
    position += run.text.length;
    if (position <= from || start >= to || run.text.length === 0) continue;
    yield run;
  }
}

/**
 * Whether a boolean attribute is set on every character of [from, to).
 * For a collapsed range it reports the style of the character before the caret.
 */
export function hasStyle(
  runs: readonly TextRun[],
  from: number,
  to: number,
  key: BooleanStyle,
): boolean {
  if (to <= from) return !!runBeforeCaret(runs, from)?.[key];
  let any = false;
  for (const run of runsIn(runs, from, to)) {
    any = true;
    if (!run[key]) return false;
  }
  return any;
}

/** Toggles a boolean attribute over a range: on if any character lacks it, otherwise off. */
export function toggleStyle(
  runs: readonly TextRun[],
  from: number,
  to: number,
  key: BooleanStyle,
): TextRun[] {
  return applyStyle(runs, from, to, { [key]: !hasStyle(runs, from, to, key) });
}

/** `commonStyle` result when a range mixes several values. */
export const MIXED = Symbol('mixed');

/**
 * The value of an attribute shared by every character of [from, to), `MIXED` if they
 * differ. For a collapsed range: the value at the character before the caret.
 */
export function commonStyle<K extends StyleKey>(
  runs: readonly TextRun[],
  from: number,
  to: number,
  key: K,
): TextRun[K] | typeof MIXED {
  if (to <= from) return runBeforeCaret(runs, from)?.[key];
  let seen = false;
  let value: TextRun[K] | undefined;
  for (const run of runsIn(runs, from, to)) {
    if (!seen) {
      seen = true;
      value = run[key];
    } else if (run[key] !== value) return MIXED;
  }
  return value;
}

/** The whole link around an offset: [from, to) and its target, or null outside links. */
export function linkAt(
  runs: readonly TextRun[],
  offset: number,
): { from: number; to: number; href: string } | null {
  let position = 0;
  const spans: Array<{ from: number; to: number; href: string | undefined }> = [];
  for (const run of runs) {
    spans.push({ from: position, to: position + run.text.length, href: run.link });
    position += run.text.length;
  }
  // Inside a link, or right after its last character (caret at its end).
  const index = spans.findIndex((span) => span.href && offset > span.from && offset <= span.to);
  if (index < 0) return null;
  const href = spans[index]!.href!;
  let first = index;
  let last = index;
  while (first > 0 && spans[first - 1]!.href === href) first--;
  while (last + 1 < spans.length && spans[last + 1]!.href === href) last++;
  return { from: spans[first]!.from, to: spans[last]!.to, href };
}

const LINK_SCHEMES = /^(https?:|mailto:)/i;

/** True for link targets text may carry: http(s) and mailto only (no `javascript:` etc.). */
export function isAllowedLink(href: string): boolean {
  if (!LINK_SCHEMES.test(href.trim())) return false;
  try {
    const url = new URL(href.trim());
    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Turns what a user typed into a link target: adds `https://` to bare domains and
 * `mailto:` to e-mail addresses. Null if it isn't a usable link.
 */
export function normalizeLink(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return null;
  let href = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (/^[^@/]+@[^@/]+\.[^@/]+$/.test(trimmed)) href = `mailto:${trimmed}`;
    else if (/^[^/]+\.[a-z]{2,}([/?#:].*)?$/i.test(trimmed) || trimmed.startsWith('//'))
      href = `https://${trimmed.replace(/^\/\//, '')}`;
    else return null;
  }
  return isAllowedLink(href) ? href : null;
}

// --- Paragraphs (lists) ------------------------------------------------------

const isPlain = (style: ParagraphStyle | undefined) => !style || (!style.list && !style.indent);

/** Paragraph styles trimmed to `count` paragraphs; undefined when all are plain. */
export function normalizeParagraphs(
  paragraphs: ReadonlyArray<ParagraphStyle | undefined> | undefined,
  count: number,
): ParagraphStyle[] | undefined {
  if (!paragraphs) return undefined;
  const normalized: ParagraphStyle[] = [];
  for (let index = 0; index < count; index++) {
    const style = paragraphs[index];
    if (!style?.list) {
      normalized.push({});
      continue;
    }
    const indent = clampListIndent(style.indent);
    normalized.push(indent > 0 ? { list: style.list, indent } : { list: style.list });
  }
  while (normalized.length > 0 && isPlain(normalized[normalized.length - 1])) normalized.pop();
  return normalized.length > 0 ? normalized : undefined;
}

/** `block` with these paragraph styles (the field is dropped when all are plain). */
export function withParagraphs(
  block: TextBlock,
  paragraphs: ParagraphStyle[] | undefined,
): TextBlock {
  const next: TextBlock = { ...block, paragraphs };
  if (!paragraphs) delete next.paragraphs;
  return next;
}

/**
 * Paragraph styles after the text [from, to) of `runs` is replaced by `inserted`:
 * paragraphs the removed text joined keep the first one's style (like Backspace at the
 * start of a line in a word processor), new line breaks continue the paragraph's style
 * (Enter in a list makes another item).
 */
export function remapParagraphs(
  runs: readonly TextRun[],
  paragraphs: readonly ParagraphStyle[] | undefined,
  from: number,
  to: number,
  inserted: string,
): ParagraphStyle[] | undefined {
  if (!paragraphs) return undefined;
  const first = paragraphAt(runs, from);
  const removed = paragraphAt(runs, to) - first;
  const added = paragraphCount([{ text: inserted }]) - 1;
  const style = paragraphs[first] ?? {};
  const remapped = [
    ...Array.from({ length: first }, (_, index) => paragraphs[index] ?? {}),
    ...Array.from({ length: added + 1 }, () => ({ ...style })),
    ...paragraphs.slice(first + removed + 1),
  ];
  return normalizeParagraphs(remapped, paragraphCount(runs) - removed + added);
}

/**
 * The block with [from, to) replaced by `text` (see `replaceText`), its paragraph styles
 * following the edit (see `remapParagraphs`).
 */
export function replaceBlockText(
  block: TextBlock,
  from: number,
  to: number,
  text: string,
  style: TextStyle | null = null,
): TextBlock {
  const runs = replaceText(block.runs, from, to, text, style);
  const paragraphs = remapParagraphs(block.runs, block.paragraphs, from, to, text);
  return withParagraphs({ ...block, runs }, paragraphs);
}

/** Paragraph indices [first, last] touched by the range [from, to]. */
export function paragraphRange(
  runs: readonly TextRun[],
  from: number,
  to: number,
): [number, number] {
  return [paragraphAt(runs, from), paragraphAt(runs, to)];
}

/** Applies `change` to the styles of paragraphs first..last (inclusive). */
export function updateParagraphs(
  block: TextBlock,
  first: number,
  last: number,
  change: (style: ParagraphStyle, index: number) => ParagraphStyle,
): TextBlock {
  const count = paragraphCount(block.runs);
  const styles: ParagraphStyle[] = [];
  for (let index = 0; index < count; index++) {
    const style = block.paragraphs?.[index] ?? {};
    styles.push(index >= first && index <= last ? change(style, index) : style);
  }
  return withParagraphs(block, normalizeParagraphs(styles, count));
}

/**
 * Toggles a list on paragraphs first..last: if all of them already are this kind of list,
 * they become plain text; otherwise they all become this kind (keeping their levels).
 */
export function toggleList(
  block: TextBlock,
  first: number,
  last: number,
  kind: ListKind,
): TextBlock {
  let all = true;
  for (let index = first; index <= last; index++)
    if (block.paragraphs?.[index]?.list !== kind) all = false;
  return updateParagraphs(block, first, last, (style) => (all ? {} : { ...style, list: kind }));
}

/** Moves list items first..last one level deeper (+1) or shallower (-1). */
export function indentList(
  block: TextBlock,
  first: number,
  last: number,
  direction: 1 | -1,
): TextBlock {
  return updateParagraphs(block, first, last, (style) =>
    style.list ? { ...style, indent: clampListIndent((style.indent ?? 0) + direction) } : style,
  );
}
