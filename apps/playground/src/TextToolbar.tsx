import { FONT_FAMILIES, type BooleanStyle, type ListKind, type TextAlign } from '@apeiro/core';
import type { TextFormatCommand } from '@apeiro/editor';
import { useBoard, useBoardState, useElementScreenBounds, useTextFormat } from '@apeiro/react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

const COLORS = [0x1f2937ff, 0xdc2626ff, 0xea580cff, 0x16a34aff, 0x2563ebff, 0x7c3aedff];

const STYLES: Array<[BooleanStyle, string, string]> = [
  ['bold', 'B', 'Жирный (Ctrl+B)'],
  ['italic', 'I', 'Курсив (Ctrl+I)'],
  ['underline', 'U', 'Подчёркнутый (Ctrl+U)'],
  ['strike', 'S', 'Зачёркнутый (Ctrl+Shift+X)'],
];
const LISTS: Array<[ListKind, string, string]> = [
  ['bullet', '•', 'Маркированный список (Ctrl+Shift+8)'],
  ['ordered', '1.', 'Нумерованный список (Ctrl+Shift+7)'],
];
const ALIGNS: Array<[TextAlign, string]> = [
  ['left', 'По левому краю'],
  ['center', 'По центру'],
  ['right', 'По правому краю'],
];

/** Four lines aligned like the text. */
function AlignIcon({ align }: { align: TextAlign }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16">
      {[14, 9, 12, 7].map((length, i) => (
        <rect
          key={i}
          x={align === 'left' ? 1 : align === 'right' ? 15 - length : (16 - length) / 2}
          y={2 + i * 3.5}
          width={length}
          height={1.6}
          rx={0.8}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

const css = (color: number) => `#${(color >>> 0).toString(16).padStart(8, '0')}`;

/** Keys typed in a field are not board shortcuts. */
const swallow = (event: KeyboardEvent) => event.stopPropagation();

/**
 * The app's formatting toolbar, over the text being edited. The board has none of its
 * own: this reads `useTextFormat` and changes it with `text.format`.
 */
export function TextToolbar() {
  const format = useTextFormat();
  const id = useBoardState((board) => board.editing);
  const box = useElementScreenBounds(id);
  const board = useBoard();
  const reference = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, board: 0 });
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const [linkInvalid, setLinkInvalid] = useState(false);

  useLayoutEffect(() => {
    const element = reference.current;
    if (!element) return;
    const next = {
      width: element.offsetWidth,
      height: element.offsetHeight,
      board: element.parentElement?.clientWidth ?? 0,
    };
    setSize((current) =>
      current.width === next.width && current.height === next.height && current.board === next.board
        ? current
        : next,
    );
  });
  useEffect(() => setLinkOpen(false), [id]);

  if (!format || !box) return null;
  const apply = (command: TextFormatCommand) => board.text.format(command);

  // Above the text, or under it when there is no room; kept inside the board sideways.
  const top = box.minY - 12 - size.height >= 8 ? box.minY - 12 - size.height : box.maxY + 12;
  const centered = (box.minX + box.maxX) / 2 - size.width / 2;
  const left = Math.max(8, Math.min(centered, size.board - size.width - 8));

  const openLink = () => {
    setLink(format.link ?? '');
    setLinkInvalid(false);
    setLinkOpen(true);
  };
  const applyLink = (href: string | null) => {
    if (apply({ type: 'link', href })) setLinkOpen(false);
    else setLinkInvalid(true);
  };

  return (
    <div
      ref={reference}
      className="text-toolbar"
      style={{ left, top }}
      // Pressing it keeps the text open; buttons don't take the focus (the selection stays).
      data-ap-text-controls
      onMouseDown={(event) => {
        if (
          !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)
        )
          event.preventDefault();
      }}
    >
      <div className="row">
        <select
          value={format.font ?? ''}
          title="Шрифт"
          onKeyDown={swallow}
          onChange={(event) => apply({ type: 'font', font: event.target.value })}
        >
          {format.font === null && <option value="">—</option>}
          {FONT_FAMILIES.map((family) => (
            <option key={family.id} value={family.id} style={{ fontFamily: family.css }}>
              {family.label}
            </option>
          ))}
        </select>
        <button
          title="Меньше (Ctrl+Shift+<)"
          onClick={() => apply({ type: 'stepSize', direction: -1 })}
        >
          A−
        </button>
        <SizeField
          size={format.fontSize}
          auto={format.autoSize}
          onSize={(size) => apply({ type: 'fontSize', size })}
        />
        <button
          title="Больше (Ctrl+Shift+>)"
          onClick={() => apply({ type: 'stepSize', direction: 1 })}
        >
          A+
        </button>
        <button
          className={format.autoSize ? 'wide active' : 'wide'}
          title="Автоматический размер: текст заполняет стикер"
          onClick={() => apply({ type: 'fontSize', size: 'auto' })}
        >
          Авто
        </button>
        <span className="sep" />
        {STYLES.map(([style, label, title]) => (
          <button
            key={style}
            data-style={style}
            className={format[style] ? 'active' : ''}
            title={title}
            onClick={() => apply({ type: 'toggle', style })}
          >
            {label}
          </button>
        ))}
        <button className={format.link ? 'active' : ''} title="Ссылка" onClick={openLink}>
          🔗
        </button>
        <span className="sep" />
        {LISTS.map(([kind, label, title]) => (
          <button
            key={kind}
            className={format.list === kind ? 'active' : ''}
            title={title}
            onClick={() => apply({ type: 'list', kind })}
          >
            {label}
          </button>
        ))}
        <span className="sep" />
        {ALIGNS.map(([align, title]) => (
          <button
            key={align}
            className={format.align === align ? 'active' : ''}
            title={title}
            onClick={() => apply({ type: 'align', align })}
          >
            <AlignIcon align={align} />
          </button>
        ))}
        <span className="sep" />
        {COLORS.map((color) => (
          <button
            key={color}
            className={format.color === color ? 'swatch active' : 'swatch'}
            style={{ background: css(color) }}
            title="Цвет текста"
            onClick={() => apply({ type: 'color', color })}
          />
        ))}
      </div>
      {linkOpen && (
        <div className="row">
          <input
            autoFocus
            type="url"
            className={linkInvalid ? 'link invalid' : 'link'}
            placeholder="https://… или e-mail"
            value={link}
            onChange={(event) => {
              setLink(event.target.value);
              setLinkInvalid(false);
            }}
            onKeyDown={(event) => {
              swallow(event);
              if (event.key === 'Enter') applyLink(link);
              if (event.key === 'Escape') setLinkOpen(false);
            }}
          />
          <button title="Применить (Enter)" onClick={() => applyLink(link)}>
            ✓
          </button>
          <button title="Убрать ссылку" onClick={() => applyLink(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/** Font size field: shows the size at the selection ("Авто" while it is automatic), applies on Enter or when left. */
function SizeField({
  size,
  auto,
  onSize,
}: {
  size: number | null;
  auto: boolean;
  onSize: (size: number) => void;
}) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const shown = focused ? value : size === null || auto ? '' : String(size);
  const commit = () => {
    const parsed = Number(value);
    if (value.trim() !== '' && Number.isFinite(parsed) && parsed > 0 && parsed !== size)
      onSize(parsed);
  };
  return (
    <input
      className="size"
      type="number"
      min={1}
      max={1000}
      title="Размер шрифта (выделенного текста или всего)"
      placeholder={auto ? 'Авто' : ''}
      value={shown}
      onFocus={() => {
        setValue(size === null ? '' : String(size));
        setFocused(true);
      }}
      onBlur={() => {
        commit();
        setFocused(false);
      }}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        swallow(event);
        if (event.key === 'Enter') {
          commit();
          setFocused(false);
        }
      }}
    />
  );
}
