import { hexColor } from '@apeiro/core';
import type { AudioWidgetStyle, BoardRenderer, GridStyle } from '@apeiro/renderer';

export type BoardThemeName = 'light' | 'dark';

/** The board's grid: dots, lines or none. */
export type BoardGrid = GridStyle | 'none';

/**
 * Colors drawn in place of stored ones in the dark theme: [stored, drawn] pairs of 0xRRGGBB.
 * The stored colors (and so the document shared with others) stay the same; sticky notes
 * keep their colors.
 */
export const DARK_BOARD_COLORS: ReadonlyArray<readonly [number, number]> = [
  [0xffffff, 0x0e0e10],
  [0x18181b, 0xf4f4f5],
  [0xf4f4f5, 0x1c1c1f],
  [0x71717a, 0xa1a1aa],
  [0x1f2937, 0xf4f4f5],
];

/** Element types drawn with their stored colors in every theme. */
export const THEME_KEEP_TYPES = ['sticky'] as const;

/** color/accent-solid of the design: selection, handles, hover (see `Overlay.accent`). */
export const SELECTION_COLOR = '#2563eb';
/** The accent on a dark board. */
export const SELECTION_COLOR_DARK = '#4f8bff';
/** Inside of handles: color/background of the design, light and dark. */
export const HANDLE_FILL = '#ffffff';
export const HANDLE_FILL_DARK = '#0e0e10';

/** Opacity of the board grid, 0..1. */
const GRID_ALPHA = 0.5;

const withAlpha = (color: number, alpha: number) =>
  ((color & 0xffffff00) | Math.round(alpha * 255)) >>> 0;

/** Everything a theme changes in how the board is drawn (the same as the default CSS tokens). */
export interface BoardThemeColors {
  background: number;
  gridColor: number;
  audio: Partial<AudioWidgetStyle>;
  /** [stored, drawn] pairs the renderer draws in place of stored colors (see `ColorTheme`). */
  colorTheme: ReadonlyArray<readonly [number, number]>;
  /** The overlay's selection, handle and hover color, and the inside of its handles. */
  accent: string;
  handleFill: string;
}

/** Backdrop, grid, element, overlay and audio player colors of a theme. */
export function boardThemeColors(theme: BoardThemeName): BoardThemeColors {
  const dark = theme === 'dark';
  return {
    background: hexColor(dark ? '#121214' : '#f6f6f7'),
    gridColor: withAlpha(hexColor(dark ? '#2a2a2e' : '#e4e4e7'), GRID_ALPHA),
    audio: {
      primary: dark ? '#fafafa' : '#18181b',
      primaryForeground: dark ? '#18181b' : '#fafafa',
      track: dark ? '#3f3f46' : '#d4d4d8',
      ink: dark ? '#a1a1aa' : '#71717a',
    },
    colorTheme: dark ? DARK_BOARD_COLORS : [],
    accent: dark ? SELECTION_COLOR_DARK : SELECTION_COLOR,
    handleFill: dark ? HANDLE_FILL_DARK : HANDLE_FILL,
  };
}

/** How a renderer draws the board's grid: `none` keeps a style but makes the grid transparent. */
export function gridBackdrop(
  grid: BoardGrid,
  colors: BoardThemeColors,
): { gridStyle: GridStyle; gridColor: number } {
  return grid === 'none'
    ? { gridStyle: 'dots', gridColor: 0 }
    : { gridStyle: grid, gridColor: colors.gridColor };
}

/** Draws the elements and audio players of `renderer` in the theme's colors. */
export function applyRendererTheme(renderer: BoardRenderer, colors: BoardThemeColors): void {
  renderer.setColorTheme(colors.colorTheme, THEME_KEEP_TYPES);
  renderer.setAudioStyle(colors.audio);
}
