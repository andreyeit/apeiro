/**
 * How the CPU layers lay out one instance in their buffers. Each layer describes its
 * attributes once; the WebGL and WebGPU backends both build their vertex layouts from it,
 * so the two can't drift apart.
 */

/** One attribute of an instance: `components` values of `format`, `offset` bytes in. */
export interface InstanceAttribute {
  /** `float32`: plain floats. `unorm8`: bytes read as 0..1 (colors). */
  format: 'float32' | 'unorm8';
  components: 1 | 4;
  offset: number;
}

export interface InstanceLayout {
  /** Bytes per instance. */
  stride: number;
  /** In shader location order. */
  attributes: readonly InstanceAttribute[];
}

/** `count` float32 attributes of four components each, back to back from `offset`. */
export const vec4Attributes = (offset: number, count: number): InstanceAttribute[] =>
  Array.from({ length: count }, (_, index) => ({
    format: 'float32' as const,
    components: 4 as const,
    offset: offset + index * 16,
  }));

/** Writes 0xRRGGBBAA as bytes R, G, B, A (an `unorm8` × 4 attribute) on any endianness. */
export function writeColorBytes(bytes: Uint8Array, offset: number, color: number): void {
  bytes[offset] = (color >>> 24) & 255;
  bytes[offset + 1] = (color >>> 16) & 255;
  bytes[offset + 2] = (color >>> 8) & 255;
  bytes[offset + 3] = color & 255;
}

/** Copies the first `usedBytes` of `buffer` into a new buffer of `bytes`. */
export function growBuffer(buffer: ArrayBuffer, bytes: number, usedBytes = buffer.byteLength) {
  const next = new ArrayBuffer(bytes);
  new Uint8Array(next).set(new Uint8Array(buffer, 0, usedBytes));
  return next;
}
