export const clamp = (value: number, minimum: number, maximum: number): number =>
  value < minimum ? minimum : value > maximum ? maximum : value;

/** The number `fraction` of the way from `from` to `to`. */
export const lerp = (from: number, to: number, fraction: number): number =>
  from + (to - from) * fraction;
