/** A canvas's size on the page and the drawing buffer that matches it. */
export interface CanvasMetrics {
  /** CSS size (may be fractional). */
  cssWidth: number;
  cssHeight: number;
  /** Drawing buffer size, device pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** Device pixels per CSS pixel actually used: `pixelWidth / cssWidth`. */
  ratio: number;
}

/**
 * Keeps track of the exact number of device pixels a canvas covers, so its drawing buffer
 * maps 1:1 onto the screen and nothing gets resampled (blurred).
 *
 * `clientWidth * devicePixelRatio` is not enough: `clientWidth` is rounded to whole CSS
 * pixels and fractional ratios (125 %, 150 % screen scaling, browser zoom) land between
 * device pixels, so the browser stretches the buffer by a fraction of a pixel. The
 * `device-pixel-content-box` of a ResizeObserver reports the real size; browsers without
 * it (Safari) fall back to the computed one.
 *
 * The CSS size and the device size are watched by separate observers: an observer fires only
 * when the box it watches changes, and each can change alone. Browser zoom keeps the window's
 * device pixels (the device box stays the same) while the CSS size changes; moving to a screen
 * with another ratio does the opposite. One observer on the device box missed the zoom: the
 * board was then drawn for the old CSS size, smaller or larger than the page around it.
 */
export class CanvasSize {
  private observers: ResizeObserver[] = [];
  private css: { width: number; height: number } | null = null;
  private device: { width: number; height: number } | null = null;

  /**
   * @param onChange called when the size or the pixel ratio changed (also when the window
   *   moves to a screen with another ratio).
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    onChange: () => void,
  ) {
    if (typeof ResizeObserver === 'undefined') return;
    const cssObserver = new ResizeObserver(([entry]) => {
      const box = entry?.contentBoxSize?.[0];
      if (!box) return;
      this.css = { width: box.inlineSize, height: box.blockSize };
      onChange();
    });
    cssObserver.observe(canvas);
    this.observers.push(cssObserver);
    const deviceObserver = new ResizeObserver(([entry]) => {
      const box = entry?.devicePixelContentBoxSize?.[0];
      if (!box) return;
      this.device = { width: box.inlineSize, height: box.blockSize };
      onChange();
    });
    try {
      deviceObserver.observe(canvas, { box: 'device-pixel-content-box' });
      this.observers.push(deviceObserver);
    } catch {
      // No device-pixel-content-box (Safari): the buffer size is computed from the CSS size.
    }
  }

  /**
   * The canvas's size now and the buffer to draw into, for a pixel ratio of at most
   * `maxRatio`, or exactly `fixedRatio` (e.g. 1 for an export).
   */
  measure(maxRatio: number, fixedRatio: number | null = null): CanvasMetrics {
    const cssWidth = this.css?.width ?? this.canvas.clientWidth;
    const cssHeight = this.css?.height ?? this.canvas.clientHeight;
    const screen = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const ratio = fixedRatio ?? Math.min(screen, maxRatio);
    // The screen's own pixels when they are what we draw at (not capped, not fixed).
    const exact = this.device && fixedRatio === null && screen <= maxRatio + 1e-6;
    const pixelWidth = Math.max(1, exact ? this.device!.width : Math.round(cssWidth * ratio));
    const pixelHeight = Math.max(1, exact ? this.device!.height : Math.round(cssHeight * ratio));
    return {
      cssWidth,
      cssHeight,
      pixelWidth,
      pixelHeight,
      ratio: cssWidth > 0 ? pixelWidth / cssWidth : ratio,
    };
  }

  /** Sets the canvas's drawing buffer to the measured size; true if it changed. */
  apply(metrics: CanvasMetrics): boolean {
    if (this.canvas.width === metrics.pixelWidth && this.canvas.height === metrics.pixelHeight)
      return false;
    this.canvas.width = metrics.pixelWidth;
    this.canvas.height = metrics.pixelHeight;
    return true;
  }

  dispose(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
  }
}

/** Default cap of the pixel ratio: the screen's own up to 3x (phones), not more. */
export const MAX_PIXEL_RATIO = 3;
