import type { ElementPatch, ShapeElement, ShapeKind } from '../elements/element';
import { rotateVector } from '../geometry/vector';
import { fontIndex } from './fonts';
import { layoutText, type FontMeasurer } from './layout';
import { normalizeRuns } from './rich-text';
import { LINE_HEIGHT, textBlock, type TextBlock, type TextSizing } from './text-block';

/** Color of new text (the design's color/foreground). */
const TEXT_COLOR = 0x18181bff;

/** Font size of new free text boxes and of new shapes' labels. */
export const DEFAULT_TEXT_SIZE = 16;
/** Text of a new sticky: large, as in Miro; longer text shrinks to fit the note. */
export const STICKY_TEXT_SIZE = 28;
export const MIN_FONT_SIZE = 1;
export const MAX_FONT_SIZE = 1000;
/** Font sizes offered in pickers (Figma/Miro-like steps). */
export const FONT_SIZES: readonly number[] = [
  10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96, 128, 144, 200, 288,
];

/** A text box too narrow to see or click stays this wide (in font sizes). */
const MIN_WIDTH_EM = 0.5;
/** Far wider than any line: "no wrapping" for auto-width text. */
const UNBOUNDED = 1e7;

/**
 * How the box of a frameless `text` element follows its text, like Figma's resizing modes:
 * `auto-width` grows sideways and never wraps, `auto-height` keeps the width and grows
 * down, `fixed` never changes. Other shapes keep their size (stickies shrink the font).
 */
export function textSizing(
  element: ShapeElement,
  block: TextBlock | undefined = element.text,
): TextSizing {
  return element.type === 'text' ? (block?.sizing ?? 'fixed') : 'fixed';
}

/** Text of a shape that has none yet, styled for its kind (what typing into it starts with). */
export function defaultTextBlock(type: ShapeKind): TextBlock {
  if (type === 'text')
    return textBlock('', {
      fontSize: DEFAULT_TEXT_SIZE,
      color: TEXT_COLOR,
      align: 'left',
      verticalAlign: 'top',
      sizing: 'auto-width',
    });
  // A shape is labelled in the middle, as big as free text. A sticky, as in Miro, has an
  // automatic size: a few words fill the note, longer text gets smaller (autoFit + autoGrow).
  return textBlock('', {
    fontSize: type === 'sticky' ? STICKY_TEXT_SIZE : DEFAULT_TEXT_SIZE,
    color: TEXT_COLOR,
    autoFit: true,
    ...(type === 'sticky' ? { autoGrow: true } : {}),
  });
}

/** A new text element with its top-left at `at`; with `width`, it wraps at that width. */
export function createTextElement(
  id: string,
  at: { x: number; y: number },
  z: number,
  width?: number,
  block: TextBlock = defaultTextBlock('text'),
): ShapeElement {
  const text: TextBlock = { ...block, sizing: width === undefined ? 'auto-width' : 'auto-height' };
  return {
    id,
    type: 'text',
    x: at.x,
    y: at.y,
    width: width ?? text.fontSize * MIN_WIDTH_EM,
    height: text.fontSize * LINE_HEIGHT,
    rotation: 0,
    z,
    fill: 0xffffff00,
    stroke: 0x1f2937ff,
    strokeWidth: 0,
    radius: 0,
    text,
  };
}

/** Size a text element's box should have for its text (border inset included). */
export function measureTextBox(
  element: ShapeElement,
  measurer: FontMeasurer,
  block: TextBlock | undefined = element.text,
): { width: number; height: number } | null {
  const sizing = textSizing(element, block);
  if (!block || sizing === 'fixed') return null;
  const inset = element.strokeWidth; // half a border on each side, as in `textArea`
  const width = sizing === 'auto-width' ? UNBOUNDED : Math.max(0, element.width - inset);
  const layout = layoutText({ ...block, autoFit: false }, width, UNBOUNDED, measurer);
  const minimumWidth = block.fontSize * MIN_WIDTH_EM;
  return {
    width: sizing === 'auto-width' ? Math.max(minimumWidth, layout.width) + inset : element.width,
    height: layout.height + inset,
  };
}

/**
 * Patch that makes an auto-sized text element fit its text (`block` if given, e.g. one
 * being typed), or null if it already fits. The box grows away from its alignment: left
 * aligned text grows to the right, centered both ways, bottom aligned upward; rotation kept.
 */
export function fitTextPatch(
  element: ShapeElement,
  measurer: FontMeasurer,
  block: TextBlock | undefined = element.text,
): ElementPatch | null {
  const size = block && measureTextBox(element, measurer, block);
  if (!block || !size) return null;
  const { width: boxWidth, height: boxHeight } = size;
  if (Math.abs(boxWidth - element.width) < 1e-3 && Math.abs(boxHeight - element.height) < 1e-3)
    return null;
  const alignX = block.align === 'left' ? 0 : block.align === 'right' ? 1 : 0.5;
  const alignY = block.verticalAlign === 'top' ? 0 : block.verticalAlign === 'bottom' ? 1 : 0.5;
  // The anchor point (in the rotated box) stays where it is.
  const anchorAt = (width: number, height: number) =>
    rotateVector({ x: (alignX - 0.5) * width, y: (alignY - 0.5) * height }, element.rotation);
  const before = anchorAt(element.width, element.height);
  const after = anchorAt(boxWidth, boxHeight);
  const centerX = element.x + element.width / 2 + before.x - after.x;
  const centerY = element.y + element.height / 2 + before.y - after.y;
  return {
    x: centerX - boxWidth / 2,
    y: centerY - boxHeight / 2,
    width: boxWidth,
    height: boxHeight,
  };
}

/**
 * Makes a `text` box hug its text (Figma: double click on a resize handle): `auto-width`
 * fits width and height, `auto-height` keeps the width and fits the height. Returns the
 * patch (sizing and the fitted box), or null for other elements.
 */
export function hugTextPatch(
  element: ShapeElement,
  measurer: FontMeasurer,
  sizing: Exclude<TextSizing, 'fixed'>,
): ElementPatch | null {
  if (element.type !== 'text') return null;
  const block: TextBlock = { ...(element.text ?? textBlock('')), sizing };
  const fit = fitTextPatch({ ...element, text: block }, measurer, block);
  return { text: block, ...fit };
}

/** Clamps a font size to the supported range, rounded to 0.1 like design tools show it. */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TEXT_SIZE;
  return Math.round(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size)) * 10) / 10;
}

/** Next preset size up (`direction` 1) or down (-1) from `size`, for "A+ / A−" buttons. */
export function stepFontSize(size: number, direction: 1 | -1): number {
  if (direction > 0) {
    const next = FONT_SIZES.find((candidate) => candidate > size + 1e-6);
    return clampFontSize(next ?? size * 1.25);
  }
  const previous = [...FONT_SIZES].reverse().find((candidate) => candidate < size - 1e-6);
  return clampFontSize(previous ?? size / 1.25);
}

/** The whole text at one size: the block's, with every run's own size dropped. */
export function withFontSize(block: TextBlock, size: number): TextBlock {
  const fontSize = clampFontSize(size);
  const runs = block.runs.some((run) => run.size !== undefined)
    ? normalizeRuns(block.runs.map(({ size: _size, ...run }) => run))
    : block.runs;
  return { ...block, fontSize, runs };
}

/**
 * Steps the text's size up or down ("A+ / A−"): the block's size moves to the next preset
 * and every run's own size by the same ratio, so a bigger heading stays bigger.
 */
export function stepTextSize(block: TextBlock, direction: 1 | -1, scale = 1): TextBlock {
  const next = clampFontSize(stepFontSize(block.fontSize * scale, direction) / scale);
  const ratio = next / block.fontSize;
  const runs = block.runs.map((run) =>
    run.size === undefined ? run : { ...run, size: clampFontSize(run.size * ratio) },
  );
  return { ...block, fontSize: next, runs };
}

/** The whole text in one font family (the default one is stored as no `font`). */
export function withFont(block: TextBlock, id: string): TextBlock {
  const runs = block.runs.some((run) => run.font !== undefined)
    ? normalizeRuns(block.runs.map(({ font: _font, ...run }) => run))
    : block.runs;
  const next: TextBlock = { ...block, runs, font: id };
  if (fontIndex(id) === 0) delete next.font;
  return next;
}

/** True if some run has its own size (the block's `fontSize` is not the only one). */
export const hasMixedSizes = (block: TextBlock): boolean =>
  block.runs.some(
    (run) => run.size !== undefined && run.size !== block.fontSize && run.text !== '',
  );
