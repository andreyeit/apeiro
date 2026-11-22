import { boxIntersects, type Box } from './box';

/** Cells are addressed in ±2^20 range per axis; packed into one safe integer key. */
const CELL_OFFSET = 1 << 20;
const CELL_SPAN = 1 << 21;
const cellKey = (cellX: number, cellY: number): number =>
  (cellX + CELL_OFFSET) * CELL_SPAN + (cellY + CELL_OFFSET);

/** The cells a box covers, inclusive on both ends. */
interface CellRange {
  minCellX: number;
  minCellY: number;
  maxCellX: number;
  maxCellY: number;
}

/** Outside this range packed keys collide, and very large coordinates cannot be incremented. */
function canPack(range: CellRange): boolean {
  return (
    range.minCellX >= -CELL_OFFSET &&
    range.minCellY >= -CELL_OFFSET &&
    range.maxCellX < CELL_OFFSET &&
    range.maxCellY < CELL_OFFSET
  );
}

const cellCount = (range: CellRange): number =>
  (range.maxCellX - range.minCellX + 1) * (range.maxCellY - range.minCellY + 1);

const sameRange = (first: CellRange | null, second: CellRange | null): boolean =>
  first === second ||
  (first !== null &&
    second !== null &&
    first.minCellX === second.minCellX &&
    first.minCellY === second.minCellY &&
    first.maxCellX === second.maxCellX &&
    first.maxCellY === second.maxCellY);

function validateBox(box: Box): void {
  if (
    !Number.isFinite(box.minX) ||
    !Number.isFinite(box.minY) ||
    !Number.isFinite(box.maxX) ||
    !Number.isFinite(box.maxY) ||
    box.minX > box.maxX ||
    box.minY > box.maxY
  )
    throw new RangeError('Bounds must be finite and ordered');
}

interface Entry {
  box: Box;
  /** Cell range the entry is registered in, or null if it lives in `large`. */
  cells: CellRange | null;
}

export interface SpatialIndexOptions {
  /** Cell size in world units. Should be close to a typical element size. */
  cellSize?: number;
  /** Entries spanning more cells than this go to a separate linear list. */
  maxCellsPerEntry?: number;
}

/**
 * Uniform grid hash. Chosen over an R-tree because board content is edited
 * constantly (drag = update every frame) and grid insert/remove is O(cells),
 * with no rebalancing. Very large elements are kept in a flat list so they
 * don't pollute thousands of cells.
 */
export class SpatialIndex<Id = string> {
  private readonly cellSize: number;
  private readonly maxCellsPerEntry: number;
  private cells = new Map<number, Set<Id>>();
  private entries = new Map<Id, Entry>();
  private large = new Set<Id>();

  constructor(options: SpatialIndexOptions = {}) {
    this.cellSize = options.cellSize ?? 256;
    this.maxCellsPerEntry = options.maxCellsPerEntry ?? 64;
    if (!Number.isFinite(this.cellSize) || this.cellSize <= 0)
      throw new RangeError('cellSize must be finite and positive');
    if (!Number.isSafeInteger(this.maxCellsPerEntry) || this.maxCellsPerEntry < 1)
      throw new RangeError('maxCellsPerEntry must be a positive safe integer');
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: Id): boolean {
    return this.entries.has(id);
  }

  getBox(id: Id): Box | undefined {
    return this.entries.get(id)?.box;
  }

  /** Inserts or moves an entry. */
  set(id: Id, box: Box): void {
    validateBox(box);
    const previous = this.entries.get(id);
    const range = this.cellRange(box);
    const isLarge = !canPack(range) || cellCount(range) > this.maxCellsPerEntry;
    const nextCells = isLarge ? null : range;

    if (previous) {
      if (sameRange(previous.cells, nextCells)) {
        previous.box = box; // still in the same cells: cheap path for small moves
        return;
      }
      this.unregister(id, previous);
    }

    this.entries.set(id, { box, cells: nextCells });
    if (nextCells === null) {
      this.large.add(id);
      return;
    }
    for (let cellX = nextCells.minCellX; cellX <= nextCells.maxCellX; cellX++) {
      for (let cellY = nextCells.minCellY; cellY <= nextCells.maxCellY; cellY++) {
        const key = cellKey(cellX, cellY);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = new Set();
          this.cells.set(key, bucket);
        }
        bucket.add(id);
      }
    }
  }

  delete(id: Id): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.unregister(id, entry);
    this.entries.delete(id);
    return true;
  }

  clear(): void {
    this.cells.clear();
    this.entries.clear();
    this.large.clear();
  }

  /** Ids whose boxes intersect `box`. Each id is reported once. */
  query(box: Box): Id[] {
    validateBox(box);
    const out: Id[] = [];
    const range = this.cellRange(box);

    if (!canPack(range) || cellCount(range) > this.cells.size) {
      // Query covers more cells than exist (zoomed far out): scan entries instead.
      for (const [id, entry] of this.entries) if (boxIntersects(entry.box, box)) out.push(id);
      return out;
    }

    for (let cellX = range.minCellX; cellX <= range.maxCellX; cellX++) {
      for (let cellY = range.minCellY; cellY <= range.maxCellY; cellY++) {
        const bucket = this.cells.get(cellKey(cellX, cellY));
        if (!bucket) continue;
        for (const id of bucket) {
          const entry = this.entries.get(id)!;
          const cells = entry.cells!; // bucketed entries always have cells
          // An entry sits in every cell of its range: report it only from the first cell that
          // range shares with the query, so it is reported once without a `seen` set.
          if (
            Math.max(cells.minCellX, range.minCellX) !== cellX ||
            Math.max(cells.minCellY, range.minCellY) !== cellY
          )
            continue;
          if (boxIntersects(entry.box, box)) out.push(id);
        }
      }
    }
    for (const id of this.large) {
      if (boxIntersects(this.entries.get(id)!.box, box)) out.push(id);
    }
    return out;
  }

  queryPoint(x: number, y: number): Id[] {
    return this.query({ minX: x, minY: y, maxX: x, maxY: y });
  }

  private cellRange(box: Box): CellRange {
    const cellSize = this.cellSize;
    return {
      minCellX: Math.floor(box.minX / cellSize),
      minCellY: Math.floor(box.minY / cellSize),
      maxCellX: Math.floor(box.maxX / cellSize),
      maxCellY: Math.floor(box.maxY / cellSize),
    };
  }

  private unregister(id: Id, entry: Entry): void {
    if (entry.cells === null) {
      this.large.delete(id);
      return;
    }
    const cells = entry.cells;
    for (let cellX = cells.minCellX; cellX <= cells.maxCellX; cellX++) {
      for (let cellY = cells.minCellY; cellY <= cells.maxCellY; cellY++) {
        const key = cellKey(cellX, cellY);
        const bucket = this.cells.get(key);
        if (!bucket) continue;
        bucket.delete(id);
        if (bucket.size === 0) this.cells.delete(key);
      }
    }
  }
}
