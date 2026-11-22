/** Builds 0xRRGGBBAA from components in 0..255 (alpha defaults to opaque). */
export function rgba(red: number, green: number, blue: number, alpha = 255): number {
  return (((red & 255) << 24) | ((green & 255) << 16) | ((blue & 255) << 8) | (alpha & 255)) >>> 0;
}

/** Parses '#rgb', '#rrggbb' or '#rrggbbaa'. */
export function hexColor(hex: string): number {
  let digits = hex.startsWith('#') ? hex.slice(1) : hex;
  if (digits.length === 3) digits = [...digits].map((character) => character + character).join('');
  if (digits.length === 6) digits += 'ff';
  if (digits.length !== 8 || !/^[0-9a-f]+$/i.test(digits)) throw new Error(`Invalid color: ${hex}`);
  return parseInt(digits, 16) >>> 0;
}

/** Splits 0xRRGGBBAA into normalized components (0..1). */
export function unpackColor(color: number): [number, number, number, number] {
  return [
    ((color >>> 24) & 255) / 255,
    ((color >>> 16) & 255) / 255,
    ((color >>> 8) & 255) / 255,
    (color & 255) / 255,
  ];
}

/** CSS `rgba()` of a packed 0xRRGGBBAA color. */
export const cssColor = (color: number): string =>
  `rgba(${color >>> 24}, ${(color >>> 16) & 255}, ${(color >>> 8) & 255}, ${(color & 255) / 255})`;
