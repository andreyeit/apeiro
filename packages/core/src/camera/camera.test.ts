import { describe, expect, test } from 'vitest';
import { Camera, CameraAnimator, type FrameScheduler } from '../index';

/** Runs frames by hand, 16 ms apart. */
function manualScheduler() {
  let pending: ((now: number) => void) | null = null;
  let now = 0;
  const scheduler: FrameScheduler = {
    request(callback) {
      pending = callback;
      return 1;
    },
    cancel() {
      pending = null;
    },
  };
  const run = (frames: number) => {
    for (let frame = 0; frame < frames && pending; frame++) {
      const callback = pending;
      pending = null;
      now += 16;
      callback(now);
    }
  };
  return { scheduler, run, idle: () => pending === null };
}

describe('Camera', () => {
  test('maps between screen and world', () => {
    const camera = new Camera();
    camera.setViewport(800, 600);
    camera.set({ x: 100, y: 50, zoom: 2 });
    expect(camera.screenToWorld({ x: 20, y: 10 })).toEqual({ x: 110, y: 55 });
    expect(camera.worldToScreen({ x: 110, y: 55 })).toEqual({ x: 20, y: 10 });
    expect(camera.viewportBounds()).toEqual({ minX: 100, minY: 50, maxX: 500, maxY: 350 });
  });

  test('zooms around an anchor, clamps zoom and ignores non-finite states', () => {
    const camera = new Camera({ minZoom: 0.5, maxZoom: 4 });
    camera.setViewport(400, 400);
    const before = camera.screenToWorld({ x: 100, y: 100 });
    camera.zoomAt({ x: 100, y: 100 }, 2);
    const after = camera.screenToWorld({ x: 100, y: 100 });
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    camera.set({ zoom: 100 });
    expect(camera.zoom).toBe(4);
    camera.set({ x: Number.NaN });
    expect(Number.isFinite(camera.x)).toBe(true);
    expect(() => new Camera({ minZoom: 2, maxZoom: 1 })).toThrow();
  });

  test('fits a box and pans by screen deltas', () => {
    const camera = new Camera();
    camera.setViewport(200, 100);
    camera.fitBox({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 0);
    expect(camera.zoom).toBe(1);
    expect(camera.x).toBe(-50);
    camera.panBy(10, 0);
    expect(camera.x).toBe(-60);
  });

  test('notifies subscribers once per change', () => {
    const camera = new Camera();
    let calls = 0;
    const unsubscribe = camera.subscribe(() => calls++);
    camera.set({ x: 1 });
    camera.set({ x: 1 });
    unsubscribe();
    camera.set({ x: 2 });
    expect(calls).toBe(1);
  });
});

describe('CameraAnimator', () => {
  test('applies requests at once while disabled', () => {
    const camera = new Camera();
    camera.setViewport(100, 100);
    const animator = new CameraAnimator(camera);
    animator.panBy(10, 0);
    expect(camera.x).toBe(-10);
  });

  test('eases toward the target and lands on it', () => {
    const camera = new Camera();
    camera.setViewport(100, 100);
    const { scheduler, run, idle } = manualScheduler();
    const animator = new CameraAnimator(camera, { scheduler });
    animator.enabled = true;
    animator.zoomAt({ x: 50, y: 50 }, 2);
    expect(animator.animating).toBe(true);
    run(3);
    expect(camera.zoom).toBeGreaterThan(1);
    expect(camera.zoom).toBeLessThan(2);
    run(200);
    expect(idle()).toBe(true);
    expect(camera.zoom).toBe(2);
    // The anchor kept its world point.
    expect(camera.screenToWorld({ x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
  });

  test('stop leaves the camera where it is', () => {
    const camera = new Camera();
    const { scheduler, run } = manualScheduler();
    const animator = new CameraAnimator(camera, { scheduler });
    animator.enabled = true;
    animator.panBy(100, 0);
    run(2);
    const x = camera.x;
    animator.stop();
    run(10);
    expect(camera.x).toBe(x);
    expect(animator.animating).toBe(false);
  });
});
