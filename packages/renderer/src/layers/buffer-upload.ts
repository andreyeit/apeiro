/** Dirty instances (not byte offsets): nothing, everything, or sorted disjoint half-open runs. */
export type BufferUpload =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'ranges'; runs: ReadonlyArray<readonly [number, number]> };

/** Runs closer than this many instances go up as one: an upload call costs more than a few bytes. */
export const RUN_GAP = 32;
/** At most this many uploads per buffer and frame; the narrowest gaps are merged first. */
export const MAX_RUNS = 64;
/** Unsorted marks kept before they are folded together (e.g. edits while nothing is drawn). */
const MAX_PENDING = 4096;

/**
 * Sorts runs and merges overlapping ones and those separated by at most `gap` instances.
 * If more than `maximum` runs remain, the narrowest gaps are merged until at most that many are left.
 */
export function coalesceRuns(
  runs: Array<[number, number]>,
  gap = RUN_GAP,
  maximum = MAX_RUNS,
): Array<[number, number]> {
  runs.sort((first, second) => first[0] - second[0]);
  const merged: Array<[number, number]> = [];
  for (const [from, to] of runs) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + gap) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  if (merged.length <= maximum) return merged;
  // Merge exactly the (count - maximum) narrowest gaps: gap `index` lies between runs
  // `index - 1` and `index`.
  const gapWidth = (index: number) => merged[index]![0] - merged[index - 1]![1];
  const order = Array.from({ length: merged.length - 1 }, (_, index) => index + 1);
  order.sort((first, second) => gapWidth(first) - gapWidth(second));
  const join = new Set(order.slice(0, merged.length - maximum));
  const capped: Array<[number, number]> = [merged[0]!];
  for (let index = 1; index < merged.length; index++) {
    if (join.has(index)) capped[capped.length - 1]![1] = merged[index]![1];
    else capped.push(merged[index]!);
  }
  return capped;
}

/**
 * Collects the instances changed since the last upload. Separate edits stay separate uploads
 * (a few scattered changes don't upload the whole span between them), close ones are merged.
 */
export class DirtyRanges {
  private all = false;
  private pending: Array<[number, number]> = [];

  /** Marks instances `from` (inclusive) to `to` (exclusive). */
  mark(from: number, to: number): void {
    if (from >= to || this.all) return;
    this.pending.push([from, to]);
    if (this.pending.length > MAX_PENDING) this.pending = coalesceRuns(this.pending);
  }

  markAll(): void {
    this.all = true;
    this.pending = [];
  }

  /** What changed since the last call; resets. */
  take(): BufferUpload {
    if (this.all) {
      this.all = false;
      return { kind: 'all' };
    }
    if (this.pending.length === 0) return { kind: 'none' };
    const runs = coalesceRuns(this.pending);
    this.pending = [];
    return { kind: 'ranges', runs };
  }
}

/**
 * Byte [offset, length] pairs to upload: every used byte for `all` or a fresh buffer,
 * otherwise each dirty run clipped to the instances in use.
 */
export function byteRuns(
  upload: BufferUpload,
  fresh: boolean,
  count: number,
  stride: number,
): Array<[number, number]> {
  if (upload.kind === 'none' || count === 0) return [];
  if (fresh || upload.kind === 'all') return [[0, count * stride]];
  const byteRanges: Array<[number, number]> = [];
  for (const [from, to] of upload.runs) {
    const end = Math.min(to, count);
    if (from < end) byteRanges.push([from * stride, (end - from) * stride]);
  }
  return byteRanges;
}
