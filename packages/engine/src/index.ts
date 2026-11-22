/**
 * apeiro: an infinite canvas board for the web (WebGPU with a WebGL2 fallback).
 *
 * - `apeiro`: the framework-free `BoardEditor` and the element data model.
 * - `apeiro/react`: `<Board>` and hooks.
 * - `apeiro/styles.css`: styles of the board and its text editor (import once).
 *
 * Only what an application needs is exported here; the internals (renderer layers,
 * overlay, handles, routing…) are private and may change at any time.
 */

// The board.
export { BoardEditor } from '@apeiro/editor';
export type {
  BoardEditorEvent,
  BoardEditorOptions,
  BoardDraft,
  BoardThemeName,
  ExportImageOptions,
  Overlay,
  OverlayLayer,
  TextFormatCommand,
  TextFormatState,
  ToolState,
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
  ShapeToolStyle,
  Tool,
  ToolActivation,
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

// The model behind the editor (`editor.scene`, `editor.history`, `editor.camera`).
export { History, Scene } from '@apeiro/core';
export type {
  BoardClipboard,
  Camera,
  CameraOptions,
  CameraState,
  SceneChanges,
  UndoHistory,
} from '@apeiro/core';
