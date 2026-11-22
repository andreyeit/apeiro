import type { ShapeElement } from './elements/element';

export function makeRectangle(id: string, patch: Partial<ShapeElement> = {}): ShapeElement {
  return {
    id,
    type: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    z: 0,
    fill: 0xffffffff,
    stroke: 0x000000ff,
    strokeWidth: 0,
    radius: 0,
    ...patch,
  };
}
