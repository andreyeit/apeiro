import {
  imageRectangle,
  imageSize,
  groupOf,
  inflateBox,
  anchorPoint,
  boxIntersects,
  CORNER_HANDLES,
  HANDLE_SIGNS,
  isShape,
  SIDE_MIDPOINTS,
  type Box,
  type Camera,
  type ConnectorElement,
  type ConnectorGeometry,
  type Frame,
  type Scene,
  type ShapeElement,
  type Vec2,
  type SnapGuide,
  type SpacingGuide,
} from '@apeiro/core';
import { CanvasSize, MAX_PIXEL_RATIO } from '@apeiro/renderer';
import { enteredGroup } from '../selection/grouping';
import { HANDLE_FILL, SELECTION_COLOR } from '../theme/board-theme';
import {
  anchorDot,
  HANDLE_ACTIVE_RADIUS_PX,
  handleScale,
  CORNER_HANDLE_PX,
  countHandlePoint,
  HANDLE_RADIUS_PX,
  radiusHandlePoint,
  radiusHandleShape,
  selectionEdgeFrame,
} from './handles';
import { traceBox, traceCap, traceConnector, traceShape } from './paths';

/** Length of the crop frame's corner brackets (screen px). */
const CROP_HANDLE_PX = 14;
/** Smart guides: Figma's red, distinct from the selection blue. */
const GUIDE = '#f24822';
/** At most this many elements in view are outlined. */
const MAX_OUTLINES = 2000;
/** Width of an element's outline (selection, hover), screen px. */
const OUTLINE_PX = 1.5;
/** Shapes smaller than this on screen are outlined by their box. */
const EXACT_OUTLINE_MIN_PX = 32;
/** Border of the selection frame and its handles (screen px). */
const HANDLE_BORDER_PX = 1.5;

/**
 * Path radius of a round handle `outerPx` wide (radius, screen px) at this zoom: its border
 * falls inside, so every handle's outer edge is exactly its size.
 */
function pathRadius(outerPx: number, zoom: number): number {
  return Math.max(outerPx - HANDLE_BORDER_PX / 2, 0.5) / zoom;
}

/** Extra drawing on the overlay, see `Overlay.addLayer`. */
export type OverlayLayer = (context: CanvasRenderingContext2D, zoom: number) => void;

/**
 * Lightweight 2D canvas on top of the GPU canvas for transient UI: selection, marquee,
 * hover, handles, guides, connection dots and drop targets. Few elements, redrawn on change.
 */
export class Overlay {
  private context: CanvasRenderingContext2D;
  private frame = 0;
  /** Selected element ids. */
  selection = new Set<string>();
  marquee: Box | null = null;
  /** Smart guides of the move or resize in progress (see `snapBox`). */
  guides: SnapGuide[] = [];
  /** Equal-spacing guides of the move in progress. */
  spacing: SpacingGuide[] = [];
  /** Ctrl/⌘ held (deep select): hover outlines the element itself, not its group. */
  deep = false;
  hover: string | null = null;
  /** Shape whose connection dots are shown. */
  anchorsFor: string | null = null;
  /** The connection dot under the pointer (of `anchorsFor`), drawn highlighted. */
  hoverDot: Vec2 | null = null;
  /** Line whose end or bend is being dragged: its handles are hidden (they'd sit under the
   * cursor and cover the end being placed). */
  dragging: string | null = null;
  /** Shape a dragged connector end would attach to, and the snapped anchor (if any). */
  target: string | null = null;
  snap: Vec2 | null = null;
  /** The radius handle is hovered or dragged: drawn filled. */
  radiusActive = false;
  /** The polygon's corner-count handle is hovered or dragged; `countLabel`: the count shown while dragging. */
  countActive = false;
  countLabel: number | null = null;
  /** Image in crop mode: its frame has crop handles and the rest of the image shows faded. */
  cropping: string | null = null;
  /** Images of crop mode by src (drawn faded around the frame). */
  private images = new Map<string, HTMLImageElement>();
  /** Show the transform frame around the selection (off for the connector tool). */
  transformEnabled = true;
  /** A read-only board: the selection is outlined, without handles or connection dots. */
  readOnly = false;
  /** Called after every overlay redraw, e.g. to sync a panel with the selection. */
  onDraw: (() => void) | null = null;
  /** Color of the selection, handles and hover (`SELECTION_COLOR_DARK` on a dark board). */
  accent = SELECTION_COLOR;
  /** Inside of handles: the board background (`HANDLE_FILL_DARK` on a dark board). */
  handleFill = HANDLE_FILL;
  /** Shown under the selection while it is resized or rotated: its size or angle. */
  badge: string | null = null;
  /**
   * Element whose text is being edited: drawn with just its outline, without handles or
   * connection dots (set by the text editor's `onStart`/`onStop`).
   */
  editing: string | null = null;
  private layers = new Set<OverlayLayer>();
  private readonly size: CanvasSize;
  /** Device pixels per CSS pixel of the drawing buffer (see `resize`). */
  private ratio = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private scene: Scene,
    private camera: Camera,
  ) {
    this.context = canvas.getContext('2d')!;
    this.size = new CanvasSize(canvas, () => this.resize());
  }

  /** Matches the drawing buffer to the canvas on screen, pixel for pixel (watched by itself too). */
  resize(): void {
    const metrics = this.size.measure(MAX_PIXEL_RATIO);
    const cleared = this.size.apply(metrics);
    this.ratio = metrics.ratio;
    if (cleared) {
      // The resize cleared the buffer: draw now, not a frame later (see `Renderer.resize`).
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.draw();
    } else this.request();
  }

  request(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Stops drawing and watching the canvas size (the overlay of an unmounted board). */
  dispose(): void {
    this.size.dispose();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** The single selected connector, if exactly one is selected. */
  selectedConnector(): string | null {
    if (this.selection.size !== 1) return null;
    const id = this.selection.values().next().value!;
    return this.scene.get(id)?.type === 'connector' ? id : null;
  }

  draw(): void {
    // Drawn now (e.g. after the board's frame): a redraw requested for later is not needed.
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const { context, camera } = this;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const zoom = camera.zoom;
    this.setWorldTransform();

    // Groups: a dashed frame around the group under the pointer, and around the group
    // the selection is inside of (its elements are being picked one by one).
    const inside = enteredGroup(this.scene, this.selection);
    if (inside) this.groupFrame(inside, zoom, 0.7);
    const hover = this.hover;
    const hovered = hover ? this.scene.get(hover) : undefined;
    const hoverGroup = hovered && !inside && !this.deep ? groupOf(this.scene, hovered) : null;
    if (hoverGroup && !hoverGroup.every((id) => this.selection.has(id)))
      this.groupFrame(hoverGroup, zoom, 0.6);
    else if (hover && !this.selection.has(hover) && hover !== this.editing)
      this.outlineElements([hover], 0.6, this.accent);

    // Transform frame with corner handles, and while resizing or rotating a badge with the
    // size or the angle. None while text is being edited: typing, not transforming.
    const frame =
      this.transformEnabled && !this.readOnly && !this.cropping && !this.editing
        ? selectionEdgeFrame(this.scene, this.selection)
        : null;
    // Outlines show what a frame around several elements holds; a lone shape has just its
    // frame (an outline on top of it would double the line).
    if (this.selection.size > 0 && !(frame && this.selection.size === 1))
      this.outlineElements(this.selection, 1, this.accent);
    // Text being edited: one outline on its edge, the only focus mark (no DOM outline).
    if (this.editing && !this.selection.has(this.editing))
      this.outlineElements([this.editing], 1, this.accent);

    if (frame) this.drawTransformFrame(frame, zoom);
    if (this.badge && this.selection.size > 0 && !this.editing) this.drawBadge(this.badge, zoom);

    this.drawGuides(zoom);
    this.drawSpacing(zoom);

    const selected = this.readOnly ? null : this.selectedConnector();
    const connector = selected === this.dragging ? null : selected;
    if (connector) {
      const geometry = this.scene.connectorGeometry(connector);
      if (geometry) {
        const scale = handleScale(zoom);
        this.handle(geometry.points[0]!, zoom, scale);
        this.handle(geometry.points[geometry.points.length - 1]!, zoom, scale);
        if (geometry.handle)
          this.bendHandle(geometry.handle.point, geometry.handle.axis, zoom, scale);
      }
    }

    // Connection dots: not on a selected element (its handles are there instead).
    if (
      this.anchorsFor &&
      this.anchorsFor !== this.editing &&
      !this.selection.has(this.anchorsFor) &&
      !this.readOnly
    ) {
      const shape = this.scene.get(this.anchorsFor);
      if (shape && isShape(shape)) {
        const scale = handleScale(zoom);
        for (const anchor of SIDE_MIDPOINTS) {
          const hovered =
            this.hoverDot !== null && this.hoverDot.x === anchor.x && this.hoverDot.y === anchor.y;
          if (hovered) this.plusDot(anchorDot(shape, anchor, zoom), zoom, scale);
          else
            this.dot(
              anchorDot(shape, anchor, zoom),
              zoom,
              this.accent,
              1,
              false,
              HANDLE_RADIUS_PX * scale,
            );
        }
      }
    }
    if (this.target) {
      // Magnets on the drop target (no outline: the dots say where the end attaches); the
      // one the end is attached to is filled.
      const shape = this.scene.get(this.target);
      if (shape && isShape(shape)) {
        const scale = handleScale(zoom);
        for (const anchor of SIDE_MIDPOINTS)
          this.dot(
            anchorPoint(shape, anchor),
            zoom,
            this.accent,
            1,
            false,
            HANDLE_RADIUS_PX * scale,
          );
        if (this.snap)
          this.dot(
            anchorPoint(shape, this.snap),
            zoom,
            this.accent,
            1,
            true,
            HANDLE_ACTIVE_RADIUS_PX * scale,
          );
      }
    }

    if (this.marquee) {
      const marquee = this.marquee;
      context.fillStyle = this.accent;
      context.strokeStyle = this.accent;
      context.lineWidth = 1 / zoom;
      context.globalAlpha = 0.08;
      context.fillRect(
        marquee.minX,
        marquee.minY,
        marquee.maxX - marquee.minX,
        marquee.maxY - marquee.minY,
      );
      context.globalAlpha = 1;
      context.strokeRect(
        marquee.minX,
        marquee.minY,
        marquee.maxX - marquee.minX,
        marquee.maxY - marquee.minY,
      );
    }

    // Corner-radius handle (top-left corner, a polygon's top vertex), as in Figma.
    const rounded =
      this.cropping || this.editing || this.readOnly
        ? null
        : radiusHandleShape(this.scene, this.selection, zoom);
    if (rounded) {
      const point = radiusHandlePoint(rounded, zoom);
      context.beginPath();
      context.arc(
        point.x,
        point.y,
        pathRadius(HANDLE_RADIUS_PX * handleScale(zoom), zoom),
        0,
        Math.PI * 2,
      );
      context.fillStyle = this.radiusActive ? this.accent : this.handleFill;
      context.fill();
      context.lineWidth = 1.5 / zoom;
      context.strokeStyle = this.accent;
      context.stroke();
      if (rounded.type === 'polygon') this.drawCountHandle(rounded, zoom);
    }
    this.drawCrop(zoom);
    for (const layer of this.layers) {
      context.save();
      this.setWorldTransform();
      layer(context, zoom);
      context.restore();
    }
    this.onDraw?.();
  }

  /** World → device pixels in one transform; line widths are divided by zoom to stay constant. */
  private setWorldTransform(): void {
    const { camera } = this;
    const scale = this.ratio * camera.zoom;
    this.context.setTransform(scale, 0, 0, scale, -camera.x * scale, -camera.y * scale);
  }

  /**
   * Draws `layer` on top of the overlay after every redraw, in world coordinates (divide
   * line widths and sizes by `zoom` to keep them constant on screen), e.g. other users'
   * cursors. Returns a function that removes it.
   */
  addLayer(layer: OverlayLayer): () => void {
    this.layers.add(layer);
    this.request();
    return () => {
      this.layers.delete(layer);
      this.request();
    };
  }

  /**
   * The selection's transform frame, as in the design (Selection / Handle): a 1.5px accent
   * line just outside the selection and round corner handles filled with the board
   * background. The edges resize and the area just outside the corners rotates.
   */
  private drawTransformFrame(frame: Frame, zoom: number): void {
    const { context } = this;
    context.save();
    context.translate(frame.centerX, frame.centerY);
    context.rotate(frame.rotation);
    context.strokeStyle = this.accent;
    const line = HANDLE_BORDER_PX / zoom;
    context.lineWidth = line;
    // The line runs just outside the edge (the canvas strokes on the path's center line).
    // The handles shrink when zoomed out.
    const scale = handleScale(zoom);
    const width = frame.width + line;
    const height = frame.height + line;
    context.strokeRect(-width / 2, -height / 2, width, height);
    // Round handles centered on the corners, with a soft shadow to lift them off the board.
    // A path half a border smaller makes the border fall inside the diameter.
    const radius = pathRadius(HANDLE_RADIUS_PX * scale, zoom);
    context.fillStyle = this.handleFill;
    for (const handle of CORNER_HANDLES) {
      const [signX, signY] = HANDLE_SIGNS[handle];
      context.beginPath();
      context.arc((signX * width) / 2, (signY * height) / 2, radius, 0, Math.PI * 2);
      context.save();
      context.shadowColor = 'rgba(0, 0, 0, 0.2)';
      context.shadowBlur = 3 * this.ratio;
      context.shadowOffsetY = this.ratio;
      context.fill();
      context.restore();
      context.stroke();
    }
    context.restore();
  }

  /** A label under the selection (its size while resizing, its angle while rotating). */
  private drawBadge(text: string, zoom: number): void {
    const bounds = this.scene.bounds(this.selection);
    if (!bounds) return;
    const { context } = this;
    context.save();
    context.font = `600 ${11 / zoom}px Geist, Inter, system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const width = context.measureText(text).width + 14 / zoom;
    const height = 20 / zoom;
    const x = (bounds.minX + bounds.maxX) / 2;
    const y = bounds.maxY + 14 / zoom + height / 2;
    context.fillStyle = this.accent;
    context.beginPath();
    context.roundRect(x - width / 2, y - height / 2, width, height, 5 / zoom);
    context.fill();
    context.fillStyle = '#fff';
    context.fillText(text, x, y + 0.5 / zoom);
    context.restore();
  }

  /** The polygon's corner-count handle (a diamond), and the count while it is dragged. */
  private drawCountHandle(shape: ShapeElement, zoom: number): void {
    const { context } = this;
    const point = countHandlePoint(shape, zoom);
    // A diamond as big to the eye as the round handles: its diagonal 1.2× their diameter
    // (about the same area), border inside.
    const side =
      (1.2 * Math.SQRT2 * HANDLE_RADIUS_PX * handleScale(zoom) - HANDLE_BORDER_PX) / zoom;
    context.save();
    context.translate(point.x, point.y);
    context.rotate(shape.rotation + Math.PI / 4);
    context.beginPath();
    context.rect(-side / 2, -side / 2, side, side);
    context.fillStyle = this.countActive ? this.accent : this.handleFill;
    context.fill();
    context.lineWidth = 1.5 / zoom;
    context.strokeStyle = this.accent;
    context.stroke();
    context.restore();
    if (this.countLabel === null) return;
    const text = String(this.countLabel);
    context.save();
    context.font = `600 ${12 / zoom}px Geist, Inter, system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const width = context.measureText(text).width + 12 / zoom;
    const height = 20 / zoom;
    const x = point.x + 18 / zoom;
    const y = point.y - 18 / zoom;
    context.fillStyle = this.accent;
    context.beginPath();
    context.roundRect(x - width / 2, y - height / 2, width, height, 4 / zoom);
    context.fill();
    context.fillStyle = '#fff';
    context.fillText(text, x, y);
    context.restore();
  }

  /** The decoded image for crop mode (loads once; redraws when it arrives). */
  private imageOf(source: string): HTMLImageElement | null {
    let image = this.images.get(source);
    if (!image) {
      image = new Image();
      image.decoding = 'async';
      image.onload = () => this.request();
      image.src = source;
      this.images.set(source, image);
    }
    return image.complete && image.naturalWidth > 0 ? image : null;
  }

  /**
   * Crop mode, as in Figma: the image outside the frame shows faded with a thin outline,
   * and the frame gets crop handles (corner brackets and side bars).
   */
  private drawCrop(zoom: number): void {
    const element = this.cropping ? this.scene.get(this.cropping) : undefined;
    if (!element || !isShape(element) || element.type !== 'image' || !element.media) return;
    const { context } = this;
    const image = this.imageOf(element.media.source);
    const imageBounds = imageRectangle(
      element,
      imageSize(element, image ? { width: image.naturalWidth, height: image.naturalHeight } : null),
    );
    context.save();
    context.translate(element.x + element.width / 2, element.y + element.height / 2);
    context.rotate(element.rotation);
    context.translate(-element.width / 2, -element.height / 2);
    // The part of the image outside the frame: faded.
    context.save();
    context.beginPath();
    context.rect(imageBounds.x, imageBounds.y, imageBounds.width, imageBounds.height);
    context.rect(0, 0, element.width, element.height);
    context.clip('evenodd');
    context.globalAlpha = 0.35;
    if (image)
      context.drawImage(image, imageBounds.x, imageBounds.y, imageBounds.width, imageBounds.height);
    else {
      context.fillStyle = 'rgba(120, 120, 128, 0.5)';
      context.fillRect(imageBounds.x, imageBounds.y, imageBounds.width, imageBounds.height);
    }
    context.restore();
    context.lineWidth = 1 / zoom;
    context.strokeStyle = this.accent;
    context.globalAlpha = 0.5;
    context.strokeRect(imageBounds.x, imageBounds.y, imageBounds.width, imageBounds.height);
    context.globalAlpha = 1;
    // The image's own corner handles: drag to scale it (Figma).
    const scale = handleScale(zoom);
    const size = (CORNER_HANDLE_PX * scale) / zoom;
    context.fillStyle = this.handleFill;
    context.strokeStyle = this.accent;
    context.lineWidth = 1.5 / zoom;
    for (const [x, y] of [
      [imageBounds.x, imageBounds.y],
      [imageBounds.x + imageBounds.width, imageBounds.y],
      [imageBounds.x, imageBounds.y + imageBounds.height],
      [imageBounds.x + imageBounds.width, imageBounds.y + imageBounds.height],
    ] as const) {
      context.beginPath();
      context.roundRect(x - size / 2, y - size / 2, size, size, 2 / zoom);
      context.fill();
      context.stroke();
    }
    // The crop frame.
    context.lineWidth = 1.5 / zoom;
    context.strokeStyle = this.accent;
    context.strokeRect(0, 0, element.width, element.height);
    // Handles: white brackets with a dark edge, readable on any image.
    const length = Math.min((CROP_HANDLE_PX * scale) / zoom, element.width / 3, element.height / 3);
    const bar = length / 2;
    context.lineCap = 'square';
    const path = () => {
      context.beginPath();
      for (const [x, y, deltaX, deltaY] of [
        [0, 0, 1, 1],
        [element.width, 0, -1, 1],
        [0, element.height, 1, -1],
        [element.width, element.height, -1, -1],
      ] as const) {
        context.moveTo(x + deltaX * length, y);
        context.lineTo(x, y);
        context.lineTo(x, y + deltaY * length);
      }
      context.moveTo(element.width / 2 - bar, 0);
      context.lineTo(element.width / 2 + bar, 0);
      context.moveTo(element.width / 2 - bar, element.height);
      context.lineTo(element.width / 2 + bar, element.height);
      context.moveTo(0, element.height / 2 - bar);
      context.lineTo(0, element.height / 2 + bar);
      context.moveTo(element.width, element.height / 2 - bar);
      context.lineTo(element.width, element.height / 2 + bar);
    };
    path();
    context.lineWidth = 6 / zoom;
    context.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    context.stroke();
    path();
    context.lineWidth = 4 / zoom;
    context.strokeStyle = '#fff';
    context.stroke();
    context.restore();
  }

  private handle(point: Vec2, zoom: number, scale: number): void {
    const { context } = this;
    context.beginPath();
    context.arc(point.x, point.y, pathRadius(HANDLE_RADIUS_PX * scale, zoom), 0, Math.PI * 2);
    context.fillStyle = this.handleFill;
    context.fill();
    context.lineWidth = 1.5 / zoom;
    context.strokeStyle = this.accent;
    context.stroke();
  }

  /** Filled handle in the middle of a line: a dot for curves, a pill across the elbow's middle segment. */
  private bendHandle(point: Vec2, axis: 'x' | 'y' | undefined, zoom: number, scale: number): void {
    const { context } = this;
    context.beginPath();
    if (axis) {
      const long = (12 * scale) / zoom;
      const short = (6 * scale) / zoom;
      const width = axis === 'x' ? short : long;
      const height = axis === 'x' ? long : short;
      context.roundRect(point.x - width / 2, point.y - height / 2, width, height, short / 2);
    } else {
      context.arc(point.x, point.y, pathRadius(HANDLE_RADIUS_PX * scale, zoom), 0, Math.PI * 2);
    }
    context.fillStyle = this.accent;
    context.fill();
    context.lineWidth = 1.5 / zoom;
    context.strokeStyle = '#fff';
    context.stroke();
  }

  /** Hovered connection dot: larger, filled, with a plus — "drag to connect, click to add". */
  private plusDot(point: Vec2, zoom: number, scale: number): void {
    const { context } = this;
    const radius = (HANDLE_ACTIVE_RADIUS_PX * scale) / zoom;
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = this.accent;
    context.fill();
    context.strokeStyle = '#fff';
    context.lineWidth = 1.5 / zoom;
    const arm = radius * 0.5;
    context.beginPath();
    context.moveTo(point.x - arm, point.y);
    context.lineTo(point.x + arm, point.y);
    context.moveTo(point.x, point.y - arm);
    context.lineTo(point.x, point.y + arm);
    context.stroke();
  }

  private dot(
    point: Vec2,
    zoom: number,
    color: string,
    alpha = 1,
    filled = false,
    radiusPx = filled ? HANDLE_ACTIVE_RADIUS_PX : HANDLE_RADIUS_PX,
  ): void {
    const { context } = this;
    context.save();
    context.globalAlpha = alpha;
    context.beginPath();
    context.arc(point.x, point.y, pathRadius(radiusPx, zoom), 0, Math.PI * 2);
    context.fillStyle = filled ? color : this.handleFill;
    context.fill();
    context.lineWidth = 1.5 / zoom;
    context.strokeStyle = color;
    context.stroke();
    context.restore();
  }

  /** Smart guides: thin lines with small crosses at the aligned points, as in Figma. */
  private drawGuides(zoom: number): void {
    if (this.guides.length === 0) return;
    const { context } = this;
    const arm = 3 / zoom; // half size of a cross
    context.save();
    context.strokeStyle = GUIDE;
    context.lineWidth = 1 / zoom;
    context.beginPath();
    for (const guide of this.guides) {
      if (guide.axis === 'x') {
        context.moveTo(guide.at, guide.from);
        context.lineTo(guide.at, guide.to);
        for (const mark of guide.marks) {
          context.moveTo(guide.at - arm, mark - arm);
          context.lineTo(guide.at + arm, mark + arm);
          context.moveTo(guide.at + arm, mark - arm);
          context.lineTo(guide.at - arm, mark + arm);
        }
      } else {
        context.moveTo(guide.from, guide.at);
        context.lineTo(guide.to, guide.at);
        for (const mark of guide.marks) {
          context.moveTo(mark - arm, guide.at - arm);
          context.lineTo(mark + arm, guide.at + arm);
          context.moveTo(mark + arm, guide.at - arm);
          context.lineTo(mark - arm, guide.at + arm);
        }
      }
    }
    context.stroke();
    context.restore();
  }

  /**
   * Equal spacing, as in Figma: each equal gap gets a line across it with end ticks and
   * a label with the distance.
   */
  private drawSpacing(zoom: number): void {
    if (this.spacing.length === 0) return;
    const { context } = this;
    const tick = 4 / zoom;
    context.save();
    context.strokeStyle = GUIDE;
    context.lineWidth = 1 / zoom;
    context.beginPath();
    for (const guide of this.spacing) {
      for (const segment of guide.segments) {
        if (guide.axis === 'x') {
          context.moveTo(segment.from, segment.at);
          context.lineTo(segment.to, segment.at);
          for (const edge of [segment.from, segment.to]) {
            context.moveTo(edge, segment.at - tick);
            context.lineTo(edge, segment.at + tick);
          }
        } else {
          context.moveTo(segment.at, segment.from);
          context.lineTo(segment.at, segment.to);
          for (const edge of [segment.from, segment.to]) {
            context.moveTo(segment.at - tick, edge);
            context.lineTo(segment.at + tick, edge);
          }
        }
      }
    }
    context.stroke();
    // Labels: white text on a red pill, centered on each gap.
    context.font = `500 ${11 / zoom}px Geist, Inter, system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const guide of this.spacing) {
      const text = String(Math.round(guide.distance));
      const width = context.measureText(text).width + 8 / zoom;
      const height = 16 / zoom;
      for (const segment of guide.segments) {
        const middle = (segment.from + segment.to) / 2;
        const [centerX, centerY] =
          guide.axis === 'x'
            ? [middle, segment.at + height]
            : [segment.at + width / 2 + 6 / zoom, middle];
        context.fillStyle = GUIDE;
        context.beginPath();
        context.roundRect(centerX - width / 2, centerY - height / 2, width, height, 3 / zoom);
        context.fill();
        context.fillStyle = '#fff';
        context.fillText(text, centerX, centerY);
      }
    }
    context.restore();
  }

  /** Dashed box around a group's elements. */
  private groupFrame(ids: readonly string[], zoom: number, alpha: number): void {
    const bounds = this.scene.bounds(ids);
    if (!bounds) return;
    const margin = 4 / zoom;
    const { context } = this;
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = this.accent;
    context.lineWidth = 1 / zoom;
    context.setLineDash([4 / zoom, 3 / zoom]);
    context.strokeRect(
      bounds.minX - margin,
      bounds.minY - margin,
      bounds.maxX - bounds.minX + margin * 2,
      bounds.maxY - bounds.minY + margin * 2,
    );
    context.restore();
  }

  /**
   * Elements outlined and framed like a selection, in `color`, without handles (e.g. what a
   * preview removes). For an overlay layer (world transform set).
   */
  drawTintedSelection(ids: ReadonlySet<string>, color: string): void {
    if (ids.size === 0) return;
    const { context, camera } = this;
    const zoom = camera.zoom;
    this.outlineElements(ids, 1, color);
    const frame = selectionEdgeFrame(this.scene, ids);
    if (!frame) return;
    context.save();
    context.translate(frame.centerX, frame.centerY);
    context.rotate(frame.rotation);
    context.strokeStyle = color;
    const line = HANDLE_BORDER_PX / zoom;
    context.lineWidth = line;
    context.strokeRect(
      -(frame.width + line) / 2,
      -(frame.height + line) / 2,
      frame.width + line,
      frame.height + line,
    );
    context.restore();
  }

  /**
   * Outlines elements: shapes just outside their outer edge (their border included),
   * connectors with a halo. Every outline of a kind goes into one path, so a selection of
   * thousands costs one stroke instead of thousands. At most `MAX_OUTLINES` elements in
   * view are drawn.
   */
  private outlineElements(ids: Iterable<string>, alpha: number, color: string): void {
    const { context, camera, scene } = this;
    const width = OUTLINE_PX / camera.zoom;
    const view = camera.viewportBounds();
    const shapes: ShapeElement[] = [];
    const connectors: OutlinedConnector[] = [];
    for (const id of ids) {
      if (shapes.length + connectors.length >= MAX_OUTLINES) break;
      const element = scene.get(id);
      const bounds = scene.getBounds(id);
      if (!element || !bounds || !boxIntersects(bounds, view)) continue;
      if (isShape(element)) {
        shapes.push(element);
        continue;
      }
      const geometry = scene.connectorGeometry(id);
      if (geometry) connectors.push({ element, geometry, bounds });
    }
    if (shapes.length === 0 && connectors.length === 0) return;
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = color;
    if (shapes.length > 0) this.outlineShapes(shapes, width);
    if (connectors.length > 0) this.haloConnectors(connectors, width, alpha);
    context.restore();
  }

  private outlineShapes(shapes: readonly ShapeElement[], width: number): void {
    const { context } = this;
    const zoom = this.camera.zoom;
    const grow = (shape: ShapeElement) => shape.strokeWidth / 2 + width / 2;
    this.setWorldTransform();
    context.beginPath();
    const exact: ShapeElement[] = [];
    for (const shape of shapes) {
      // Too small on screen for its exact outline to show: its box, in world coordinates.
      if (Math.max(shape.width, shape.height) * zoom < EXACT_OUTLINE_MIN_PX)
        traceBox(context, shape, grow(shape));
      else exact.push(shape);
    }
    for (const shape of exact) {
      // A path keeps the transform it was built with: each outline is placed with its own,
      // and all of them are stroked at once.
      this.setWorldTransform();
      context.translate(shape.x + shape.width / 2, shape.y + shape.height / 2);
      context.rotate(shape.rotation);
      traceShape(context, shape, grow(shape));
    }
    this.setWorldTransform();
    context.lineWidth = width;
    context.stroke();
  }

  /**
   * Halos along connectors, wider than their stroke (narrower on lines small on screen, like
   * their handles). Halos of one width share a path, so where they cross they merge into one
   * layer instead of darkening; each width first clears its area for the same reason.
   */
  private haloConnectors(connectors: readonly OutlinedConnector[], width: number, alpha: number) {
    const { context, camera, scene } = this;
    const scale = handleScale(camera.zoom);
    const haloOf = (connector: ConnectorElement) => connector.strokeWidth + width * 4 * scale;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    for (const [halo, geometries] of groupBy(connectors, ({ element }) => haloOf(element))) {
      context.beginPath();
      for (const { geometry } of geometries) traceConnector(context, geometry);
      context.lineWidth = halo;
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'destination-out';
      context.stroke();
      context.globalAlpha = alpha * 0.35;
      context.globalCompositeOperation = 'source-over';
      context.stroke();
    }
    // The halos lie under the lines: their own and every other line they cross are cut out
    // of them (a halo drawn over a dark line reads as a stray stripe). The cut is half a
    // pixel narrower than the line, so the halo tucks under its antialiased edge instead of
    // leaving a seam of background between them.
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'destination-out';
    const tuck = 1 / camera.zoom;
    const cut = new Set<string>();
    const lines: OutlinedConnector[] = [];
    for (const { element, bounds } of connectors) {
      for (const line of scene.queryBox(inflateBox(bounds, haloOf(element) / 2))) {
        if (line.type !== 'connector' || cut.has(line.id) || line.strokeWidth <= tuck) continue;
        cut.add(line.id);
        const geometry = scene.connectorGeometry(line.id);
        if (geometry) lines.push({ element: line, geometry, bounds });
      }
    }
    for (const [strokeWidth, group] of groupBy(lines, ({ element }) => element.strokeWidth)) {
      context.beginPath();
      for (const { geometry } of group) traceConnector(context, geometry);
      context.lineWidth = strokeWidth - tuck;
      context.stroke();
    }
    for (const { element, geometry } of lines) {
      const last = geometry.points[geometry.points.length - 1]!;
      traceCap(
        context,
        element.startCap,
        geometry.points[0]!,
        geometry.startDirection,
        element.strokeWidth,
        tuck,
      );
      traceCap(context, element.endCap, last, geometry.endDirection, element.strokeWidth, tuck);
    }
  }
}

/** A connector to outline, resolved. */
interface OutlinedConnector {
  element: ConnectorElement;
  geometry: ConnectorGeometry;
  bounds: Box;
}

/** `items` grouped by `keyOf`, in the order the keys first appear. */
function groupBy<Item, Key>(items: readonly Item[], keyOf: (item: Item) => Key): Map<Key, Item[]> {
  const groups = new Map<Key, Item[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
