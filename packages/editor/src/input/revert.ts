import { isShape, type ElementPatch } from '@apeiro/core';
import type { InputContext } from './context';

/**
 * Puts back what the current gesture changed (Esc, or the system took the pointer away).
 * Returns false when there is nothing to revert (idle, or a custom tool: see `controls.ts`).
 */
export function revertGesture(context: InputContext): boolean {
  const { mode, scene } = context;
  switch (mode.kind) {
    case 'connect':
      if (mode.original === null) scene.remove(mode.id);
      else scene.update(mode.id, { [mode.which]: mode.original } as ElementPatch);
      return true;
    case 'drag':
      scene.transact(() => {
        for (const [id, origin] of mode.origin) {
          if (origin.kind === 'shape') scene.update(id, { x: origin.x, y: origin.y });
          else scene.update(id, { start: origin.start, end: origin.end });
        }
      });
      return true;
    case 'bend':
      scene.update(mode.id, mode.original);
      return true;
    case 'volume':
      scene.update(mode.id, { volume: mode.original });
      return true;
    case 'radius':
      scene.update(mode.id, { radius: mode.original });
      return true;
    case 'count':
      scene.update(mode.id, { sides: mode.original });
      return true;
    case 'crop': {
      const original = mode.original;
      scene.update(original.id, {
        x: original.x,
        y: original.y,
        width: original.width,
        height: original.height,
        imageFit: original.imageFit,
        crop: original.crop,
      });
      return true;
    }
    case 'resize':
    case 'rotate':
      scene.transact(() => {
        for (const original of mode.originals) {
          if (isShape(original)) {
            scene.update(original.id, {
              x: original.x,
              y: original.y,
              width: original.width,
              height: original.height,
              rotation: original.rotation,
              ...(original.text ? { text: original.text } : {}),
            });
          } else {
            scene.update(original.id, { start: original.start, end: original.end });
          }
        }
      });
      return true;
    case 'ink':
      scene.remove(mode.id);
      return true;
    case 'marquee':
      context.overlay.selection = new Set(mode.base);
      return true;
    case 'seek':
    case 'textbox':
    case 'place':
    case 'erase':
      return true;
    case 'idle':
    case 'pan':
    case 'custom':
      return false;
  }
}
