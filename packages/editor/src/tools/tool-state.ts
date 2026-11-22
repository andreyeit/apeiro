import {
  defaultTextBlock,
  type CapKind,
  type ConnectorRoute,
  type LineDash,
  type ShapeElement,
  type TextBlock,
  type Vec2,
} from '@apeiro/core';
import { SHAPE_PRESETS, STICKY_STYLE, type ShapePreset } from './shapes';

/** Tools that put a new element on the board: a click drops a default one, a drag sizes it. */
const PLACE_KINDS = ['sticky', 'rect', 'ellipse', 'polygon'] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

const BUILTIN_TOOLS = [
  'select',
  'hand',
  'connector',
  'text',
  'pen',
  'eraser',
  'comment',
  ...PLACE_KINDS,
] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/** Built-in names keep autocomplete; registered tools may use any other name. */
export type Tool = BuiltinTool | (string & {});

const BUILTIN_TOOL_SET: ReadonlySet<string> = new Set(BUILTIN_TOOLS);
/** Tools that stay active after a gesture unless told otherwise. */
const REPEATING_TOOLS: ReadonlySet<string> = new Set([
  'select',
  'hand',
  'pen',
  'eraser',
  'connector',
]);

export interface ToolActivation {
  /** Keep creating after a gesture. Shapes/text default to false; pen/eraser/connector to true. */
  repeat?: boolean;
}

export interface ToolPointer {
  /** Pointer position in world coordinates. */
  point: Vec2;
  event: PointerEvent;
}

/** Pointer handlers run outside React. Register once and return the cleanup from an effect. */
export interface CustomTool {
  cursor?: string;
  onPointerDown?: (input: ToolPointer) => void;
  onPointerMove?: (input: ToolPointer) => void;
  onPointerUp?: (input: ToolPointer) => void;
  /** Called on Escape, pointer cancellation, unmount or switching tools during a gesture. */
  onCancel?: () => void;
}

export type ShapeToolStyle = Partial<
  Pick<
    ShapeElement,
    'width' | 'height' | 'fill' | 'stroke' | 'strokeWidth' | 'strokeStyle' | 'radius' | 'sides'
  >
>;
/** Style overrides of the tools that create elements (see `ToolDefaults` for the full style). */
export interface ToolStyles {
  rect: ShapeToolStyle;
  ellipse: ShapeToolStyle;
  polygon: ShapeToolStyle;
  sticky: ShapeToolStyle;
  text: Partial<Omit<TextBlock, 'runs' | 'paragraphs'>>;
  connector: Partial<ConnectorStyle>;
  pen: Partial<PenStyle>;
}

/** A shape tool's full style: what a new shape of it looks like. */
export type ShapeToolDefaults = Pick<
  ShapeElement,
  'width' | 'height' | 'fill' | 'stroke' | 'strokeWidth' | 'radius' | 'strokeStyle' | 'sides'
>;

/** The full style of each tool that creates elements: built-in values with your overrides. */
export interface ToolDefaults {
  rect: ShapeToolDefaults;
  ellipse: ShapeToolDefaults;
  polygon: ShapeToolDefaults;
  sticky: ShapeToolDefaults;
  text: Omit<TextBlock, 'runs' | 'paragraphs'>;
  connector: ConnectorStyle;
  pen: PenStyle;
}

const PLACE_KIND_SET: ReadonlySet<string> = new Set(PLACE_KINDS);
export const isPlaceTool = (tool: Tool): tool is PlaceKind => PLACE_KIND_SET.has(tool);

/** Tools that don't change the board: the only ones a read-only board offers. */
export const VIEW_TOOLS: ReadonlySet<Tool> = new Set<Tool>(['select', 'hand', 'comment']);

/** Pen widths offered (world units): thin, medium (the default), bold, marker. */
export const PEN_WIDTHS: readonly number[] = [2, 4, 8, 16];

export interface PenStyle {
  stroke: number;
  strokeWidth: number;
}

export interface ConnectorStyle {
  route: ConnectorRoute;
  startCap: CapKind;
  endCap: CapKind;
  dash: LineDash;
  stroke: number;
  strokeWidth: number;
  /** Radius of rounded elbow bends (Miro-style); 0: sharp corners. */
  cornerRadius: number;
}

/** The design's connectors: 1.5px color/foreground, an open arrow, rounded bends. */
const CONNECTOR_STYLE: Readonly<ConnectorStyle> = Object.freeze({
  route: 'elbow',
  startCap: 'none',
  endCap: 'arrow',
  dash: 'solid',
  stroke: 0x18181bff,
  strokeWidth: 1.5,
  cornerRadius: 8,
});

const PEN_STYLE: Readonly<PenStyle> = Object.freeze({
  stroke: 0x18181bff,
  strokeWidth: PEN_WIDTHS[1]!,
});

/** What a tool creates when nothing is overridden. */
function builtInStyle(tool: keyof ToolStyles): object {
  switch (tool) {
    case 'sticky':
      return STICKY_STYLE;
    case 'text': {
      const style: Partial<TextBlock> = defaultTextBlock('text');
      delete style.runs;
      delete style.paragraphs;
      return style;
    }
    case 'connector':
      return CONNECTOR_STYLE;
    case 'pen':
      return PEN_STYLE;
    default: {
      const style: Partial<ShapePreset> = { ...SHAPE_PRESETS[tool] };
      delete style.type;
      return style;
    }
  }
}

/** UI state shared between the controls and the HUD. */
export class ToolState {
  tool: Tool = 'select';
  repeat = true;
  private readonly custom = new Map<string, CustomTool>();
  private readonly defaults: { [K in keyof ToolStyles]: Readonly<ToolStyles[K]> } = {
    rect: Object.freeze({}),
    ellipse: Object.freeze({}),
    polygon: Object.freeze({}),
    sticky: Object.freeze({}),
    text: Object.freeze({}),
    connector: Object.freeze({}),
    pen: Object.freeze({}),
  };
  /** Full styles, made when asked for and dropped when an override changes. */
  private readonly resolved = new Map<keyof ToolStyles, object>();
  /** Style of new connectors (the controls read it while drawing one). */
  style: ConnectorStyle = { ...CONNECTOR_STYLE };
  /** Style of new pen strokes. */
  pen: PenStyle = { ...PEN_STYLE };
  onChange: () => void = () => undefined;

  setTool(tool: Tool, options: ToolActivation = {}): void {
    if (!BUILTIN_TOOL_SET.has(tool) && !this.custom.has(tool))
      throw new Error(`Unknown tool: ${tool}. Register it before activating it.`);
    const repeat = options.repeat ?? REPEATING_TOOLS.has(tool);
    if (this.tool === tool && this.repeat === repeat) return;
    this.tool = tool;
    this.repeat = repeat;
    this.onChange();
  }

  /** Completes one creation gesture without changing a repeating tool. */
  complete(): void {
    if (!this.repeat) this.setTool('select');
  }

  /** Settings for future elements only. Never edits the scene or selection. */
  setDefaults<K extends keyof ToolStyles>(tool: K, patch: ToolStyles[K]): void {
    const previous = this.defaults[tool];
    if (
      Object.keys(patch).every((key) =>
        Object.is(previous[key as keyof typeof previous], patch[key as keyof typeof patch]),
      )
    )
      return;
    this.defaults[tool] = Object.freeze({ ...previous, ...patch });
    this.resolved.delete(tool);
    if (tool === 'connector') Object.assign(this.style, patch);
    if (tool === 'pen') Object.assign(this.pen, patch);
    this.onChange();
  }

  /**
   * The full style new elements of `tool` get: built-in values with the overrides of
   * `setDefaults`. Same object until an override changes.
   */
  getDefaults<K extends keyof ToolStyles>(tool: K): Readonly<ToolDefaults[K]> {
    let style = this.resolved.get(tool);
    if (!style) {
      style = Object.freeze({ ...builtInStyle(tool), ...this.defaults[tool] });
      this.resolved.set(tool, style);
    }
    return style as Readonly<ToolDefaults[K]>;
  }

  /** Only what `setDefaults` changed (stable, read-only). */
  overrides<K extends keyof ToolStyles>(tool: K): Readonly<ToolStyles[K]> {
    return this.defaults[tool];
  }

  register(name: string, definition: CustomTool): () => void {
    if (!name || BUILTIN_TOOL_SET.has(name) || this.custom.has(name))
      throw new Error(`Tool ${name} is already registered or reserved`);
    const registered = { ...definition };
    this.custom.set(name, registered);
    return () => {
      if (this.custom.get(name) !== registered) return;
      this.custom.delete(name);
      if (this.tool === name) this.setTool('select');
    };
  }

  customTool(name: Tool = this.tool): CustomTool | undefined {
    return this.custom.get(name);
  }
}
