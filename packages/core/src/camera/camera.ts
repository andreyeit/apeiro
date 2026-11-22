import type { Box } from '../geometry/box';
import { clamp } from '../geometry/numbers';
import type { Vec2 } from '../geometry/vector';

export interface CameraState {
  /** World coordinate shown at the top-left corner of the viewport. */
  x: number;
  y: number;
  /** Screen pixels per world unit. */
  zoom: number;
}

export interface CameraOptions {
  minZoom?: number;
  maxZoom?: number;
  /** Zoom-in multiplier; zoom-out uses its reciprocal. Must be >= 1. Default 1.25. */
  zoomStep?: number;
  /** Wheel/pinch sensitivity multiplier. Must be > 0. Default 1. */
  wheelZoomSensitivity?: number;
}

type Listener = (state: Readonly<CameraState>) => void;

/**
 * Maps between screen space (CSS pixels relative to the viewport) and world space.
 * Holds no DOM references; the host reports the viewport size via `setViewport`.
 */
export class Camera {
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly zoomStep: number;
  readonly wheelZoomSensitivity: number;
  private state: CameraState = { x: 0, y: 0, zoom: 1 };
  private width = 0;
  private height = 0;
  private listeners = new Set<Listener>();

  constructor(options: CameraOptions = {}) {
    this.minZoom = options.minZoom ?? 0.01;
    this.maxZoom = options.maxZoom ?? 64;
    this.zoomStep = options.zoomStep ?? 1.25;
    this.wheelZoomSensitivity = options.wheelZoomSensitivity ?? 1;
    if (!(this.minZoom > 0) || !(this.maxZoom >= this.minZoom) || !Number.isFinite(this.maxZoom))
      throw new Error(`Invalid zoom range ${this.minZoom}..${this.maxZoom}`);
    if (!Number.isFinite(this.zoomStep) || this.zoomStep < 1)
      throw new Error('zoomStep must be finite and at least 1');
    if (!Number.isFinite(this.wheelZoomSensitivity) || this.wheelZoomSensitivity <= 0)
      throw new Error('wheelZoomSensitivity must be finite and greater than 0');
  }

  get x(): number {
    return this.state.x;
  }
  get y(): number {
    return this.state.y;
  }
  get zoom(): number {
    return this.state.zoom;
  }
  get viewportWidth(): number {
    return this.width;
  }
  get viewportHeight(): number {
    return this.height;
  }

  getState(): Readonly<CameraState> {
    return this.state;
  }

  setViewport(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.emit();
  }

  set(next: Partial<CameraState>): void {
    const zoom = clamp(next.zoom ?? this.state.zoom, this.minZoom, this.maxZoom);
    const x = next.x ?? this.state.x;
    const y = next.y ?? this.state.y;
    // A NaN/Infinity state would poison every later transform: ignore such requests.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return;
    if (x === this.state.x && y === this.state.y && zoom === this.state.zoom) return;
    this.state = { x, y, zoom };
    this.emit();
  }

  /** Moves the view by a screen-space delta (e.g. a drag of the background). */
  panBy(screenDeltaX: number, screenDeltaY: number): void {
    this.set({
      x: this.state.x - screenDeltaX / this.state.zoom,
      y: this.state.y - screenDeltaY / this.state.zoom,
    });
  }

  /** Sets zoom while keeping the world point under `anchor` (screen space) fixed. */
  zoomAt(anchor: Vec2, zoom: number): void {
    const target = clamp(zoom, this.minZoom, this.maxZoom);
    const world = this.screenToWorld(anchor);
    this.set({ zoom: target, x: world.x - anchor.x / target, y: world.y - anchor.y / target });
  }

  /** Fits `box` into the viewport with `padding` screen pixels on each side. */
  fitBox(box: Box, padding = 32): void {
    this.set(this.fitState(box, padding));
  }

  /** Camera state that fits `box` into the viewport, without applying it. */
  fitState(box: Box, padding = 32): CameraState {
    const width = Math.max(box.maxX - box.minX, 1e-6);
    const height = Math.max(box.maxY - box.minY, 1e-6);
    const availableWidth = Math.max(this.width - padding * 2, 1);
    const availableHeight = Math.max(this.height - padding * 2, 1);
    const zoom = clamp(
      Math.min(availableWidth / width, availableHeight / height),
      this.minZoom,
      this.maxZoom,
    );
    const centerX = (box.minX + box.maxX) / 2;
    const centerY = (box.minY + box.maxY) / 2;
    return { zoom, x: centerX - this.width / 2 / zoom, y: centerY - this.height / 2 / zoom };
  }

  screenToWorld(point: Vec2): Vec2 {
    return {
      x: this.state.x + point.x / this.state.zoom,
      y: this.state.y + point.y / this.state.zoom,
    };
  }

  worldToScreen(point: Vec2): Vec2 {
    return {
      x: (point.x - this.state.x) * this.state.zoom,
      y: (point.y - this.state.y) * this.state.zoom,
    };
  }

  /** Visible world rectangle. */
  viewportBounds(): Box {
    return {
      minX: this.state.x,
      minY: this.state.y,
      maxX: this.state.x + this.width / this.state.zoom,
      maxY: this.state.y + this.height / this.state.zoom,
    };
  }

  /** Subscribes to camera changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
