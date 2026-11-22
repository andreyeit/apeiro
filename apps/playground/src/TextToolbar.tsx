import { FONT_FAMILIES, type BooleanStyle, type ListKind, type TextAlign } from '@apeiro/core';
import type { TextFormatCommand } from '@apeiro/editor';
import { useBoard, useFloating, useTextEditing } from '@apeiro/react';
import { useEffect, useRef, useState } from 'react';

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

/**
 * The app's formatting toolbar, over the text being edited. The board has none of its
 * own: this reads `useTextEditing` and changes the text with `board.text.apply`.
 */
export function TextToolbar() {
  const editing = useTextEditing();
  const floating = useFloating(editing?.bounds);
  const board = useBoard();
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const [linkInvalid, setLinkInvalid] = useState(false);
  const id = editing?.id;
  useEffect(() => setLinkOpen(false), [id]);

  if (!editing) return null;
  const { format } = editing;
  const apply = (command: TextFormatCommand) => board.text.apply(command);

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
    // Pressing it keeps the text open, and its buttons keep the text's selection.
    <div ref={floating.ref} className="text-toolbar" style={floating.style} data-ap-text-controls>
      <div className="row">
        <select
          value={format.font ?? ''}
          title="Шрифт"
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

/** Font size field: applies valid edits and native spinner steps without leaving the field. */
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
  // The click that focused the field must not collapse the selection of its value.
  const selectingClick = useRef(false);
  const shown = focused ? value : size === null || auto ? '' : String(size);
  const commit = (next: string) => {
    const parsed = Number(next);
    if (next.trim() !== '' && Number.isFinite(parsed) && parsed > 0 && (parsed !== size || auto))
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
      onFocus={(event) => {
        setValue(size === null ? '' : String(size));
        setFocused(true);
        // Typing replaces the size instead of adding digits to it.
        const input = event.currentTarget;
        selectingClick.current = true;
        requestAnimationFrame(() => input.select());
      }}
      onMouseUp={(event) => {
        if (selectingClick.current) event.preventDefault();
        selectingClick.current = false;
      }}
      onBlur={() => {
        setFocused(false);
      }}
      onChange={(event) => {
        const next = event.target.value;
        setValue(next);
        commit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
