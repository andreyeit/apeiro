import { Camera, detachEnds, isConnector, Scene, type BoardElement, type Box } from '@apeiro/core';
import { createRenderer, type AudioWidgetStyle, type GridStyle } from '@apeiro/renderer';

/** What `BoardEditor.exportImage` draws and how. */
export interface ExportImageOptions {
  /**
   * Only these elements (e.g. the selection), on their own. Default: the whole board.
   * Ignored with `area`.
   */
  ids?: Iterable<string>;
  /** A world rectangle with whatever is in it (e.g. a region the user framed). */
  area?: Box;
  /** Pixels per world unit (default 2, sharp on high-density screens); lowered to fit `maxSize`. */
  scale?: number;
  /** Margin around the content, world units (default 24; 0 with `area`). */
  padding?: number;
  /** Packed 0xRRGGBBAA background; default the board's; `'transparent'` for none. */
  background?: number | 'transparent';
  /** Draw the board grid behind (default false). */
  grid?: boolean;
  /** `image/png` (default), `image/jpeg` or `image/webp`. */
  type?: string;
  /** JPEG/WebP quality, 0–1. */
  quality?: number;
  /** Largest side of the image, pixels (default 8192); `scale` is lowered to fit. */
  maxSize?: number;
  /** How long to wait for images and text to be ready, ms (default 10 s); what's ready is drawn then. */
  timeoutMs?: number;
}

/** Where and how large the image is: the world point at its top-left, size and zoom. */
export interface ExportFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pixels per world unit. */
  zoom: number;
}

/**
 * The image of world box `bounds` with `padding` around it at `scale` pixels per unit,
 * scaled down so neither side exceeds `maxSize` pixels.
 */
export function exportFrame(bounds: Box, scale = 2, padding = 24, maxSize = 8192): ExportFrame {
  const width = Math.max(1e-6, bounds.maxX - bounds.minX + padding * 2);
  const height = Math.max(1e-6, bounds.maxY - bounds.minY + padding * 2);
  const zoom = Math.min(scale, maxSize / width, maxSize / height);
  return {
    x: bounds.minX - padding,
    y: bounds.minY - padding,
    width: Math.max(1, Math.round(width * zoom)),
    height: Math.max(1, Math.round(height * zoom)),
    zoom,
  };
}

/**
 * The elements of `ids` as a scene of their own. A connector end attached to a shape that
 * isn't exported becomes a free end where it is drawn now, so the line still shows.
 */
export function sceneOf(scene: Scene, ids: Iterable<string>): Scene {
  const picked = new Set<string>();
  for (const id of ids) if (scene.has(id)) picked.add(id);
  const exported: BoardElement[] = [];
  for (const id of picked) {
    const element = scene.get(id)!;
    exported.push(
      isConnector(element)
        ? detachEnds(element, scene.connectorGeometry(id), (shapeId) => picked.has(shapeId))
        : element,
    );
  }
  const part = new Scene();
  part.transact(() => {
    for (const element of exported) part.add(element);
  }, 'load');
  return part;
}

/** How the board draws, for an image that looks like it. */
export interface ExportLook {
  background: number;
  gridColor: number;
  gridStyle: GridStyle;
  mediaOrigins?: readonly string[];
  colorTheme: ReadonlyArray<readonly [number, number]>;
  keepTypes: Iterable<string>;
  audio: Partial<AudioWidgetStyle>;
}

/**
 * The next frame, or 50 ms if none comes first: a background tab gets no frames, and an
 * export started there must still reach its deadline instead of waiting forever.
 */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, 50);
    const frame = requestAnimationFrame(done);
    function done() {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      resolve();
    }
  });

/**
 * Draws `frame` of `scene` into an image off screen (its own canvas and camera, so the
 * user's view and selection don't show), once images and text are ready.
 */
export async function renderImage(
  scene: Scene,
  frame: ExportFrame,
  look: ExportLook,
  options: Pick<ExportImageOptions, 'type' | 'quality' | 'timeoutMs'>,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  // Laid out (the renderer sizes itself from the CSS box) but invisible and inert.
  canvas.style.cssText =
    `position:fixed;left:0;top:0;width:${frame.width}px;height:${frame.height}px;` +
    'opacity:0;pointer-events:none;z-index:-1';
  document.body.append(canvas);
  const camera = new Camera({ minZoom: 1e-9, maxZoom: 1e9 });
  try {
    await document.fonts?.ready;
    const renderer = await createRenderer({
      // WebGL with a kept drawing buffer: the frame can be read back after drawing.
      backend: 'webgl',
      preserveDrawingBuffer: true,
      canvas,
      scene,
      camera,
      pixelRatio: 1,
      transparent: true,
      background: look.background,
      gridColor: look.gridColor,
      gridStyle: look.gridStyle,
      ...(look.mediaOrigins ? { media: { allowedOrigins: look.mediaOrigins } } : {}),
    });
    try {
      renderer.setColorTheme(look.colorTheme, look.keepTypes);
      renderer.setAudioStyle(look.audio);
      renderer.resize();
      camera.set({ x: frame.x, y: frame.y, zoom: frame.zoom });
      const deadline = performance.now() + (options.timeoutMs ?? 10_000);
      renderer.render();
      while ((renderer.mediaPending || renderer.textPending) && performance.now() < deadline) {
        await nextFrame();
        renderer.render();
      }
      renderer.render();
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('apeiro: export failed'))),
          options.type ?? 'image/png',
          options.quality,
        ),
      );
    } finally {
      renderer.destroy();
    }
  } finally {
    canvas.remove();
  }
}
