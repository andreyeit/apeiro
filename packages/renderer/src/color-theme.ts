/**
 * Colors drawn in place of others: lets a dark UI theme show the board's "paper" colors
 * inverted (white blocks become dark, black lines and text light) without touching the
 * stored elements. Colors match by RGB; the stored alpha is kept. Elements whose type is
 * in `keep` are drawn exactly as stored (e.g. stickies: their colors are content and look
 * the same in both themes).
 */
export class ColorTheme {
  private map = new Map<number, number>();
  private keep = new Set<string>();

  /** `pairs`: [stored 0xRRGGBB, drawn 0xRRGGBB]. An empty list draws everything as stored. */
  set(pairs: ReadonlyArray<readonly [number, number]>, keep: Iterable<string> = []): void {
    this.map = new Map(pairs.map(([from, to]) => [from >>> 0, to >>> 0]));
    this.keep = new Set(keep);
  }

  /** The packed 0xRRGGBBAA color to draw for `color` of an element of type `type`. */
  of(type: string, color: number): number {
    if (this.map.size === 0 || this.keep.has(type)) return color;
    const mapped = this.map.get(color >>> 8);
    return mapped === undefined ? color : ((mapped << 8) | (color & 255)) >>> 0;
  }
}
