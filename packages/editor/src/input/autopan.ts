import type { Vec2 } from '@apeiro/core';
import { AUTOPAN_EDGE_PX, AUTOPAN_MAX_SPEED } from './constants';
import type { InputContext } from './context';
import { isMovingMode } from './modes';

/**
 * Scrolls the board while a gesture drags near the viewport edges, faster the closer the
 * pointer is to the edge. `onStep` re-applies the gesture: the world under the pointer moved.
 */
export class AutoPan {
  private frame = 0;
  private lastFrameTime = 0;

  constructor(
    private readonly context: InputContext,
    private readonly onStep: (point: Vec2) => void,
  ) {}

  /** Starts panning if the pointer is at an edge during a moving gesture. */
  maybeStart(point: Vec2): void {
    if (this.frame || !isMovingMode(this.context.mode)) return;
    const vector = this.velocity(point);
    if (vector.x === 0 && vector.y === 0) return;
    this.lastFrameTime = 0;
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private readonly tick = (now: number): void => {
    this.frame = 0;
    const { pointer } = this.context;
    if (!pointer || !isMovingMode(this.context.mode)) return;
    const vector = this.velocity(pointer);
    if (vector.x === 0 && vector.y === 0) return;
    const elapsed = this.lastFrameTime ? Math.min(now - this.lastFrameTime, 50) / 1000 : 1 / 60;
    this.lastFrameTime = now;
    this.context.camera.panBy(-vector.x * elapsed, -vector.y * elapsed);
    this.onStep(pointer);
    this.frame = requestAnimationFrame(this.tick);
  };

  /** Pan speed (screen px per second) for a pointer at `point`. */
  private velocity(point: Vec2): Vec2 {
    const rectangle = this.context.element.getBoundingClientRect();
    if (rectangle.width <= AUTOPAN_EDGE_PX * 2 || rectangle.height <= AUTOPAN_EDGE_PX * 2)
      return { x: 0, y: 0 };
    const axis = (position: number, size: number) => {
      if (position < AUTOPAN_EDGE_PX) return -((AUTOPAN_EDGE_PX - position) / AUTOPAN_EDGE_PX);
      if (position > size - AUTOPAN_EDGE_PX)
        return (position - (size - AUTOPAN_EDGE_PX)) / AUTOPAN_EDGE_PX;
      return 0;
    };
    const speed = (overshoot: number) =>
      Math.sign(overshoot) * Math.min(1, Math.abs(overshoot)) ** 2 * AUTOPAN_MAX_SPEED;
    return { x: speed(axis(point.x, rectangle.width)), y: speed(axis(point.y, rectangle.height)) };
  }
}
