import type {
  CapKind,
  ConnectorRoute,
  LineDash,
  ShapeElement,
  TextBlock,
  Vec2,
} from '@apeiro/core';

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
export interface ToolStyles {
  rect: ShapeToolStyle;
  ellipse: ShapeToolStyle;
  polygon: ShapeToolStyle;
  sticky: ShapeToolStyle;
  text: Partial<Omit<TextBlock, 'runs' | 'paragraphs'>>;
  connector: Partial<ConnectorStyle>;
  pen: Partial<PenStyle>;
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
  style: ConnectorStyle = {
    route: 'elbow',
    startCap: 'none',
    endCap: 'arrow',
    dash: 'solid',
    // The design's connectors: 1.5px color/foreground, an open arrow, rounded bends.
    stroke: 0x18181bff,
    strokeWidth: 1.5,
    cornerRadius: 8,
  };
  pen: PenStyle = { stroke: 0x18181bff, strokeWidth: PEN_WIDTHS[1]! };
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
    if (tool === 'connector') Object.assign(this.style, patch);
    if (tool === 'pen') Object.assign(this.pen, patch);
    this.onChange();
  }

  /** Stable, read-only overrides; built-in appearance applies to fields not configured here. */
  getDefaults<K extends keyof ToolStyles>(tool: K): Readonly<ToolStyles[K]> {
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
