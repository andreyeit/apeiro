/**
 * Font families text can use. Elements store the `id`; renderers and the DOM editor
 * resolve it to the same CSS family, so measuring, drawing and editing agree.
 * The first family is the default (and the fallback for unknown ids from the network).
 * The app loads the font files (`@font-face`); until then the CSS fallbacks are drawn.
 */
export interface FontFamily {
  /** Stored in documents. */
  id: string;
  /** Shown in the text toolbar. */
  label: string;
  /** CSS `font-family`, emoji fonts last so color glyphs resolve the same everywhere. */
  css: string;
}

const EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';

export const FONT_FAMILIES: readonly FontFamily[] = [
  {
    id: 'geist',
    label: 'Geist',
    css: `Geist, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif, ${EMOJI}`,
  },
  {
    id: 'inter',
    label: 'Inter',
    css: `Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif, ${EMOJI}`,
  },
  {
    id: 'serif',
    label: 'PT Serif',
    css: `"PT Serif", Georgia, "Times New Roman", serif, ${EMOJI}`,
  },
  {
    id: 'mono',
    label: 'JetBrains Mono',
    css: `"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace, ${EMOJI}`,
  },
  { id: 'hand', label: 'Caveat', css: `Caveat, "Comic Sans MS", cursive, ${EMOJI}` },
];

/** Index of a family in `FONT_FAMILIES`; unknown or missing ids are the default (0). */
export function fontIndex(id: string | undefined): number {
  if (id === undefined) return 0;
  const index = FONT_FAMILIES.findIndex((family) => family.id === id);
  return index < 0 ? 0 : index;
}

export const fontFamily = (id: string | undefined): FontFamily => FONT_FAMILIES[fontIndex(id)]!;
