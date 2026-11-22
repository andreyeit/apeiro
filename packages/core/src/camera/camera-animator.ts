import type { Camera, CameraState } from './camera';
import type { Box } from '../geometry/box';
import { clamp } from '../geometry/numbers';
import type { Vec2 } from '../geometry/vector';

export interface FrameScheduler {
  request(callback: (now: number) => void): number;
  cancel(handle: number): void;
}

const defaultScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface CameraAnimatorOptions {
  /** Time for the camera to cover half the remaining distance. Smaller = snappier. */
  halfLifeMs?: number;
  scheduler?: FrameScheduler;
}

/**
 * Smooth camera on top of `Camera`. When `enabled`, zoom/pan requests move a target
 * and the camera eases toward it each frame (exponential smoothing, frame-rate
 * independent). When disabled, requests apply immediately, so callers can always
 * go through the animator.
 *
 * Zoom keeps the world point under the zoom anchor fixed during the whole animation,
 * not only at the end, so zooming at the cursor doesn't "swim".
 */
export class CameraAnimator {
  enabled = false;
  halfLifeMs: number;
  private target: CameraState | null = null;
  /** Screen point that stays fixed while zooming. */
  private anchor: Vec2 = { x: 0, y: 0 };
  private frame = 0;
  private lastFrameTime = 0;
  private readonly scheduler: FrameScheduler;

  constructor(
    private readonly camera: Camera,
    options: CameraAnimatorOptions = {},
  ) {
    this.halfLifeMs = options.halfLifeMs ?? 80;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get animating(): boolean {
    return this.target !== null;
  }

  /** Zooms by `factor` around a screen point. */
  zoomAt(anchor: Vec2, factor: number): void {
    if (!this.enabled) {
      this.camera.zoomAt(anchor, this.camera.zoom * factor);
      return;
    }
    const from = this.target ?? this.camera.getState();
    const zoom = clamp(from.zoom * factor, this.camera.minZoom, this.camera.maxZoom);
    // World point under the anchor in the target state stays under the anchor.
    const worldX = from.x + anchor.x / from.zoom;
    const worldY = from.y + anchor.y / from.zoom;
    this.anchor = anchor;
    this.animate({ zoom, x: worldX - anchor.x / zoom, y: worldY - anchor.y / zoom });
  }

  /** Moves the view by a screen-space delta. */
  panBy(deltaX: number, deltaY: number): void {
    if (!this.enabled) {
      this.camera.panBy(deltaX, deltaY);
      return;
    }
    const from = this.target ?? this.camera.getState();
    this.animate({ ...from, x: from.x - deltaX / from.zoom, y: from.y - deltaY / from.zoom });
  }

  /**
   * Continues a released drag with its velocity (screen px per second), decaying
   * smoothly. The distance matches the velocity at release for this half-life.
   */
  fling(velocityX: number, velocityY: number): void {
    if (!this.enabled) return;
    const timeConstant = this.halfLifeMs / 1000 / Math.LN2; // of the decay, seconds
    if (Math.hypot(velocityX, velocityY) * timeConstant < 2) return; // not worth a frame
    this.panBy(velocityX * timeConstant, velocityY * timeConstant);
  }

  /** Moves to a state (animated when enabled). */
  animateTo(state: Partial<CameraState>, anchor?: Vec2): void {
    const current = this.camera.getState();
    const next = { ...current, ...state };
    if (!this.enabled) {
      this.camera.set(next);
      return;
    }
    this.anchor = anchor ?? { x: this.camera.viewportWidth / 2, y: this.camera.viewportHeight / 2 };
    this.animate(next);
  }

  /** Fits a world box into the viewport (animated when enabled). */
  fitBox(box: Box, padding = 32): void {
    this.animateTo(this.camera.fitState(box, padding));
  }

  /** Stops where the camera is now (e.g. when the user grabs the canvas). */
  stop(): void {
    this.target = null;
    if (this.frame) this.scheduler.cancel(this.frame);
    this.frame = 0;
  }

  /** Advances the animation by `elapsedMs`. Exposed for tests; normally driven by the scheduler. */
  step(elapsedMs: number): void {
    const target = this.target;
    if (!target) return;
    const current = this.camera.getState();
    const blend = 1 - Math.pow(0.5, elapsedMs / this.halfLifeMs);
    const zoom = Math.exp(
      Math.log(current.zoom) + (Math.log(target.zoom) - Math.log(current.zoom)) * blend,
    );
    // Interpolate the world point under the anchor, then place the camera so it stays there.
    const anchor = this.anchor;
    const worldX = current.x + anchor.x / current.zoom;
    const worldY = current.y + anchor.y / current.zoom;
    const targetWorldX = target.x + anchor.x / target.zoom;
    const targetWorldY = target.y + anchor.y / target.zoom;
    const nextWorldX = worldX + (targetWorldX - worldX) * blend;
    const nextWorldY = worldY + (targetWorldY - worldY) * blend;
    let next = { zoom, x: nextWorldX - anchor.x / zoom, y: nextWorldY - anchor.y / zoom };
    // Close enough (sub-pixel on screen): land exactly.
    const done =
      Math.abs(Math.log(target.zoom / zoom)) < 1e-4 &&
      Math.abs(next.x - target.x) * zoom < 0.25 &&
      Math.abs(next.y - target.y) * zoom < 0.25;
    if (done) {
      next = target;
      this.target = null;
    }
    this.camera.set(next);
  }

  private animate(requested: CameraState): void {
    // The camera clamps zoom; an unreachable target would keep the animation running forever.
    if (![requested.x, requested.y, requested.zoom].every(Number.isFinite) || requested.zoom <= 0)
      return;
    const zoom = clamp(requested.zoom, this.camera.minZoom, this.camera.maxZoom);
    let target = requested;
    if (zoom !== requested.zoom) {
      // Keep the world point under the anchor where the requested state would have put it.
      const anchor = this.anchor;
      const worldX = requested.x + anchor.x / requested.zoom;
      const worldY = requested.y + anchor.y / requested.zoom;
      target = { zoom, x: worldX - anchor.x / zoom, y: worldY - anchor.y / zoom };
    }
    this.target = target;
    if (this.frame) return;
    this.lastFrameTime = 0;
    const tick = (now: number) => {
      this.frame = 0;
      const elapsed = this.lastFrameTime ? Math.min(now - this.lastFrameTime, 64) : 16;
      this.lastFrameTime = now;
      this.step(elapsed);
      if (this.target) this.frame = this.scheduler.request(tick);
    };
    this.frame = this.scheduler.request(tick);
  }
}
