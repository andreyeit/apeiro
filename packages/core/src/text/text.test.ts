import { describe, expect, test } from 'vitest';
import {
  applyStyle,
  clampFontSize,
  commonStyle,
  createTextElement,
  defaultTextBlock,
  fitTextPatch,
  fontFamily,
  fontIndex,
  graphemes,
  hasMixedSizes,
  hasStyle,
  hugTextPatch,
  indentList,
  isAllowedLink,
  isColorGlyph,
  layoutText,
  linkAt,
  listMarkers,
  measureTextBox,
  MIXED,
  normalizeLink,
  normalizeParagraphs,
  normalizeRuns,
  paragraphAt,
  paragraphCount,
  remapParagraphs,
  replaceBlockText,
  replaceText,
  stepFontSize,
  stepTextSize,
  textBlock,
  toggleList,
  toggleStyle,
  withFont,
  withFontSize,
  withParagraphs,
  type FontMeasurer,
  type TextBlock,
} from '../index';

/** Every cluster is half an em wide. */
const measurer: FontMeasurer = { advance: () => 0.5, ascent: 0.8, descent: 0.2 };

const block = (text: string, patch: Partial<TextBlock> = {}): TextBlock =>
  textBlock(text, { fontSize: 10, align: 'left', verticalAlign: 'top', ...patch });

describe('layoutText', () => {
  test('breaks lines at spaces and aligns them', () => {
    const layout = layoutText(block('aaaa bbbb'), 30, 100, measurer);
    expect(layout.lineCount).toBe(2);
    expect(layout.glyphs).toHaveLength(8);
    expect(layout.glyphs[4]!.x).toBe(0);
    expect(layout.glyphs[4]!.y).toBeGreaterThan(layout.glyphs[0]!.y);
    const centered = layoutText(block('aa', { align: 'center' }), 30, 100, measurer);
    expect(centered.glyphs[0]!.x).toBe(10);
    const right = layoutText(block('aa', { align: 'right' }), 30, 100, measurer);
    expect(right.glyphs[1]!.x).toBe(25);
  });

  test('line height and vertical alignment', () => {
    const layout = layoutText(block('a'), 100, 100, measurer);
    expect(layout.height).toBeCloseTo(13);
    const bottom = layoutText(block('a', { verticalAlign: 'bottom' }), 100, 100, measurer);
    expect(bottom.lines[0]!.y - layout.lines[0]!.y).toBeCloseTo(87);
  });

  test('autoFit shrinks until the text fits', () => {
    const layout = layoutText(block('aaaaaaaaaa', { autoFit: true }), 40, 100, measurer);
    expect(layout.scale).toBeLessThan(1);
    expect(layout.fits).toBe(true);
    expect(layout.width).toBeLessThanOrEqual(40);
    const tooSmall = layoutText(block('aaaaaaaaaa', { autoFit: true }), 25, 100, measurer);
    expect(tooSmall.fits).toBe(false);
    const grown = layoutText(block('a', { autoFit: true, autoGrow: true }), 100, 100, measurer);
    expect(grown.fontSize).toBeGreaterThan(10);
  });

  test('wide words break by characters, noWrap keeps one line', () => {
    expect(layoutText(block('aaaaaaaaaa'), 20, 100, measurer).lineCount).toBe(3);
    expect(layoutText(block('aaaa bbbb'), 10, 100, measurer, true).lineCount).toBe(1);
  });

  test('decorations, links and list markers', () => {
    const text: TextBlock = {
      ...block('ab\ncd'),
      runs: [{ text: 'ab', underline: true }, { text: '\n' }, { text: 'cd', link: 'https://x.y' }],
      paragraphs: [{ list: 'bullet' }, { list: 'bullet' }],
    };
    const layout = layoutText(text, 200, 100, measurer);
    expect(layout.decorations).toHaveLength(2);
    expect(layout.links).toHaveLength(1);
    expect(layout.links[0]!.href).toBe('https://x.y');
    // Two markers plus four letters.
    expect(layout.glyphs).toHaveLength(6);
    expect(layout.glyphs[0]!.x).toBeLessThan(layout.glyphs[1]!.x);
  });

  test('graphemes keep clusters together', () => {
    expect(graphemes('a👍🏽b')).toEqual(['a', '👍🏽', 'b']);
    expect(isColorGlyph('👍🏽')).toBe(true);
    expect(isColorGlyph('a')).toBe(false);
  });
});

describe('paragraphs and lists', () => {
  test('counts paragraphs and numbers list items by level', () => {
    expect(paragraphCount([{ text: 'a\nb\r\nc' }])).toBe(3);
    expect(paragraphAt([{ text: 'ab\ncd' }], 4)).toBe(1);
    const list: TextBlock = {
      ...block('1\n2\n3\n4\n5'),
      paragraphs: [
        { list: 'ordered' },
        { list: 'ordered', indent: 1 },
        { list: 'ordered', indent: 1 },
        { list: 'ordered', indent: 2 },
        { list: 'bullet' },
      ],
    };
    expect(listMarkers(list)).toEqual(['1.', 'a.', 'b.', 'i.', '•']);
  });

  test('normalizes, remaps, toggles and indents', () => {
    expect(normalizeParagraphs([{}, { list: 'bullet', indent: 9 }, {}], 3)).toEqual([
      {},
      { list: 'bullet', indent: 4 },
    ]);
    expect(normalizeParagraphs([{}, {}], 2)).toBeUndefined();
    // Enter in a list item makes another item.
    expect(remapParagraphs([{ text: 'ab' }], [{ list: 'bullet' }], 1, 1, '\n')).toEqual([
      { list: 'bullet' },
      { list: 'bullet' },
    ]);
    const plain = block('a\nb');
    const listed = toggleList(plain, 0, 1, 'ordered');
    expect(listed.paragraphs).toEqual([{ list: 'ordered' }, { list: 'ordered' }]);
    expect(toggleList(listed, 0, 1, 'ordered').paragraphs).toBeUndefined();
    expect(indentList(listed, 1, 1, 1).paragraphs).toEqual([
      { list: 'ordered' },
      { list: 'ordered', indent: 1 },
    ]);
  });
});

describe('rich text', () => {
  const runs = [{ text: 'hello ' }, { text: 'world', bold: true }];

  test('applies, toggles and reads styles', () => {
    expect(applyStyle(runs, 0, 5, { italic: true })).toEqual([
      { text: 'hello', italic: true },
      { text: ' ' },
      { text: 'world', bold: true },
    ]);
    expect(hasStyle(runs, 6, 11, 'bold')).toBe(true);
    expect(hasStyle(runs, 0, 11, 'bold')).toBe(false);
    expect(hasStyle(runs, 8, 8, 'bold')).toBe(true);
    expect(toggleStyle(runs, 0, 11, 'bold')).toEqual([{ text: 'hello world', bold: true }]);
    expect(commonStyle(runs, 0, 11, 'bold')).toBe(MIXED);
    expect(commonStyle(runs, 6, 11, 'bold')).toBe(true);
    expect(normalizeRuns([{ text: '' }, { text: 'a' }, { text: 'b' }])).toEqual([{ text: 'ab' }]);
    expect(normalizeRuns([])).toEqual([{ text: '' }]);
  });

  test('links', () => {
    const linked = [{ text: 'see ' }, { text: 'docs', link: 'https://d.io' }, { text: '!' }];
    expect(linkAt(linked, 6)).toEqual({ from: 4, to: 8, href: 'https://d.io' });
    expect(linkAt(linked, 8)).toEqual({ from: 4, to: 8, href: 'https://d.io' });
    expect(linkAt(linked, 2)).toBeNull();
    expect(isAllowedLink('https://a.b')).toBe(true);
    expect(isAllowedLink('javascript:alert(1)')).toBe(false);
    expect(normalizeLink('example.com/path')).toBe('https://example.com/path');
    expect(normalizeLink('me@example.com')).toBe('mailto:me@example.com');
    expect(normalizeLink('not a link')).toBeNull();
    expect(normalizeLink('ftp://x.y')).toBeNull();
  });
});

describe('text boxes and sizes', () => {
  test('auto-width text hugs its text', () => {
    const element = createTextElement('t', { x: 0, y: 0 }, 1, undefined, block('abcd'));
    expect(element.text?.sizing).toBe('auto-width');
    expect(measureTextBox(element, measurer)).toEqual({ width: 20, height: 13 });
    const patch = fitTextPatch(element, measurer)!;
    expect(patch).toMatchObject({ x: 0, y: 0, width: 20, height: 13 });
    const wrapped = createTextElement('w', { x: 0, y: 0 }, 1, 12, block('abcd'));
    expect(wrapped.text?.sizing).toBe('auto-height');
    expect(measureTextBox(wrapped, measurer)).toEqual({ width: 12, height: 26 });
    const fixed = { ...element, text: { ...element.text!, sizing: 'fixed' as const } };
    expect(measureTextBox(fixed, measurer)).toBeNull();
    expect(hugTextPatch(fixed, measurer, 'auto-width')).toMatchObject({ width: 20 });
  });

  test('default blocks by kind', () => {
    expect(defaultTextBlock('text')).toMatchObject({ align: 'left', sizing: 'auto-width' });
    expect(defaultTextBlock('sticky')).toMatchObject({ autoFit: true, autoGrow: true });
    expect(defaultTextBlock('rect')).toMatchObject({ autoFit: true, align: 'center' });
  });

  test('font sizes and families', () => {
    expect(clampFontSize(0)).toBe(1);
    expect(clampFontSize(12.345)).toBe(12.3);
    expect(clampFontSize(Number.NaN)).toBe(16);
    expect(stepFontSize(16, 1)).toBe(18);
    expect(stepFontSize(16, -1)).toBe(14);
    expect(stepFontSize(288, 1)).toBe(360);
    const mixed: TextBlock = { ...block('ab'), runs: [{ text: 'a', size: 20 }, { text: 'b' }] };
    expect(hasMixedSizes(mixed)).toBe(true);
    // Runs that differed only by their size merge.
    expect(withFontSize(mixed, 30)).toMatchObject({ fontSize: 30, runs: [{ text: 'ab' }] });
    expect(stepTextSize(mixed, 1)).toMatchObject({ fontSize: 12, runs: [{ size: 24 }, {}] });
    expect(withFont(block('a'), 'mono').font).toBe('mono');
    expect(withFont({ ...block('a'), font: 'mono' }, 'geist').font).toBeUndefined();
    expect(fontIndex('mono')).toBe(3);
    expect(fontIndex('missing')).toBe(0);
    expect(fontFamily(undefined).id).toBe('geist');
  });
});

describe('replacing text', () => {
  test('inserts styled like the run it lands in', () => {
    const runs = [{ text: 'ab', bold: true }, { text: 'cd' }];
    expect(replaceText(runs, 1, 1, 'X')).toEqual([{ text: 'aXb', bold: true }, { text: 'cd' }]);
    // Right after a run, the inserted text continues it (plus the extra style).
    expect(replaceText(runs, 2, 3, 'Y', { italic: true })).toEqual([
      { text: 'ab', bold: true },
      { text: 'Y', bold: true, italic: true },
      { text: 'd' },
    ]);
    expect(replaceText([{ text: '' }], 0, 0, 'new')).toEqual([{ text: 'new' }]);
  });

  test('replacing in a block keeps list styles in step', () => {
    const list: TextBlock = { ...block('ab'), paragraphs: [{ list: 'bullet' }] };
    const split = replaceBlockText(list, 1, 1, '\n');
    expect(split.runs).toEqual([{ text: 'a\nb' }]);
    expect(split.paragraphs).toEqual([{ list: 'bullet' }, { list: 'bullet' }]);
    expect(withParagraphs(list, undefined).paragraphs).toBeUndefined();
    expect('paragraphs' in withParagraphs(list, undefined)).toBe(false);
  });
});
