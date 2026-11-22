import {
  enterCrop,
  HANDLE_SIGNS,
  hitTestElement,
  imageRectangle,
  imageSize,
  shapeFrame,
  worldToFrame,
  type ResizeHandle,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';
import { handleScale, transformHandleAt } from '../overlay/handles';
import { IMAGE_HANDLE_HIT_PX } from './constants';
import type { InputContext } from './context';
import type { CropAction } from './modes';

// Crop mode of an image (Figma: double click or Enter): the crop frame's sides resize what
// is shown, the image inside pans, the image's own corners scale it.

/** The image in crop mode, if it still is one. */
export function cropTarget(context: InputContext): ShapeElement | null {
  const shape = context.overlay.cropping ? context.getShape(context.overlay.cropping) : undefined;
  return shape && shape.type === 'image' && shape.media ? shape : null;
}

/** Enters crop mode: the image switches to `crop`, showing the same part as before. */
export function startCrop(context: InputContext, id: string): void {
  if (context.isLocked(id)) return;
  const shape = context.getShape(id);
  if (!shape || shape.type !== 'image' || !shape.media) return;
  if (shape.imageFit !== 'crop' || !shape.crop)
    context.scene.update(id, enterCrop(shape, imageSize(shape)));
  context.overlay.cropping = id;
  context.overlay.selection = new Set([id]);
  context.clearDots();
  context.overlay.request();
  context.hooks.onCrop?.(id);
}

/** Leaves crop mode; false if it was not on. */
export function stopCrop(context: InputContext): boolean {
  if (!context.overlay.cropping) return false;
  context.overlay.cropping = null;
  context.overlay.request();
  context.hooks.onCrop?.(null);
  return true;
}

/** Crop mode on, or off for the image already in it. */
export function toggleCrop(context: InputContext, id: string): void {
  if (context.overlay.cropping === id) stopCrop(context);
  else startCrop(context, id);
}

/**
 * Corner of the image itself (crop mode) under a world point, as resize signs. Where it
 * coincides with a frame corner, a press just outside the frame takes the image.
 */
function imageCornerAt(
  context: InputContext,
  shape: ShapeElement,
  world: Vec2,
): readonly [number, number] | null {
  const local = worldToFrame(shapeFrame(shape), world);
  const x = local.x + shape.width / 2;
  const y = local.y + shape.height / 2;
  const image = imageRectangle(shape, imageSize(shape));
  const reach = context.pixelsToWorld(IMAGE_HANDLE_HIT_PX * handleScale(context.camera.zoom));
  for (const signX of [-1, 1] as const) {
    for (const signY of [-1, 1] as const) {
      const cornerX = signX > 0 ? image.x + image.width : image.x;
      const cornerY = signY > 0 ? image.y + image.height : image.y;
      if (Math.hypot(x - cornerX, y - cornerY) <= reach) return [signX, signY];
    }
  }
  return null;
}

/** Side or corner of the crop frame under a world point. */
function cropHandleAt(
  context: InputContext,
  shape: ShapeElement,
  world: Vec2,
): ResizeHandle | null {
  const hit = transformHandleAt(shapeFrame(shape), world, context.camera.zoom);
  return hit?.kind === 'resize' ? hit.handle : null;
}

/** What a press in crop mode grabs: the image's corner, a frame side, or the image. */
export function cropGrabAt(
  context: InputContext,
  shape: ShapeElement,
  world: Vec2,
): { action: CropAction; signs: readonly [number, number] } | null {
  const corner = imageCornerAt(context, shape, world);
  const handle = cropHandleAt(context, shape, world);
  const inside = hitTestElement(shape, world, 0);
  if (corner && (!handle || !inside)) return { action: 'scale', signs: corner };
  if (handle) return { action: 'resize', signs: HANDLE_SIGNS[handle] };
  if (inside) return { action: 'pan', signs: [0, 0] };
  return null;
}
