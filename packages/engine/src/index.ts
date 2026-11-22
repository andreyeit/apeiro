/**
 * apeiro: an infinite canvas board for the web (WebGPU with a WebGL2 fallback).
 *
 * - `apeiro`: the framework-free `BoardEditor` and the element data model.
 * - `apeiro/react`: `<Board>` and hooks.
 * - `apeiro/yjs`: optional collaboration binding.
 * - `apeiro/socket.io`: optional room transport; `apeiro/socket.io/server` for Node.
 * - `apeiro/styles.css`: styles of the board and its text editor (import once).
 *
 * Only what an application needs is exported here; the internals (renderer layers,
 * overlay, handles, routing…) are private and may change at any time.
 */

// The board, with its API grouped by what it works on (`editor.selection.delete()`…).
export { BoardEditor } from '@apeiro/editor';
export type {
  BoardEditorEvent,
  BoardEditorOptions,
  BoardDraft,
  BoardThemeName,
  CreateOptions,
  EditorCamera,
  EditorClipboard,
  EditorElements,
  EditorHistory,
  EditorPreview,
  EditorSelection,
  EditorText,
  EditorTools,
  ElementUpdate,
  ExportImageOptions,
  NormalizedDraft,
  Overlay,
  OverlayLayer,
  TextFormatCommand,
  TextFormatState,
  Uploader,
  ZoomTarget,
} from '@apeiro/editor';
export type { BackendKind, BoardRenderer, GridStyle } from '@apeiro/renderer';

// Tools.
export { TEXT_CONTROLS_ATTRIBUTE } from '@apeiro/editor';
export type {
  BuiltinTool,
  ConnectorStyle,
  CustomTool,
  PenStyle,
  PlaceKind,
  ShapeToolDefaults,
  ShapeToolStyle,
  Tool,
  ToolActivation,
  ToolDefaults,
  ToolPointer,
  ToolStyles,
} from '@apeiro/editor';

// Elements: plain data.
export {
  FONT_FAMILIES,
  hexColor,
  isConnector,
  isShape,
  newId,
  rgba,
  validateElement,
} from '@apeiro/core';
export type {
  BoardElement,
  BooleanStyle,
  Box,
  CapKind,
  ConnectorElement,
  ConnectorEnd,
  ConnectorRoute,
  ElementEnd,
  ElementPatch,
  FontFamily,
  LineDash,
  ListKind,
  MediaFile,
  ParagraphStyle,
  PointEnd,
  ShapeElement,
  ShapeKind,
  TextAlign,
  TextBlock,
  TextRun,
  TextSizing,
  TextStyle,
  Vec2,
  VerticalAlign,
} from '@apeiro/core';

// The model behind the editor (`editor.scene`, the `history` option).
export { History, Scene } from '@apeiro/core';
export type {
  BoardClipboard,
  CameraOptions,
  CameraState,
  SceneChanges,
  UndoHistory,
} from '@apeiro/core';
