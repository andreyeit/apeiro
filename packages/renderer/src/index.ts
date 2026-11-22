// The renderer: draws a scene through a camera with WebGPU or WebGL2.
export {
  BoardRenderer,
  createRenderer,
  type CreateRendererOptions,
  type GridStyle,
  type RendererOptions,
  type RenderStats,
} from './renderer';
export type { BackendKind } from './backend';
export type { TextLayerOptions } from './layers/text-layer';
export type { MediaPassOptions } from './media/media-pass';

// Pieces the editor shares with the renderer.
export { CanvasSize, MAX_PIXEL_RATIO, type CanvasMetrics } from './canvas-size';
export { ColorTheme } from './color-theme';
export { CanvasFontMeasurer, cssFont } from './text/font';
export {
  DEFAULT_AUDIO_STYLE,
  drawAudioWidget,
  formatAudioTime,
  type AudioCard,
  type AudioVisualState,
  type AudioWidgetStyle,
} from './media/audio-widget';
