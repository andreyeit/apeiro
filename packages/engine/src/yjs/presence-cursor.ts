import { MOUSE_POINTER_PATH } from './assets/mouse-pointer';

/** Figma's presence cursor, in screen pixels regardless of the board's zoom. */
export function presenceCursor() {
  let pointer: Path2D | undefined;
  return {
    draw(context: CanvasRenderingContext2D, name: string, color: string) {
      // Create lazily: bindings may be constructed before mounting, including on a server.
      pointer ??= new Path2D(MOUSE_POINTER_PATH);
      context.fillStyle = color;
      context.fill(pointer);
      context.save();
      context.strokeStyle = color;
      context.lineWidth = 0.6;
      context.lineJoin = 'round';
      context.stroke(pointer);
      context.restore();
      context.font = '400 12px Geist, Inter, system-ui, sans-serif';
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.fillStyle = color;
      context.beginPath();
      context.roundRect(16, 20, context.measureText(name).width + 12, 24, 7);
      context.fill();
      context.fillStyle = '#fff';
      context.fillText(name, 22, 32);
    },
  };
}
