import { detachEnds } from '../connectors/connector';
import type { ConnectorEnd } from '../connectors/types';
import { isConnector, type BoardElement } from '../elements/element';
import { newId } from '../elements/ids';
import { validateElement } from '../elements/validation';
import type { Box } from '../geometry/box';
import type { Vec2 } from '../geometry/vector';
import { plainText } from '../text/text-block';
import { compareZ, type Scene } from './scene';

/** Elements copied from a board: plain JSON, safe to store, send or put on the system clipboard. */
export interface BoardClipboard {
  kind: 'apeiro/elements';
  version: 1;
  /** In paint order. Connector ends refer to copied shapes by their original ids. */
  elements: BoardElement[];
  /** World bounds of the copied elements when they were copied. */
  bounds: Box;
}

const KIND = 'apeiro/elements';

/**
 * Copies elements `ids` (and the connectors running between them) as clipboard data.
 * A connector end attached to a shape that isn't copied becomes a free end where it is
 * now, so the pasted line looks the same. Returns null if none of the ids exist.
 */
export function copyElements(scene: Scene, ids: Iterable<string>): BoardClipboard | null {
  const picked = new Set<string>();
  for (const id of ids) if (scene.has(id)) picked.add(id);
  if (picked.size === 0) return null;
  // Lines between copied shapes come along (duplicating a diagram keeps its arrows).
  for (const id of [...picked]) {
    for (const connectorId of scene.connectorsOf(id)) {
      const element = scene.get(connectorId);
      if (
        element &&
        isConnector(element) &&
        endIn(element.start, picked) &&
        endIn(element.end, picked)
      )
        picked.add(connectorId);
    }
  }
  const elements: BoardElement[] = [];
  for (const id of picked) {
    const element = scene.get(id)!;
    const copied = isConnector(element)
      ? detachEnds(element, scene.connectorGeometry(id), (shapeId) => picked.has(shapeId))
      : element;
    elements.push(structuredClone(copied));
  }
  elements.sort(compareZ);
  const bounds = scene.bounds(picked);
  if (!bounds) return null;
  return { kind: KIND, version: 1, elements, bounds };
}

const endIn = (end: ConnectorEnd, ids: ReadonlySet<string>) =>
  end.kind === 'element' && ids.has(end.id);

export interface PasteOptions {
  /** Moves the copy by this much (world units) from where it was copied. */
  offset?: Vec2;
  /** Centers the copy on this world point instead (wins over `offset`). */
  at?: Vec2;
  /** New element id; the default makes random ids (see `newId`). */
  newId?: (original: BoardElement) => string;
}

/**
 * Adds a copy of `data` to the scene, on top of everything, with new ids (connectors and
 * groups are rewired to the copies). Invalid elements are skipped. Returns the new ids.
 * One scene batch, so one undo step.
 */
export function pasteElements(
  scene: Scene,
  data: BoardClipboard,
  options: PasteOptions = {},
): string[] {
  const bounds = data.bounds;
  const delta = options.at
    ? {
        x: options.at.x - (bounds.minX + bounds.maxX) / 2,
        y: options.at.y - (bounds.minY + bounds.maxY) / 2,
      }
    : (options.offset ?? { x: 0, y: 0 });
  const makeId =
    options.newId ?? ((element: BoardElement) => newId(isConnector(element) ? 'c' : 's'));

  const ids = new Map<string, string>();
  for (const element of data.elements) ids.set(element.id, makeId(element));
  // A group survives only if at least two of its members are pasted.
  const groupSizes = new Map<string, number>();
  for (const element of data.elements)
    if (element.groupId)
      groupSizes.set(element.groupId, (groupSizes.get(element.groupId) ?? 0) + 1);
  const groups = new Map<string, string>();
  const groupOf = (groupId: string | undefined) => {
    if (!groupId || (groupSizes.get(groupId) ?? 0) < 2) return undefined;
    let id = groups.get(groupId);
    if (!id) groups.set(groupId, (id = newId('g')));
    return id;
  };
  const moveEnd = (end: ConnectorEnd): ConnectorEnd => {
    if (end.kind === 'point') return { kind: 'point', x: end.x + delta.x, y: end.y + delta.y };
    const id = ids.get(end.id);
    return id ? { ...end, id } : end;
  };

  const pasted: string[] = [];
  let z = scene.maxZ();
  scene.transact(() => {
    for (const source of data.elements) {
      const copy = structuredClone(source) as BoardElement;
      copy.id = ids.get(source.id)!;
      copy.z = ++z;
      const groupId = groupOf(source.groupId);
      if (groupId) copy.groupId = groupId;
      else delete copy.groupId;
      if (isConnector(copy)) {
        copy.start = moveEnd(copy.start);
        copy.end = moveEnd(copy.end);
      } else {
        copy.x += delta.x;
        copy.y += delta.y;
      }
      if (validateElement(copy) || scene.has(copy.id)) continue;
      scene.add(copy);
      pasted.push(copy.id);
    }
  });
  return pasted;
}

/** Copies the elements and adds the copy right away, moved by `offset`. Returns the new ids. */
export function duplicateElements(scene: Scene, ids: Iterable<string>, offset: Vec2): string[] {
  const data = copyElements(scene, ids);
  return data ? pasteElements(scene, data, { offset }) : [];
}

/** Whether `value` looks like clipboard data (e.g. parsed from the system clipboard). */
export function isBoardClipboard(value: unknown): value is BoardClipboard {
  const clipboard = value as Partial<BoardClipboard> | null;
  return (
    !!clipboard &&
    typeof clipboard === 'object' &&
    clipboard.kind === KIND &&
    clipboard.version === 1 &&
    Array.isArray(clipboard.elements) &&
    !!clipboard.bounds &&
    [
      clipboard.bounds.minX,
      clipboard.bounds.minY,
      clipboard.bounds.maxX,
      clipboard.bounds.maxY,
    ].every(Number.isFinite)
  );
}

/** The text of the copied elements, one per line (what a text editor gets when pasted there). */
export function clipboardText(data: BoardClipboard): string {
  return data.elements
    .map((element) => ('text' in element && element.text ? plainText(element.text).trim() : ''))
    .filter(Boolean)
    .join('\n');
}

/** Clipboard data as HTML: other apps paste the text, boards read the data back. */
export function clipboardToHtml(data: BoardClipboard): string {
  const json = encodeURIComponent(JSON.stringify(data));
  const text = clipboardText(data)
    .split('\n')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
  return `<meta charset="utf-8"><div data-apeiro="${json}">${text}</div>`;
}

/** Clipboard data embedded by `clipboardToHtml`, or null. */
export function clipboardFromHtml(html: string): BoardClipboard | null {
  const match = /data-apeiro="([^"]*)"/.exec(html);
  if (!match) return null;
  try {
    const data: unknown = JSON.parse(decodeURIComponent(match[1]!));
    return isBoardClipboard(data) ? data : null;
  } catch {
    return null;
  }
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!,
  );
