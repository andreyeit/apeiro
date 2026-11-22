import {
  defaultTextBlock,
  hexColor,
  type BoardElement,
  type ElementPatch,
  type ConnectorElement,
  type Scene,
  type ShapeElement,
} from '@apeiro/core';
import { SHAPE_PRESETS, STICKY_STYLE } from '@apeiro/editor';
import { useEffect, useId, useRef } from 'react';
import { useBoard } from './editor-context';

export type ElementData = (Omit<ShapeElement, 'z'> | Omit<ConnectorElement, 'z'>) & { z?: number };

export interface ElementProps {
  /** Plain element data, including a stable id. Supports every element kind. */
  element: ElementData;
  /** User edits, undo/redo and remote changes; React prop updates are excluded. */
  onChange?: (element: BoardElement | undefined) => void;
}

interface Owner {
  token: object;
  active: boolean;
  fallbackZ: number;
}
const owners = new WeakMap<Scene, Map<string, Owner>>();
const REACT_ORIGIN = 'react';

/** Plain element data has no cycles or functions. Compare nested props by value. */
function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = Object.entries(left);
  const b = Object.entries(right);
  return (
    a.length === b.length &&
    a.every(
      ([key, value]) =>
        Object.hasOwn(right, key) && equal(value, (right as Record<string, unknown>)[key]),
    )
  );
}

/**
 * Declares an element in the nearest board. Only changed props are applied: unchanged
 * props don't reset a drag, text edit or remote change. A deleted element stays deleted
 * until this component is remounted. Existing elements with the same id are adopted.
 */
export function Element({ element, onChange }: ElementProps) {
  const board = useBoard();
  const latest = useRef({ element, onChange });
  latest.current = { element, onChange };
  const token = useRef({}).current;
  const previous = useRef(element);
  const fallbackZ = useRef(0);
  const { id, type } = element;

  useEffect(() => {
    const scene = board.scene;
    let entries = owners.get(scene);
    if (!entries) owners.set(scene, (entries = new Map()));
    const existing = entries.get(id);
    if (existing?.active && existing.token !== token) {
      throw new Error(`apeiro: element ${id} is already declared by another component`);
    }
    const stored = scene.get(id);
    if (stored && stored.type !== type && !existing) {
      throw new Error(`apeiro: element ${id} already has type ${stored.type}`);
    }
    const owner =
      existing?.token === token
        ? existing
        : { token, active: true, fallbackZ: stored?.z ?? scene.maxZ() + 1 };
    const next = latest.current.element;
    previous.current = next;
    fallbackZ.current = owner.fallbackZ;
    if (!stored || stored.type !== type)
      scene.transact(() => {
        if (stored) scene.remove(id);
        scene.add({ ...next, z: next.z ?? fallbackZ.current });
      }, REACT_ORIGIN);
    owner.active = true;
    entries.set(id, owner);
    const off = scene.subscribe((changes) => {
      if (changes.origin !== REACT_ORIGIN && changes.previous.has(id)) {
        latest.current.onChange?.(scene.get(id));
      }
    });
    return () => {
      off();
      owner.active = false;
      // StrictMode replays effects immediately; keep the element during that replay.
      queueMicrotask(() => {
        if (owner.active || entries.get(id) !== owner) return;
        entries.delete(id);
        if (!board.isDestroyed) scene.transact(() => scene.remove(id), REACT_ORIGIN);
      });
    };
  }, [board, id, type, token]);

  useEffect(() => {
    const before = previous.current;
    previous.current = element;
    const patch: ElementPatch = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(element)])) {
      if (key === 'id' || key === 'type') continue;
      const name = key as keyof ElementPatch;
      const value = (element as unknown as Record<string, unknown>)[key];
      if (!equal((before as unknown as Record<string, unknown>)[key], value)) {
        Object.assign(patch, { [name]: name === 'z' ? (value ?? fallbackZ.current) : value });
      }
    }
    if (Object.keys(patch).length > 0) {
      board.scene.transact(() => board.scene.update(id, patch), REACT_ORIGIN);
    }
  });

  return null;
}

/** Colors accept packed RGBA numbers or #rgb, #rrggbb and #rrggbbaa strings. */
export type ElementColor = number | string;

export interface ShapeProps extends Omit<
  Partial<ShapeElement>,
  'type' | 'fill' | 'stroke' | 'text'
> {
  fill?: ElementColor;
  stroke?: ElementColor;
  text?: string | ShapeElement['text'];
  onChange?: (element: ShapeElement | undefined) => void;
}

export type DeclarativeShapeKind = 'rect' | 'ellipse' | 'polygon' | 'sticky' | 'text';

const color = (value: ElementColor): number =>
  typeof value === 'string' ? hexColor(value) : value;

/** A shape in board coordinates; rotation is in radians, z controls paint order. */
export function Shape({
  type,
  id,
  fill,
  stroke,
  text,
  onChange,
  ...props
}: ShapeProps & { type: DeclarativeShapeKind }) {
  const generated = useId();
  const defaults =
    type === 'sticky'
      ? STICKY_STYLE
      : type === 'text'
        ? { width: 180, height: 40, fill: 0, stroke: 0, strokeWidth: 0, radius: 0 }
        : SHAPE_PRESETS[type];
  const block =
    typeof text === 'string'
      ? {
          ...defaultTextBlock(type),
          ...(type === 'text' ? { sizing: 'fixed' as const } : {}),
          runs: [{ text: text.replace(/\r\n?/g, '\n') }],
        }
      : text;
  return (
    <Element
      element={{
        ...defaults,
        x: 0,
        y: 0,
        rotation: 0,
        ...props,
        id: id ?? `react-${generated}`,
        type,
        ...(fill !== undefined ? { fill: color(fill) } : {}),
        ...(stroke !== undefined ? { stroke: color(stroke) } : {}),
        ...(block !== undefined ? { text: block } : {}),
      }}
      onChange={
        onChange ? (next) => onChange(next?.type === 'connector' ? undefined : next) : undefined
      }
    />
  );
}

export function Rect(props: ShapeProps) {
  return <Shape {...props} type="rect" />;
}
export function Ellipse(props: ShapeProps) {
  return <Shape {...props} type="ellipse" />;
}
export function Polygon(props: ShapeProps) {
  return <Shape {...props} type="polygon" />;
}
export function Sticky(props: ShapeProps) {
  return <Shape {...props} type="sticky" />;
}
export function Text(props: ShapeProps) {
  return <Shape {...props} type="text" />;
}
