import type { TextBlock, TextRun } from '@apeiro/core';
import * as Y from 'yjs';

type Attributes = Record<string, unknown>;
interface Cell {
  text: string;
  attributes: Attributes;
}

/** Newline attributes carry paragraph styles, including the final empty paragraph. */
function cells(block: TextBlock): Cell[] {
  const result: Cell[] = [];
  let paragraph = 0;
  for (const run of block.runs) {
    const { text, ...attributes } = run;
    for (let index = 0; index < text.length; index++) {
      const character = text[index]!;
      result.push({
        text: character,
        attributes:
          character === '\n'
            ? { ...attributes, paragraph: block.paragraphs?.[paragraph++] ?? {} }
            : attributes,
      });
    }
  }
  result.push({ text: '\n', attributes: { paragraph: block.paragraphs?.[paragraph] ?? {} } });
  return result;
}

export function equal(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return false;
  if (Array.isArray(first) !== Array.isArray(second)) return false;
  const a = first as Record<string, unknown>;
  const b = second as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!equal(a[key], b[key])) return false;
  return true;
}

/** Write only changed properties, retaining other participants' independent changes. */
export function writeFields(
  target: Y.Map<unknown>,
  next: Record<string, unknown>,
  previous: Record<string, unknown> = {},
): void {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (equal(previous[key], next[key])) continue;
    if (next[key] === undefined) target.delete(key);
    else target.set(key, structuredClone(next[key]));
  }
}

export function writeText(target: Y.Map<unknown>, next: TextBlock, previous?: TextBlock): void {
  const properties = Object.fromEntries(
    Object.entries(next).filter(([key]) => key !== 'runs' && key !== 'paragraphs'),
  );
  const oldProperties = Object.fromEntries(
    Object.entries(previous ?? {}).filter(([key]) => key !== 'runs' && key !== 'paragraphs'),
  );
  writeFields(target, properties, oldProperties);
  let content = target.get('content');
  if (!(content instanceof Y.Text)) {
    content = new Y.Text();
    target.set('content', content);
  }
  const sharedText = content as Y.Text;
  const before = previous ? cells(previous) : [];
  const after = cells(next);
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix]!.text === after[prefix]!.text
  )
    prefix++;
  // Never split a UTF-16 surrogate pair when generating insert/delete operations.
  if (prefix > 0 && /[\uDC00-\uDFFF]/.test(after[prefix]?.text ?? '')) prefix--;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1]!.text === after[after.length - suffix - 1]!.text
  )
    suffix++;
  if (suffix > 0 && /[\uDC00-\uDFFF]/.test(after[after.length - suffix]!.text)) suffix--;
  const delta: Array<{
    retain?: number;
    delete?: number;
    insert?: string;
    attributes?: Attributes;
  }> = [];
  const retain = (oldCells: Cell[], newCells: Cell[]) => {
    for (let index = 0; index < newCells.length; index++) {
      const attributes: Attributes = {};
      const oldAttributes = oldCells[index]!.attributes;
      const newAttributes = newCells[index]!.attributes;
      for (const key of new Set([...Object.keys(oldAttributes), ...Object.keys(newAttributes)]))
        if (!equal(oldAttributes[key], newAttributes[key]))
          attributes[key] = newAttributes[key] ?? null;
      const last = delta.at(-1);
      if (last?.retain && equal(last.attributes, attributes)) last.retain++;
      else delta.push({ retain: 1, attributes });
    }
  };
  retain(before.slice(0, prefix), after.slice(0, prefix));
  const removed = before.length - prefix - suffix;
  if (removed) delta.push({ delete: removed });
  for (const cell of after.slice(prefix, after.length - suffix)) {
    const last = delta.at(-1);
    if (last?.insert && equal(last.attributes, cell.attributes)) last.insert += cell.text;
    else delta.push({ insert: cell.text, attributes: cell.attributes });
  }
  if (suffix) retain(before.slice(-suffix), after.slice(-suffix));
  sharedText.applyDelta(delta);
}

export function readText(target: Y.Map<unknown>): TextBlock {
  const content = target.get('content');
  if (!(content instanceof Y.Text) || !content.toString().endsWith('\n'))
    throw new Error('Invalid shared text');
  const properties = Object.fromEntries([...target].filter(([key]) => key !== 'content'));
  const runs: TextRun[] = [];
  const paragraphs: NonNullable<TextBlock['paragraphs']> = [];
  let remaining = content.length - 1;
  for (const operation of content.toDelta() as Array<{ insert: string; attributes?: Attributes }>) {
    if (typeof operation.insert !== 'string') throw new Error('Text embeds are not supported');
    const { paragraph, ...attributes } = operation.attributes ?? {};
    for (const character of operation.insert) {
      if (character === '\n')
        paragraphs.push((paragraph ?? {}) as NonNullable<TextBlock['paragraphs']>[number]);
    }
    const text = operation.insert.slice(0, Math.max(0, remaining));
    remaining -= operation.insert.length;
    if (text) {
      const last = runs.at(-1);
      if (
        last &&
        equal(
          Object.fromEntries(Object.entries(last).filter(([key]) => key !== 'text')),
          attributes,
        )
      )
        last.text += text;
      else runs.push({ text, ...attributes });
    }
  }
  if (!runs.length) runs.push({ text: '' });
  return {
    ...properties,
    runs,
    ...(paragraphs.some((style) => Object.keys(style).length) ? { paragraphs } : {}),
  } as TextBlock;
}
