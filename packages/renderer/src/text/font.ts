import TinySDF from '@mapbox/tiny-sdf';
import { FONT_FAMILIES, variantFamily, type FontMeasurer, type FontVariant } from '@apeiro/core';
import type { RasterGlyph } from './glyph-atlas';

/** CSS family of a variant (the default one for an unknown index). */
export const familyCss = (variant: FontVariant): string =>
  (FONT_FAMILIES[variantFamily(variant)] ?? FONT_FAMILIES[0]!).css;

const MEASURE_SIZE = 100;

export const variantCss = (variant: FontVariant) => ({
  weight: variant & 1 ? '700' : '400',
  style: variant & 2 ? 'italic' : 'normal',
});

/** CSS `font` shorthand of a variant. */
export function cssFont(variant: FontVariant, size: number): string {
  const { weight, style } = variantCss(variant);
  return `${style} ${weight} ${size}px ${familyCss(variant)}`;
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createContext(width = 1, height = 1): Context2D {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d', { willReadFrequently: true })!;
}

/**
 * Measures with Canvas 2D using the same CSS font as the DOM editor, so text wraps
 * the same way on the board and while editing. Kerning is measured per pair
 * (`width("AV") - width("A") - width("V")`) and cached.
 */
export class CanvasFontMeasurer implements FontMeasurer {
  ascent = 0.9;
  descent = 0.22;
  private context = createContext();
  private advances = new Map<string, number>();
  private kernings = new Map<string, number>();
  private vertical = new Map<number, { ascent: number; descent: number }>();
  private currentVariant: FontVariant | -1 = -1;

  constructor() {
    this.updateVerticalMetrics();
  }

  advance(cluster: string, variant: FontVariant): number {
    const key = `${variant}|${cluster}`;
    let width = this.advances.get(key);
    if (width === undefined) {
      width = this.measure(cluster, variant);
      this.advances.set(key, width);
    }
    return width;
  }

  kerning(left: string, right: string, variant: FontVariant): number {
    const key = `${variant}|${left}\u0000${right}`;
    let kerning = this.kernings.get(key);
    if (kerning === undefined) {
      kerning =
        this.measure(left + right, variant) -
        this.advance(left, variant) -
        this.advance(right, variant);
      // Float noise from the measurement is not kerning.
      if (Math.abs(kerning) < 1e-4) kerning = 0;
      this.kernings.set(key, kerning);
    }
    return kerning;
  }

  /** Ascent and descent (em) of a variant's family, measured once per family. */
  metrics(variant: FontVariant): { ascent: number; descent: number } {
    const family = variantFamily(variant);
    let metrics = this.vertical.get(family);
    if (!metrics) {
      this.context.font = cssFont(family * 4, MEASURE_SIZE);
      this.currentVariant = family * 4;
      const measured = this.context.measureText('Hg');
      metrics = measured.fontBoundingBoxAscent
        ? {
            ascent: measured.fontBoundingBoxAscent / MEASURE_SIZE,
            descent: measured.fontBoundingBoxDescent / MEASURE_SIZE,
          }
        : { ascent: this.ascent, descent: this.descent };
      this.vertical.set(family, metrics);
    }
    return metrics;
  }

  /** Call after fonts finish loading: cached metrics belong to the fallback font. */
  clear(): void {
    this.advances.clear();
    this.kernings.clear();
    this.vertical.clear();
    this.currentVariant = -1;
    this.updateVerticalMetrics();
  }

  private measure(text: string, variant: FontVariant): number {
    if (this.currentVariant !== variant) {
      this.context.font = cssFont(variant, MEASURE_SIZE);
      this.currentVariant = variant;
    }
    return this.context.measureText(text).width / MEASURE_SIZE;
  }

  private updateVerticalMetrics(): void {
    this.context.font = cssFont(0, MEASURE_SIZE);
    const measured = this.context.measureText('Hg');
    if (measured.fontBoundingBoxAscent) {
      this.ascent = measured.fontBoundingBoxAscent / MEASURE_SIZE;
      this.descent = measured.fontBoundingBoxDescent / MEASURE_SIZE;
    }
    this.currentVariant = 0;
  }
}

export type GlyphRasterizer = (cluster: string, variant: FontVariant, size: number) => RasterGlyph;

/** SDF value at the outline. Shared by the rasterizer and the shader. */
export const SDF_CUTOFF = 0.25;
/**
 * How far the shaders move a glyph outline inwards, in screen pixels. Sampled bilinearly, the
 * distance field draws glyphs about 10 % heavier than the browser draws the same font, which
 * reads as smudged; a tenth of a pixel brings the ink within a few percent of the browser's
 * (measured against DOM text at 13–64 px).
 */
export const TEXT_THINNING = 0.1;
/**
 * Most samples per axis the text shaders take in a pixel when glyphs are drawn smaller than
 * their raster (zoomed out): up to 6 x 6, one per two atlas texels or so.
 */
export const TEXT_MAX_SAMPLES = 6;
/**
 * Largest SDF distance range, in texels. The shader only needs distances a few pixels around
 * the outline (it antialiases with screen-space derivatives, the same at every tier), and the
 * field has 256 levels: a range growing with the tier (a quarter of its size, 128 texels at
 * 512) left steps of 2/3 texel, and fully zoomed in, glyphs drawn bigger than their tier came
 * out with jagged, wobbly edges. 16 texels keep steps under 1/15 texel.
 */
const SDF_MAX_RADIUS = 16;
/** SDF distance range for a raster size, in texels. */
const sdfRadius = (size: number) => Math.min(size / 4, SDF_MAX_RADIUS);
/** SDF padding around the glyph for a raster size (integer, as TinySDF rounds it). */
const sdfBuffer = (size: number) => Math.ceil(sdfRadius(size) / 2);

/** Single-channel SDF glyphs at any raster size. */
export function createSdfRasterizer(): GlyphRasterizer {
  const instances = new Map<string, TinySDF>();
  return (cluster, variant, size) => {
    const key = `${variant}:${size}`;
    let sdf = instances.get(key);
    if (!sdf) {
      const { weight, style } = variantCss(variant);
      sdf = new TinySDF({
        fontSize: size,
        buffer: sdfBuffer(size),
        radius: sdfRadius(size),
        cutoff: SDF_CUTOFF,
        fontFamily: familyCss(variant),
        fontWeight: weight,
        fontStyle: style,
      });
      instances.set(key, sdf);
    }
    const glyph = sdf.draw(cluster);
    return {
      data: glyph.data,
      width: glyph.width,
      height: glyph.height,
      left: glyph.glyphLeft - sdfBuffer(size),
      top: glyph.glyphTop + sdfBuffer(size),
    };
  };
}

/** RGBA bitmaps (premultiplied) for color glyphs: emoji, flags. */
export function createColorRasterizer(): GlyphRasterizer {
  let context: Context2D | null = null;
  return (cluster, variant, size) => {
    const padding = 2;
    context ??= createContext(8, 8);
    context.font = cssFont(variant, size);
    const measured = context.measureText(cluster);
    // Real glyphs extend a couple of em at most; anything beyond (stacked combining marks…)
    // is clipped, so a single cluster can't allocate a huge bitmap or overflow the atlas.
    const reach = (value: number) => Math.min(Math.ceil(value), size * 2);
    const reachLeft = reach(measured.actualBoundingBoxLeft);
    const reachRight = reach(measured.actualBoundingBoxRight);
    const ascent = reach(measured.actualBoundingBoxAscent);
    const descent = reach(measured.actualBoundingBoxDescent);
    const width = reachLeft + reachRight + padding * 2;
    const height = ascent + descent + padding * 2;
    if (!(width > padding * 2) || !(height > padding * 2)) {
      return { data: new Uint8Array(0), width: 0, height: 0, left: 0, top: 0 };
    }
    const canvas = context.canvas;
    if (canvas.width < width || canvas.height < height) {
      canvas.width = Math.max(canvas.width, width);
      canvas.height = Math.max(canvas.height, height);
      context.font = cssFont(variant, size); // resizing resets the context state
    }
    context.clearRect(0, 0, width, height);
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#000';
    context.fillText(cluster, padding + reachLeft, padding + ascent);
    const pixels = context.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(pixels.length);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset + 3]!;
      data[offset] = (pixels[offset]! * alpha + 127) / 255;
      data[offset + 1] = (pixels[offset + 1]! * alpha + 127) / 255;
      data[offset + 2] = (pixels[offset + 2]! * alpha + 127) / 255;
      data[offset + 3] = alpha;
    }
    return { data, width, height, left: -reachLeft - padding, top: ascent + padding };
  };
}
