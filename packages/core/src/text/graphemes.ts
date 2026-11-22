type Segmenter = { segment(input: string): Iterable<{ segment: string }> };
let graphemeSegmenter: Segmenter | null | undefined;

/**
 * Splits text into grapheme clusters, so emoji sequences, flags and combining marks
 * stay one glyph. Falls back to code points where `Intl.Segmenter` is missing.
 */
export function graphemes(text: string): string[] {
  if (graphemeSegmenter === undefined) {
    const SegmenterConstructor = (
      Intl as unknown as { Segmenter?: new (locale?: string, options?: object) => Segmenter }
    ).Segmenter;
    graphemeSegmenter = SegmenterConstructor
      ? new SegmenterConstructor(undefined, { granularity: 'grapheme' })
      : null;
  }
  if (!graphemeSegmenter) return [...text];
  const clusters: string[] = [];
  for (const segment of graphemeSegmenter.segment(text)) clusters.push(segment.segment);
  return clusters;
}

const COLOR_GLYPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣|️/u;

/** True for clusters drawn from a color font (emoji, flags, keycaps), not as a one-color outline. */
export const isColorGlyph = (cluster: string): boolean => COLOR_GLYPH.test(cluster);
