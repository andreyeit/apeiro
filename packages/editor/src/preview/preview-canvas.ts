import type { Camera, Scene } from '@apeiro/core';
import { createRenderer, type BackendKind, type BoardRenderer } from '@apeiro/renderer';
import { applyRendererTheme, type BoardThemeColors } from '../theme/board-theme';

export interface PreviewCanvasOptions {
  /** The GPU API of the board under it (the preview uses the same one). */
  backend: BackendKind;
  /** Origins images and audio may be loaded from (see `BoardEditorOptions.mediaOrigins`). */
  mediaOrigins?: readonly string[];
  onError?: (error: unknown) => void;
}

/**
 * Draws a draft (see `DraftScene`) on its own see-through canvas over a mounted board,
 * with the board's camera. The renderer starts asynchronously; hiding the preview (or
 * showing another one) before it runs drops it.
 */
export class PreviewCanvas {
  private renderer: BoardRenderer | null = null;
  /** Bumped by every `show` and `hide`: a renderer that starts late checks it. */
  private token = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private colors: BoardThemeColors,
    private readonly options: PreviewCanvasOptions,
  ) {}

  /** Starts drawing `scene` (replacing what was shown). */
  show(scene: Scene): void {
    this.hide();
    const token = this.token;
    this.canvas.hidden = false;
    void createRenderer({
      backend: this.options.backend,
      canvas: this.canvas,
      scene,
      camera: this.camera,
      transparent: true,
      background: 0,
      gridColor: 0,
      ...(this.options.mediaOrigins
        ? { media: { allowedOrigins: this.options.mediaOrigins } }
        : {}),
    }).then(
      (renderer) => {
        if (token !== this.token) {
          renderer.destroy();
          return;
        }
        this.renderer = renderer;
        applyRendererTheme(renderer, this.colors);
        renderer.resize();
      },
      (error: unknown) => this.options.onError?.(error),
    );
  }

  /** Stops drawing and hides the canvas. */
  hide(): void {
    this.token++;
    this.renderer?.destroy();
    this.renderer = null;
    this.canvas.hidden = true;
  }

  /** The board's theme changed. */
  restyle(colors: BoardThemeColors): void {
    this.colors = colors;
    if (this.renderer) applyRendererTheme(this.renderer, colors);
  }

  /** The board's box changed size. */
  resize(): void {
    this.renderer?.resize();
  }
}
