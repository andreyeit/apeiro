import { fontIndex } from './fonts';
import { graphemes } from './graphemes';
import {
  AUTO_GROW_SHARE,
  fontVariant,
  LINE_HEIGHT,
  LINK_COLOR,
  LIST_GAP_EM,
  listMarkers,
  MIN_AUTOFIT_SIZE,
  paragraphIndent,
  paragraphStyle,
  runSize,
  variantFamily,
  type FontVariant,
  type ParagraphStyle,
  type TextBlock,
  type TextRun,
} from './text-block';

/**
 * Text layout: line breaking, alignment, lists, decorations and links of a `TextBlock`.
 * Pure: glyph widths come from a `FontMeasurer`, so layout runs (and is tested) without
 * a DOM.
 */

export interface FontMeasurer {
  /** Advance width of a grapheme cluster in em (i.e. for font size 1). */
  advance(cluster: string, variant: FontVariant): number;
  /**
   * Kerning adjustment between two adjacent clusters, in em, added to the left one.
   * Optional: without it, layout sums plain advances.
   */
  kerning?(left: string, right: string, variant: FontVariant): number;
  /** Ascent above the baseline, in em (of the default family). */
  readonly ascent: number;
  /** Descent below the baseline, in em (positive). */
  readonly descent: number;
  /** Vertical metrics of a variant's family; defaults to `ascent`/`descent`. */
  metrics?(variant: FontVariant): { ascent: number; descent: number };
}

export interface LaidOutGlyph {
  /** A grapheme cluster: one visible character, possibly several code points (👨‍👩‍👧, 🇷🇺). */
  cluster: string;
  variant: FontVariant;
  /** Pen position at the baseline, in box-local coordinates (top-left origin). */
  x: number;
  y: number;
  color: number;
  /** Font size it is drawn at (after `autoFit`). */
  size: number;
}

/** Underline/strike-through line, box-local. */
export interface LaidOutDecoration {
  x: number;
  y: number;
  width: number;
  thickness: number;
  color: number;
}

/** One rendered line, box-local. Used for "greeking" (bars instead of glyphs when tiny). */
export interface LaidOutLine {
  x: number;
  /** Baseline. */
  y: number;
  width: number;
  /** Color of the line's first glyph. */
  color: number;
  /** Largest font size on the line. */
  size: number;
}

/** Clickable area of a link on one line, box-local. */
export interface LaidOutLink {
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextLayout {
  /** The block's base font size after `autoFit` (`fontSize * scale`). */
  fontSize: number;
  /** `autoFit` factor applied to every size (1 without autoFit or when the text fits). */
  scale: number;
  /** Largest font size used, after `autoFit`. */
  maxFontSize: number;
  glyphs: LaidOutGlyph[];
  decorations: LaidOutDecoration[];
  lines: LaidOutLine[];
  links: LaidOutLink[];
  lineCount: number;
  /** Size of the laid out text (not the box), list indentation included. */
  width: number;
  height: number;
  /** False if the text overflows the box even at the minimum font size. */
  fits: boolean;
}

const isSpace = (cluster: string) => cluster === ' ' || cluster === '\t';
const isLineBreak = (cluster: string) => cluster === '\n' || cluster === '\r\n' || cluster === '\r';
const HYPHENS = new Set(['-', '‐', '–', '—']);
/** Scripts that break between any two characters (no spaces between words). */
const BREAK_ANYWHERE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Underlines sit this far (in font sizes) below the baseline, strike-throughs above it. */
const UNDERLINE_OFFSET = 0.12;
const STRIKE_OFFSET = -0.3;
const DECORATION_THICKNESS = 0.07;

// --- Measuring and breaking ---------------------------------------------------

/** One grapheme cluster of the text, measured. */
interface Cluster {
  text: string;
  run: TextRun;
  variant: FontVariant;
  /** Font size before `autoFit`. */
  size: number;
  /** Advance in world units before `autoFit`, kerning with the next cluster included. */
  advance: number;
}

/** A piece of a paragraph that is never broken: a word, a run of spaces or one CJK character. */
interface Token {
  clusters: Cluster[];
  width: number;
  space: boolean;
}

interface Paragraph {
  tokens: Token[];
  style: ParagraphStyle;
  /** Left indentation (lists), before `autoFit`. */
  indent: number;
}

interface Line {
  clusters: Cluster[];
  /** Width, trailing spaces included, before `autoFit`. */
  width: number;
  paragraph: Paragraph;
  /** First line of its paragraph: list items draw their marker there. */
  first: boolean;
}

/** The measured clusters of each paragraph (text between line breaks). */
function measureParagraphs(block: TextBlock, measurer: FontMeasurer): Cluster[][] {
  const paragraphs: Cluster[][] = [[]];
  const baseFamily = fontIndex(block.font);
  // A '\r' ends a line by itself too; '\r' then '\n' (possibly split across runs) is one break.
  let afterCarriageReturn = false;
  for (const run of block.runs) {
    const family = run.font === undefined ? baseFamily : fontIndex(run.font);
    const variant = fontVariant(run.bold, run.italic, family);
    const size = runSize(run, block);
    for (const text of graphemes(run.text)) {
      if (text === '\n' && afterCarriageReturn) {
        afterCarriageReturn = false;
        continue;
      }
      afterCarriageReturn = text === '\r';
      if (isLineBreak(text)) {
        paragraphs.push([]);
        continue;
      }
      paragraphs[paragraphs.length - 1]!.push({
        text,
        run,
        variant,
        size,
        advance: measurer.advance(text, variant) * size,
      });
    }
  }
  if (measurer.kerning) {
    for (const clusters of paragraphs) {
      for (let index = 0; index + 1 < clusters.length; index++) {
        const current = clusters[index]!;
        const next = clusters[index + 1]!;
        if (
          current.variant === next.variant &&
          current.size === next.size &&
          !isSpace(current.text)
        )
          current.advance +=
            measurer.kerning(current.text, next.text, current.variant) * current.size;
      }
    }
  }
  return paragraphs;
}

/**
 * Splits a paragraph at line break opportunities, close to what browsers do for
 * Latin/Cyrillic: after spaces, after hyphens and dashes, around CJK characters.
 */
function tokenize(clusters: Cluster[]): Token[] {
  const tokens: Token[] = [];
  let current: Token | null = null;
  const flush = () => {
    if (current) tokens.push(current);
    current = null;
  };
  for (let index = 0; index < clusters.length; index++) {
    const cluster = clusters[index]!;
    const space = isSpace(cluster.text);
    if (!current || current.space !== space) {
      flush();
      current = { clusters: [], width: 0, space };
    }
    const token: Token = current;
    if (!space && BREAK_ANYWHERE.test(cluster.text) && token.clusters.length > 0) {
      flush();
      current = { clusters: [], width: 0, space: false };
    }
    current!.clusters.push(cluster);
    current!.width += cluster.advance;
    const next = clusters[index + 1];
    const breakAfter =
      !space &&
      next !== undefined &&
      !isSpace(next.text) &&
      (HYPHENS.has(cluster.text) || BREAK_ANYWHERE.test(cluster.text));
    if (breakAfter) flush();
  }
  flush();
  return tokens;
}

/** Greedy line breaking; `maxWidth` (before `autoFit`) is reduced by each paragraph's indent. */
function wrap(paragraphs: Paragraph[], maxWidth: number): Line[] {
  const lines: Line[] = [];
  for (const paragraph of paragraphs) {
    // A hair of slack: sums of the same advances in another order differ in the last bits,
    // and a box sized exactly to its text must not wrap because of that.
    const limit = maxWidth - paragraph.indent + Math.max(1, Math.abs(maxWidth)) * 1e-9;
    let first = true;
    let line: Cluster[] = [];
    let lineWidth = 0; // includes trailing spaces
    const push = () => {
      lines.push(finishLine(line, paragraph, first));
      first = false;
      line = [];
      lineWidth = 0;
    };
    const byClusters = (token: Token) => {
      for (const cluster of token.clusters) {
        if (line.length > 0 && lineWidth + cluster.advance > limit) push();
        line.push(cluster);
        lineWidth += cluster.advance;
      }
    };
    const whole = (token: Token) => {
      line.push(...token.clusters);
      lineWidth += token.width;
    };
    paragraph.tokens.forEach((token, index) => {
      if (token.space) {
        // Spaces take room like any character (CSS `white-space: break-spaces`, as the
        // editor lays them out): one that doesn't fit wraps to the next line instead of
        // hanging past the box, so the caret after it stays inside the box.
        byClusters(token);
        return;
      }
      // `break-spaces` allows a break only after a space, not between a word and the space
      // after it: the word fits only together with that space, or it moves to the next line
      // (as browsers lay out the editor's text; otherwise the caret lands off the letters).
      const following = paragraph.tokens[index + 1];
      const spaceAfter = following?.space ? following.clusters[0]!.advance : 0;
      if (line.length === 0 || lineWidth + token.width + spaceAfter <= limit) {
        // A single word wider than the box: break it by characters.
        if (line.length === 0 && token.width > limit) byClusters(token);
        else whole(token);
        return;
      }
      push();
      if (token.width > limit) byClusters(token);
      else whole(token);
    });
    push();
  }
  return lines;
}

function finishLine(clusters: Cluster[], paragraph: Paragraph, first: boolean): Line {
  // Trailing spaces count (they don't hang, as in the editor): alignment includes them.
  let width = 0;
  for (const cluster of clusters) width += cluster.advance;
  return { clusters, width, paragraph, first };
}

/** Widest unbreakable piece plus its paragraph's indent, before `autoFit`. */
function widestToken(paragraphs: Paragraph[]): number {
  let maximum = 0;
  for (const paragraph of paragraphs)
    for (const token of paragraph.tokens)
      if (!token.space) maximum = Math.max(maximum, token.width + paragraph.indent);
  return maximum;
}

/**
 * Vertical extent of a line like CSS computes it with `line-height: 1.3` everywhere: every
 * inline box (the block's own "strut" and each cluster's span) is 1.3x its font size tall,
 * centered on its font's ascent+descent; the line spans all of them, baselines aligned.
 */
class LineMetrics {
  private cache = new Map<string, [number, number]>();
  readonly strut: [number, number];

  constructor(
    private measurer: FontMeasurer,
    block: TextBlock,
  ) {
    this.strut = this.of(fontVariant(false, false, fontIndex(block.font)), block.fontSize);
  }

  /** [above, below] the baseline for a font size, before `autoFit`. */
  of(variant: FontVariant, size: number): [number, number] {
    const family = variantFamily(variant);
    const key = `${family}|${size}`;
    let cached = this.cache.get(key);
    if (!cached) {
      const metrics = this.measurer.metrics?.(variant) ?? this.measurer;
      cached = [
        (size * (LINE_HEIGHT + metrics.ascent - metrics.descent)) / 2,
        (size * (LINE_HEIGHT - metrics.ascent + metrics.descent)) / 2,
      ];
      this.cache.set(key, cached);
    }
    return cached;
  }

  line(line: Line): [number, number] {
    let [above, below] = this.strut;
    for (const cluster of line.clusters) {
      const [ascent, descent] = this.of(cluster.variant, cluster.size);
      if (ascent > above) above = ascent;
      if (descent > below) below = descent;
    }
    return [above, below];
  }
}

function textHeight(lines: Line[], metrics: LineMetrics): number {
  let height = 0;
  for (const line of lines) {
    const [ascent, descent] = metrics.line(line);
    height += ascent + descent;
  }
  return height;
}

// --- Layout -------------------------------------------------------------------

/**
 * Lays out `block` inside a `width` x `height` box (already reduced by padding).
 * Coordinates in the result are relative to the box's top-left corner.
 */
export function layoutText(
  block: TextBlock,
  width: number,
  height: number,
  measurer: FontMeasurer,
  /** Lines break only at line breaks (auto-width text); alignment still uses `width`. */
  noWrap = false,
): TextLayout {
  // Guard the divisions below against data that skipped validation.
  const base =
    Number.isFinite(block.fontSize) && block.fontSize > 0 ? block.fontSize : MIN_AUTOFIT_SIZE;
  if (base !== block.fontSize) block = { ...block, fontSize: base };
  const paragraphs: Paragraph[] = measureParagraphs(block, measurer).map((clusters, index) => {
    const style = paragraphStyle(block, index);
    return { tokens: tokenize(clusters), style, indent: paragraphIndent(style, base) };
  });
  const metrics = new LineMetrics(measurer, block);
  const wrapWidth = (scale: number) => (noWrap ? Infinity : width / scale);
  const { scale, fits: fitted } = autoFitScale(block, width, height, (scale) => {
    if (!noWrap && widestToken(paragraphs) * scale > width) return false;
    return textHeight(wrap(paragraphs, wrapWidth(scale)), metrics) * scale <= height;
  });
  const lines = wrap(paragraphs, wrapWidth(scale));
  const total = textHeight(lines, metrics) * scale;
  const fits = block.autoFit ? fitted : total <= height;
  const top =
    block.verticalAlign === 'top'
      ? 0
      : block.verticalAlign === 'bottom'
        ? height - total
        : (height - total) / 2;
  return {
    ...placeLines(block, lines, paragraphs, metrics, measurer, width, top, scale),
    fontSize: base * scale,
    scale,
    lineCount: lines.length,
    height: total,
    fits,
  };
}

/**
 * The `autoFit` factor of every font size: the largest that fits (`fitsAt`) with the base
 * size in [MIN_AUTOFIT_SIZE, top], where top is the block's size, or with `autoGrow` a
 * share of the box's smaller side. 1 without `autoFit` or when the text fits as it is.
 */
function autoFitScale(
  block: TextBlock,
  width: number,
  height: number,
  fitsAt: (scale: number) => boolean,
): { scale: number; fits: boolean } {
  const base = block.fontSize;
  // `autoGrow`: the size follows the box both ways, up to a share of its smaller side.
  const grow = block.autoFit && block.autoGrow;
  if (!block.autoFit || (!grow && fitsAt(1))) return { scale: 1, fits: true };
  let low = Math.min(MIN_AUTOFIT_SIZE, base) / base;
  let high = grow ? Math.max(low, (AUTO_GROW_SHARE * Math.min(width, height)) / base) : 1;
  if (!fitsAt(low)) return { scale: low, fits: false };
  if (fitsAt(high)) return { scale: high, fits: true };
  for (let iteration = 0; iteration < 12 && (high - low) * base > 0.25; iteration++) {
    const middle = (low + high) / 2;
    if (fitsAt(middle)) low = middle;
    else high = middle;
  }
  return { scale: low, fits: true };
}

/** The color of a run's text: its own, else links' color, else the block's. */
const runColor = (run: TextRun, block: TextBlock) =>
  run.color ?? (run.link ? LINK_COLOR : block.color);

/** Glyphs, decorations, lines and links of wrapped lines, from vertical position `top` down. */
function placeLines(
  block: TextBlock,
  lines: Line[],
  paragraphs: Paragraph[],
  metrics: LineMetrics,
  measurer: FontMeasurer,
  width: number,
  top: number,
  scale: number,
): Pick<TextLayout, 'glyphs' | 'decorations' | 'lines' | 'links' | 'width' | 'maxFontSize'> {
  const markers = paragraphs.some((paragraph) => paragraph.style.list)
    ? listMarkers(block, paragraphs.length)
    : [];
  const markerVariant = fontVariant(false, false, fontIndex(block.font));
  const glyphs: LaidOutGlyph[] = [];
  const decorations: LaidOutDecoration[] = [];
  const laidOutLines: LaidOutLine[] = [];
  const links: LaidOutLink[] = [];
  let maxWidth = 0;
  let maxSize = block.fontSize * scale;
  let y = top;

  for (const line of lines) {
    const [above, below] = metrics.line(line);
    const lineTop = y;
    const baseline = y + above * scale;
    const lineHeight = (above + below) * scale;
    y += lineHeight;
    const indent = line.paragraph.indent * scale;
    const lineWidth = line.width * scale;
    const available = width - indent;
    const lineStart =
      indent +
      (block.align === 'left'
        ? 0
        : block.align === 'right'
          ? available - lineWidth
          : (available - lineWidth) / 2);
    maxWidth = Math.max(maxWidth, indent + lineWidth);

    const marker = line.first ? markers[paragraphs.indexOf(line.paragraph)] : undefined;
    if (marker) {
      // Right-aligned against the text, like `::before` in the DOM editor.
      const size = block.fontSize * scale;
      const clusters = graphemes(marker);
      const advances = clusters.map((cluster) => measurer.advance(cluster, markerVariant) * size);
      let x = lineStart - LIST_GAP_EM * size - advances.reduce((sum, advance) => sum + advance, 0);
      clusters.forEach((cluster, index) => {
        glyphs.push({ cluster, variant: markerVariant, x, y: baseline, color: block.color, size });
        x += advances[index]!;
      });
    }

    let lineSize = 0;
    let underline: LaidOutDecoration | undefined;
    let strike: LaidOutDecoration | undefined;
    let link: LaidOutLink | undefined;
    let x = lineStart;
    for (const cluster of line.clusters) {
      const run = cluster.run;
      const color = runColor(run, block);
      const size = cluster.size * scale;
      const advance = cluster.advance * scale;
      lineSize = Math.max(lineSize, size);
      if (!isSpace(cluster.text))
        glyphs.push({
          cluster: cluster.text,
          variant: cluster.variant,
          x,
          y: baseline,
          color,
          size,
        });
      const span = { x, advance, size, color };
      underline = extendDecoration(
        decorations,
        underline,
        run.underline || !!run.link,
        span,
        baseline + size * UNDERLINE_OFFSET,
      );
      strike = extendDecoration(
        decorations,
        strike,
        run.strike,
        span,
        baseline + size * STRIKE_OFFSET,
      );
      if (run.link) {
        if (link && link.href === run.link) link.width = x + advance - link.x;
        else {
          link = { href: run.link, x, y: lineTop, width: advance, height: lineHeight };
          links.push(link);
        }
      } else link = undefined;
      x += advance;
    }
    maxSize = Math.max(maxSize, lineSize);
    if (line.clusters.length > 0) {
      laidOutLines.push({
        x: lineStart,
        y: baseline,
        width: lineWidth,
        color: runColor(line.clusters[0]!.run, block),
        size: lineSize,
      });
    }
  }
  return {
    glyphs,
    decorations,
    lines: laidOutLines,
    links,
    width: maxWidth,
    maxFontSize: maxSize,
  };
}

/** Where one cluster is drawn, for its decorations. */
interface DecoratedSpan {
  x: number;
  advance: number;
  size: number;
  color: number;
}

/**
 * Extends the current decoration line under (or through) consecutive clusters, or starts a
 * new one in `decorations`. Returns the line to extend next, undefined when not `enabled`.
 */
function extendDecoration(
  decorations: LaidOutDecoration[],
  current: LaidOutDecoration | undefined,
  enabled: boolean | undefined,
  span: DecoratedSpan,
  y: number,
): LaidOutDecoration | undefined {
  if (!enabled) return undefined;
  const thickness = Math.max(1, span.size * DECORATION_THICKNESS);
  if (
    current &&
    current.color === span.color &&
    current.y === y &&
    current.thickness === thickness &&
    Math.abs(current.x + current.width - span.x) < 1e-6
  ) {
    current.width += span.advance;
    return current;
  }
  const decoration = { x: span.x, y, width: span.advance, thickness, color: span.color };
  decorations.push(decoration);
  return decoration;
}
