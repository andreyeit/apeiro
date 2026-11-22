import {
  textArea,
  worldToLocal,
  type ShapeElement,
  type TextLayout,
  type Vec2,
} from '@apeiro/core';

/** The link of an element's laid out text under a world point, or null. */
export function linkAtPoint(
  element: ShapeElement,
  layout: TextLayout | undefined,
  world: Vec2,
  slop = 0,
): string | null {
  if (!layout || layout.links.length === 0) return null;
  const local = worldToLocal(element, world);
  const area = textArea(element);
  // Text-box coordinates: from the top-left of the text area, unrotated.
  const x = local.x + element.width / 2 - area.minX;
  const y = local.y + element.height / 2 - area.minY;
  for (const link of layout.links) {
    if (
      x >= link.x - slop &&
      x <= link.x + link.width + slop &&
      y >= link.y - slop &&
      y <= link.y + link.height + slop
    )
      return link.href;
  }
  return null;
}
