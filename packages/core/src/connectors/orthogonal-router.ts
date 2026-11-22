import { inflateBox, type Box } from '../geometry/box';
import type { Vec2 } from '../geometry/vector';

/**
 * Orthogonal routing around obstacles on a sparse grid.
 *
 * Grid lines ("rulers") are the edges of the obstacles (already inflated by a margin),
 * the two stub points, the middles of gaps between the connected shapes and an outer
 * frame. A Dijkstra search over (node, heading) states finds the cheapest path with a
 * penalty per turn, never reversing and never entering an obstacle.
 *
 * Blocked nodes and edges are precomputed per obstacle from ruler index ranges, and the
 * search uses a binary heap, so dozens of obstacles stay in the low milliseconds.
 */

type Direction = 0 | 1 | 2 | 3; // +x, +y, -x, -y
const STEP_X = [1, 0, -1, 0];
const STEP_Y = [0, 1, 0, -1];

export const directionOf = (vector: Vec2): Direction =>
  Math.abs(vector.x) >= Math.abs(vector.y) ? (vector.x >= 0 ? 0 : 2) : vector.y >= 0 ? 1 : 3;

const opposite = (direction: Direction): Direction => ((direction + 2) % 4) as Direction;

export interface RouteRequest {
  /** Stub ends: the path starts at `from` heading `fromDirection` and must end at `to`. */
  from: Vec2;
  fromDirection: Direction;
  to: Vec2;
  /** Direction the path must be heading when it reaches `to` (toward the shape). */
  toDirection: Direction;
  /**
   * Obstacles: the path may run along their (inflated) edges but not inside. If an end
   * lies in an obstacle's clearance, the clearance is dropped for it (the path may pass
   * close); if an end lies inside the obstacle itself, the obstacle is ignored.
   */
  obstacles: Array<{ box: Box; margin: number }>;
  /** Boxes whose mutual gaps get a centre line (the connected shapes), for tidy routes. */
  centered?: Box[];
  /** Cost of one turn, in world units of length. */
  bendCost: number;
  /** Margin for the outer frame that lets the path go around everything. */
  margin: number;
}

const EPSILON = 1e-6;
/** Largest search grid (rulers x × rulers y); ~100 obstacles with random coordinates. */
export const MAX_GRID_NODES = 250 * 250;
const strictlyInside = (bounds: Box, x: number, y: number) =>
  x > bounds.minX + EPSILON &&
  x < bounds.maxX - EPSILON &&
  y > bounds.minY + EPSILON &&
  y < bounds.maxY - EPSILON;

function uniqueSorted(values: number[]): number[] {
  const sorted = values.slice().sort((first, second) => first - second);
  const unique: number[] = [];
  for (const value of sorted)
    if (unique.length === 0 || value - unique[unique.length - 1]! > EPSILON) unique.push(value);
  return unique;
}

/** First index whose value is greater than `value` (beyond EPSILON). */
function upperBound(array: number[], value: number): number {
  let low = 0;
  let high = array.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (array[middle]! > value + EPSILON) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** First index whose value is at least `value` (within EPSILON). */
function lowerBound(array: number[], value: number): number {
  let low = 0;
  let high = array.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (array[middle]! >= value - EPSILON) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Minimal binary heap of (cost, state). */
class Heap {
  private costs: number[] = [];
  private items: number[] = [];
  get size() {
    return this.items.length;
  }
  push(cost: number, item: number) {
    const costs = this.costs;
    const items = this.items;
    let i = items.length;
    costs.push(cost);
    items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (costs[parent]! <= cost) break;
      costs[i] = costs[parent]!;
      items[i] = items[parent]!;
      i = parent;
    }
    costs[i] = cost;
    items[i] = item;
  }
  pop(): [number, number] {
    const costs = this.costs;
    const items = this.items;
    const topCost = costs[0]!;
    const top = items[0]!;
    const lastCost = costs.pop()!;
    const last = items.pop()!;
    const count = items.length;
    if (count > 0) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        if (left >= count) break;
        const right = left + 1;
        const cheaper = right < count && costs[right]! < costs[left]! ? right : left;
        if (costs[cheaper]! >= lastCost) break;
        costs[i] = costs[cheaper]!;
        items[i] = items[cheaper]!;
        i = cheaper;
      }
      costs[i] = lastCost;
      items[i] = last;
    }
    return [topCost, top];
  }
}

/** Returns the corner points of the path from `from` to `to` (both included), or null. */
export function routeOrthogonal(request: RouteRequest): Vec2[] | null {
  const { from, to, margin } = request;
  const containsEnd = (bounds: Box) =>
    strictlyInside(bounds, from.x, from.y) || strictlyInside(bounds, to.x, to.y);
  const obstacles: Box[] = [];
  for (const { box, margin: clearance } of request.obstacles) {
    const inflated = inflateBox(box, clearance);
    if (!containsEnd(inflated)) obstacles.push(inflated);
    else if (!containsEnd(box)) obstacles.push(box);
  }

  const xValues: number[] = [from.x, to.x];
  const yValues: number[] = [from.y, to.y];
  let minX = Math.min(from.x, to.x);
  let maxX = Math.max(from.x, to.x);
  let minY = Math.min(from.y, to.y);
  let maxY = Math.max(from.y, to.y);
  for (const obstacle of obstacles) {
    xValues.push(obstacle.minX, obstacle.maxX);
    yValues.push(obstacle.minY, obstacle.maxY);
    minX = Math.min(minX, obstacle.minX);
    maxX = Math.max(maxX, obstacle.maxX);
    minY = Math.min(minY, obstacle.minY);
    maxY = Math.max(maxY, obstacle.maxY);
  }
  const centered = request.centered ?? [];
  for (const first of centered) {
    for (const second of centered) {
      if (first.maxX < second.minX) xValues.push((first.maxX + second.minX) / 2);
      if (first.maxY < second.minY) yValues.push((first.maxY + second.minY) / 2);
    }
  }
  xValues.push(minX - margin, maxX + margin);
  yValues.push(minY - margin, maxY + margin);

  const gridX = uniqueSorted(xValues);
  const gridY = uniqueSorted(yValues);
  const gridWidth = gridX.length;
  const gridHeight = gridY.length;
  // Memory and time grow with width × height: refuse instead of freezing (callers fall back).
  if (gridWidth * gridHeight > MAX_GRID_NODES) return null;

  // Precompute blocked nodes and edges from each obstacle's ruler index ranges.
  const nodeBlocked = new Uint8Array(gridWidth * gridHeight);
  const horizontalBlocked = new Uint8Array(gridWidth * gridHeight); // edge (i, j) → (i + 1, j)
  const verticalBlocked = new Uint8Array(gridWidth * gridHeight); // edge (i, j) → (i, j + 1)
  for (const obstacle of obstacles) {
    // Rulers strictly inside the obstacle on each axis.
    const insideMinI = upperBound(gridX, obstacle.minX);
    const insideMaxI = lowerBound(gridX, obstacle.maxX) - 1;
    const insideMinJ = upperBound(gridY, obstacle.minY);
    const insideMaxJ = lowerBound(gridY, obstacle.maxY) - 1;
    // Rulers on or inside the edges (edge intervals between them are inside the box).
    const edgeMinI = lowerBound(gridX, obstacle.minX);
    const edgeMaxI = upperBound(gridX, obstacle.maxX) - 1;
    const edgeMinJ = lowerBound(gridY, obstacle.minY);
    const edgeMaxJ = upperBound(gridY, obstacle.maxY) - 1;
    for (let j = insideMinJ; j <= insideMaxJ; j++) {
      for (let i = insideMinI; i <= insideMaxI; i++) nodeBlocked[j * gridWidth + i] = 1;
      for (let i = edgeMinI; i < edgeMaxI; i++) horizontalBlocked[j * gridWidth + i] = 1;
    }
    for (let i = insideMinI; i <= insideMaxI; i++) {
      for (let j = edgeMinJ; j < edgeMaxJ; j++) verticalBlocked[j * gridWidth + i] = 1;
    }
  }
  const passable = (i: number, j: number, direction: Direction): boolean => {
    const nextI = i + STEP_X[direction]!;
    const nextJ = j + STEP_Y[direction]!;
    if (
      nextI < 0 ||
      nextI >= gridWidth ||
      nextJ < 0 ||
      nextJ >= gridHeight ||
      nodeBlocked[nextJ * gridWidth + nextI]
    )
      return false;
    if (direction === 0) return !horizontalBlocked[j * gridWidth + i];
    if (direction === 2) return !horizontalBlocked[j * gridWidth + nextI];
    if (direction === 1) return !verticalBlocked[j * gridWidth + i];
    return !verticalBlocked[nextJ * gridWidth + i];
  };

  const startI = lowerBound(gridX, from.x);
  const startJ = lowerBound(gridY, from.y);
  const targetI = lowerBound(gridX, to.x);
  const targetJ = lowerBound(gridY, to.y);

  const stateCount = gridWidth * gridHeight * 4;
  const costs = new Float64Array(stateCount).fill(Infinity);
  const previous = new Int32Array(stateCount).fill(-1);
  const heap = new Heap();
  const start = (startJ * gridWidth + startI) * 4 + request.fromDirection;
  costs[start] = 0;
  heap.push(0, start);

  let goal = -1;
  let goalCost = Infinity;
  while (heap.size > 0) {
    const [cost, state] = heap.pop();
    if (cost > costs[state]! || cost >= goalCost) continue;
    const direction = (state % 4) as Direction;
    const node = (state - direction) / 4;
    const i = node % gridWidth;
    const j = (node - i) / gridWidth;
    if (i === targetI && j === targetJ && direction !== opposite(request.toDirection)) {
      // Arriving heading the wrong way costs a final turn (reversing is not allowed at all).
      const total = cost + (direction === request.toDirection ? 0 : request.bendCost);
      if (total < goalCost) {
        goalCost = total;
        goal = state;
      }
    }
    for (
      let nextDirection = 0 as Direction;
      nextDirection < 4;
      nextDirection = (nextDirection + 1) as Direction
    ) {
      if (nextDirection === opposite(direction) || !passable(i, j, nextDirection)) continue;
      const nextI = i + STEP_X[nextDirection]!;
      const nextJ = j + STEP_Y[nextDirection]!;
      const next =
        cost +
        Math.abs(gridX[nextI]! - gridX[i]!) +
        Math.abs(gridY[nextJ]! - gridY[j]!) +
        (nextDirection === direction ? 0 : request.bendCost);
      const nextState = (nextJ * gridWidth + nextI) * 4 + nextDirection;
      if (next < costs[nextState]!) {
        costs[nextState] = next;
        previous[nextState] = state;
        heap.push(next, nextState);
      }
    }
  }
  if (goal < 0) return null;

  const path: Vec2[] = [];
  for (let state = goal; state >= 0; state = previous[state]!) {
    const node = (state - (state % 4)) / 4;
    const i = node % gridWidth;
    path.push({ x: gridX[i]!, y: gridY[(node - i) / gridWidth]! });
  }
  return path.reverse();
}
