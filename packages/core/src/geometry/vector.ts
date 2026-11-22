export interface Vec2 {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });

export const subtract = (from: Vec2, amount: Vec2): Vec2 => ({
  x: from.x - amount.x,
  y: from.y - amount.y,
});

export const midpoint = (first: Vec2, second: Vec2): Vec2 => ({
  x: (first.x + second.x) / 2,
  y: (first.y + second.y) / 2,
});

export const vectorLength = (vector: Vec2): number => Math.hypot(vector.x, vector.y);

export const distance = (first: Vec2, second: Vec2): number =>
  Math.hypot(first.x - second.x, first.y - second.y);

/** The unit vector along `vector`; +x for a zero vector. */
export function normalize(vector: Vec2): Vec2 {
  const length = vectorLength(vector);
  return length > 1e-9 ? { x: vector.x / length, y: vector.y / length } : { x: 1, y: 0 };
}

/** `vector` rotated by `angle` radians (clockwise on screen, y down). */
export function rotateVector(vector: Vec2, angle: number): Vec2 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { x: vector.x * cosine - vector.y * sine, y: vector.x * sine + vector.y * cosine };
}

/** Rotates `point` around `origin` by `angle` radians. */
export function rotateAround(point: Vec2, origin: Vec2, angle: number): Vec2 {
  if (angle === 0) return { x: point.x, y: point.y };
  const rotated = rotateVector(subtract(point, origin), angle);
  return { x: origin.x + rotated.x, y: origin.y + rotated.y };
}

/** Distance from `point` to the segment from `start` to `end`. */
export function distanceToSegment(point: Vec2, start: Vec2, end: Vec2): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const fraction =
    lengthSquared > 0
      ? Math.max(
          0,
          Math.min(
            1,
            ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared,
          ),
        )
      : 0;
  return Math.hypot(
    point.x - (start.x + deltaX * fraction),
    point.y - (start.y + deltaY * fraction),
  );
}
