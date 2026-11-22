import type { ElementPatch, ShapeElement } from './element';

/**
 * How an image fills its box, as Figma's image fill modes:
 * - `fill` (default): covers the box, cropped evenly; never distorted.
 * - `fit`: the whole image; the box hugs it (`fitBox`), keeping the image's proportions.
 * - `crop`: the `crop` part of the image, stretched to the box (the box keeps that
 *   part's proportions unless resized with Shift).
 */
export type ImageFit = 'fill' | 'fit' | 'crop';

/** Part of the image shown in `crop` mode, as fractions (0..1) of the image. */
export interface CropRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Texture coordinates of the box: the image's (u, v) at the box's top-left corner, and how
 * much of the image (`spanU`, `spanV`) the box spans. Outside 0..1 the box shows nothing (`fit`).
 */
export interface ImageUv {
  u: number;
  v: number;
  spanU: number;
  spanV: number;
}

/** Box-local rectangle (origin at the element's unrotated top-left corner). */
export interface LocalRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixel size of the image: stored with the element, else `fallback` (e.g. the decoded file). */
export function imageSize(
  element: ShapeElement,
  fallback?: { width: number; height: number } | null,
): { width: number; height: number } {
  const width = element.media?.naturalWidth ?? fallback?.width;
  const height = element.media?.naturalHeight ?? fallback?.height;
  // Unknown: the box's own proportions, so the image shows whole.
  return width && height && width > 0 && height > 0
    ? { width, height }
    : { width: Math.max(element.width, 1e-6), height: Math.max(element.height, 1e-6) };
}

/** Where the image lands in the element's box (see `ImageUv`). */
export function imageUv(element: ShapeElement, size: { width: number; height: number }): ImageUv {
  const fit = element.imageFit ?? 'fill';
  if (fit === 'crop' && element.crop)
    return {
      u: element.crop.x,
      v: element.crop.y,
      spanU: element.crop.width,
      spanV: element.crop.height,
    };
  const boxAspect = Math.max(element.width, 1e-6) / Math.max(element.height, 1e-6);
  const imageAspect = size.width / size.height;
  if (fit === 'fit') {
    // Contain: the image's longer side (relative to the box) touches the box.
    if (boxAspect > imageAspect) {
      const spanU = boxAspect / imageAspect;
      return { u: (1 - spanU) / 2, v: 0, spanU, spanV: 1 };
    }
    const spanV = imageAspect / boxAspect;
    return { u: 0, v: (1 - spanV) / 2, spanU: 1, spanV };
  }
  // Fill (cover), centered.
  if (boxAspect > imageAspect) {
    const spanV = imageAspect / boxAspect;
    return { u: 0, v: (1 - spanV) / 2, spanU: 1, spanV };
  }
  const spanU = boxAspect / imageAspect;
  return { u: (1 - spanU) / 2, v: 0, spanU, spanV: 1 };
}

/** The whole image's rectangle in box-local coordinates (it may extend past the box). */
export function imageRectangle(
  element: ShapeElement,
  size: { width: number; height: number },
): LocalRectangle {
  const coordinates = imageUv(element, size);
  const width = element.width / coordinates.spanU;
  const height = element.height / coordinates.spanV;
  // `0 - …`: never -0.
  return { x: 0 - coordinates.u * width, y: 0 - coordinates.v * height, width, height };
}

/** Patch that moves the element's box to `box`, given in its current box-local coordinates. */
export function localBoxPatch(element: ShapeElement, box: LocalRectangle): ElementPatch {
  const cosine = Math.cos(element.rotation);
  const sine = Math.sin(element.rotation);
  // The new center relative to the old one, box-local.
  const localX = box.x + box.width / 2 - element.width / 2;
  const localY = box.y + box.height / 2 - element.height / 2;
  const centerX = element.x + element.width / 2 + localX * cosine - localY * sine;
  const centerY = element.y + element.height / 2 + localX * sine + localY * cosine;
  return {
    x: centerX - box.width / 2,
    y: centerY - box.height / 2,
    width: box.width,
    height: box.height,
  };
}

const cropOf = (box: LocalRectangle, image: LocalRectangle): CropRectangle => ({
  x: (box.x - image.x) / image.width,
  y: (box.y - image.y) / image.height,
  width: box.width / image.width,
  height: box.height / image.height,
});

/**
 * Switches the element to `fit`: the box shrinks around the whole image, centered where
 * the image would show inside the current box, so no empty margins are left.
 */
export function fitBox(
  element: ShapeElement,
  size: { width: number; height: number },
): ElementPatch {
  const box = imageRectangle({ ...element, imageFit: 'fit', crop: undefined }, size);
  return { ...localBoxPatch(element, box), imageFit: 'fit', crop: undefined };
}

/**
 * Switches the element to `crop` showing what it shows now: the box keeps the visible
 * part of the image (a `fit` box shrinks to the image). The image doesn't move on screen.
 */
export function enterCrop(
  element: ShapeElement,
  size: { width: number; height: number },
): ElementPatch {
  const image = imageRectangle(element, size);
  const left = Math.max(0, image.x);
  const top = Math.max(0, image.y);
  const right = Math.min(element.width, image.x + image.width);
  const bottom = Math.min(element.height, image.y + image.height);
  const box = {
    x: left,
    y: top,
    width: Math.max(1e-6, right - left),
    height: Math.max(1e-6, bottom - top),
  };
  return { ...localBoxPatch(element, box), imageFit: 'crop', crop: cropOf(box, image) };
}

/**
 * Crop mode, dragging a side or corner of the crop frame: the image stays in place and
 * the frame moves its dragged sides by `delta` (box-local), staying on the image.
 * `signs`: which sides move (-1 left/top, 1 right/bottom, 0 neither), as resize handles.
 */
export function cropResize(
  element: ShapeElement,
  size: { width: number; height: number },
  signs: readonly [number, number],
  delta: { x: number; y: number },
  minSize = 1,
): ElementPatch {
  const image = imageRectangle(element, size);
  let left = 0;
  let top = 0;
  let right = element.width;
  let bottom = element.height;
  const [signX, signY] = signs;
  if (signX < 0) left = Math.min(Math.max(image.x, delta.x), right - minSize);
  if (signX > 0)
    right = Math.max(Math.min(image.x + image.width, element.width + delta.x), left + minSize);
  if (signY < 0) top = Math.min(Math.max(image.y, delta.y), bottom - minSize);
  if (signY > 0)
    bottom = Math.max(Math.min(image.y + image.height, element.height + delta.y), top + minSize);
  const box = { x: left, y: top, width: right - left, height: bottom - top };
  return { ...localBoxPatch(element, box), imageFit: 'crop', crop: cropOf(box, image) };
}

/** Crop mode, dragging inside the frame: the image moves under it, never leaving a gap. */
export function cropPan(
  element: ShapeElement,
  size: { width: number; height: number },
  delta: { x: number; y: number },
): ElementPatch {
  const image = imageRectangle(element, size);
  const x = Math.min(0, Math.max(element.width - image.width, image.x + delta.x));
  const y = Math.min(0, Math.max(element.height - image.height, image.y + delta.y));
  return {
    imageFit: 'crop',
    crop: cropOf({ x: 0, y: 0, width: element.width, height: element.height }, { ...image, x, y }),
  };
}

/** The image may grow up to this many times the frame (on its larger side). */
const MAX_IMAGE_ZOOM = 50;

/**
 * Crop mode, dragging a corner of the image itself (Figma's image handles): the image
 * scales with its proportions around the opposite corner, the frame stays. It never gets
 * smaller than needed to cover the frame. `signs` pick the corner (±1, ±1); `delta` is
 * the corner's movement, box-local.
 */
export function cropScale(
  element: ShapeElement,
  size: { width: number; height: number },
  signs: readonly [number, number],
  delta: { x: number; y: number },
): ElementPatch {
  const image = imageRectangle(element, size);
  const [signX, signY] = signs;
  // The fixed (opposite) corner, and the dragged one where the pointer put it.
  const anchorX = signX > 0 ? image.x : image.x + image.width;
  const anchorY = signY > 0 ? image.y : image.y + image.height;
  const draggedX = (signX > 0 ? image.x + image.width : image.x) + delta.x;
  const draggedY = (signY > 0 ? image.y + image.height : image.y) + delta.y;
  // Follow whichever axis the pointer pulled further, like a proportional corner resize.
  let scale = Math.max(
    (signX * (draggedX - anchorX)) / image.width,
    (signY * (draggedY - anchorY)) / image.height,
  );
  // Smallest scale that still covers the frame from the fixed corner.
  const cover = Math.max(
    signX > 0 ? (element.width - anchorX) / image.width : anchorX / image.width,
    signY > 0 ? (element.height - anchorY) / image.height : anchorY / image.height,
  );
  const largest =
    (MAX_IMAGE_ZOOM * Math.max(element.width, element.height)) /
    Math.max(image.width, image.height);
  scale = Math.min(Math.max(scale, cover), Math.max(cover, largest));
  const width = image.width * scale;
  const height = image.height * scale;
  const scaled = {
    x: signX > 0 ? anchorX : anchorX - width,
    y: signY > 0 ? anchorY : anchorY - height,
    width,
    height,
  };
  const crop = cropOf({ x: 0, y: 0, width: element.width, height: element.height }, scaled);
  // Rounding must not push the crop a hair outside the image.
  const x = Math.min(Math.max(crop.x, 0), 1);
  const y = Math.min(Math.max(crop.y, 0), 1);
  return {
    imageFit: 'crop',
    crop: { x, y, width: Math.min(crop.width, 1 - x), height: Math.min(crop.height, 1 - y) },
  };
}
