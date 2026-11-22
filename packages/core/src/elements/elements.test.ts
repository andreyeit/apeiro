import { describe, expect, test } from 'vitest';
import {
  audioLayout,
  audioSeekAt,
  canHoldText,
  computePeaks,
  cssColor,
  cropPan,
  effectiveRadius,
  elementBounds,
  enterCrop,
  eraseStroke,
  fitBox,
  fitMediaSize,
  handleOfSigns,
  hexColor,
  hitTestAudio,
  hitTestElement,
  imageRectangle,
  imageUv,
  inkGeometry,
  inkWorldPoints,
  isAllowedMediaSource,
  maxCornerRadius,
  newId,
  normalizeAngle,
  outlineAlongRay,
  patchedElement,
  polygonVertices,
  pullString,
  radiusAfterDrag,
  relaxStroke,
  resizeCursor,
  resizeFrame,
  rgba,
  rotateElements,
  scaleElements,
  shapeFrame,
  shapeSdf,
  simplifyStroke,
  smoothStroke,
  textArea,
  textBlock,
  translateElements,
  unpackColor,
  validateElement,
  type BoardElement,
  type ShapeElement,
} from '../index';
import { makeRectangle } from '../test-utils';

const image = (patch: Partial<ShapeElement> = {}): ShapeElement =>
  makeRectangle('image', {
    type: 'image',
    width: 200,
    height: 100,
    media: { source: 'blob:x', naturalWidth: 100, naturalHeight: 100 },
    ...patch,
  });

describe('colors', () => {
  test('packs and parses', () => {
    expect(rgba(255, 0, 0)).toBe(0xff0000ff);
    expect(rgba(1, 2, 3, 4)).toBe(0x01020304);
    expect(hexColor('#f00')).toBe(0xff0000ff);
    expect(hexColor('00ff0080')).toBe(0x00ff0080);
    expect(() => hexColor('#12')).toThrow();
  });
});

describe('validateElement', () => {
  test('accepts valid elements', () => {
    expect(validateElement(makeRectangle('a'))).toBeNull();
    expect(
      validateElement(makeRectangle('t', { type: 'text', text: textBlock('hello') })),
    ).toBeNull();
  });

  test('names what is wrong', () => {
    expect(validateElement(makeRectangle(''))).toMatch(/id/);
    expect(validateElement(makeRectangle('a', { x: Number.NaN }))).toMatch(/x must be finite/);
    expect(validateElement(makeRectangle('a', { width: -1 }))).toMatch(/size/);
    expect(validateElement(makeRectangle('a', { type: 'polygon', sides: 20 }))).toMatch(/sides/);
    expect(validateElement(makeRectangle('a', { type: 'nope' as 'rect' }))).toMatch(/type/);
    expect(
      validateElement(
        makeRectangle('a', { text: { ...textBlock('x'), runs: [{ text: 'x', link: 'js:1' }] } }),
      ),
    ).toMatch(/link/);
    expect(validateElement(makeRectangle('a', { type: 'ink', points: [] }))).toMatch(/ink/);
    expect(validateElement(image({ crop: { x: 0.5, y: 0, width: 0.6, height: 1 } }))).toMatch(
      /crop/,
    );
    const connector: BoardElement = {
      id: 'c',
      type: 'connector',
      z: 0,
      start: { kind: 'point', x: 0, y: 0 },
      end: { kind: 'element', id: 'a' },
      route: 'straight',
      stroke: 0,
      strokeWidth: 1,
      dash: 'solid',
      startCap: 'none',
      endCap: 'arrow',
    };
    expect(validateElement(connector)).toBeNull();
    expect(validateElement({ ...connector, route: 'zigzag' } as unknown as BoardElement)).toMatch(
      /route/,
    );
    expect(
      validateElement({
        ...connector,
        start: { kind: 'point', x: Infinity, y: 0 },
      } as BoardElement),
    ).toMatch(/start/);
  });
});

describe('shape geometry', () => {
  test('bounds include rotation and stroke', () => {
    expect(elementBounds(makeRectangle('a', { strokeWidth: 2 }))).toEqual({
      minX: -1,
      minY: -1,
      maxX: 101,
      maxY: 101,
    });
    const rotated = elementBounds(makeRectangle('a', { rotation: Math.PI / 4 }));
    expect(rotated.maxX - rotated.minX).toBeCloseTo(100 * Math.SQRT2);
  });

  test('text area is inset by kind', () => {
    expect(textArea(makeRectangle('a'))).toEqual({ minX: 10, minY: 10, maxX: 90, maxY: 90 });
    const ellipse = textArea(makeRectangle('e', { type: 'ellipse' }));
    expect(ellipse.minX).toBeCloseTo(6 + 100 * ((1 - Math.SQRT1_2) / 2));
    const polygon = textArea(makeRectangle('p', { type: 'polygon', sides: 3 }));
    expect(polygon).toEqual({ minX: 31, minY: 51, maxX: 69, maxY: 86 });
  });

  test('polygon vertices fill the box', () => {
    const vertices = polygonVertices(100, 80, 5);
    const xs = vertices.map((vertex) => vertex.x);
    const ys = vertices.map((vertex) => vertex.y);
    expect(Math.min(...xs)).toBeCloseTo(-50);
    expect(Math.max(...xs)).toBeCloseTo(50);
    expect(Math.min(...ys)).toBeCloseTo(-40);
    expect(Math.max(...ys)).toBeCloseTo(40);
    expect(vertices[0]!.x).toBeCloseTo(0);
  });

  test('corner radius is capped by the shape', () => {
    const square = makeRectangle('a', { radius: 500 });
    expect(maxCornerRadius(square)).toBe(50);
    expect(effectiveRadius(square)).toBe(50);
    expect(effectiveRadius(makeRectangle('e', { type: 'ellipse', radius: 10 }))).toBe(0);
    expect(radiusAfterDrag(square, 0, 1000)).toBe(50);
    expect(radiusAfterDrag(square, 10, -100)).toBe(0);
  });

  test('signed distance is negative inside and zero on the outline', () => {
    for (const type of ['rect', 'ellipse', 'polygon'] as const) {
      const shape = makeRectangle('a', { type, sides: 6, radius: 10 });
      expect(shapeSdf(shape, { x: 0, y: 0 })).toBeLessThan(0);
      expect(shapeSdf(shape, { x: 200, y: 0 })).toBeGreaterThan(0);
      const edge = outlineAlongRay(shape, { x: 1, y: 0.3 });
      expect(Math.abs(shapeSdf(shape, edge))).toBeLessThan(1e-6);
    }
  });

  test('hit testing follows the outline', () => {
    const rectangle = makeRectangle('a', { radius: 20 });
    expect(hitTestElement(rectangle, { x: 50, y: 50 })).toBe(true);
    expect(hitTestElement(rectangle, { x: 1, y: 1 })).toBe(false);
    expect(hitTestElement(rectangle, { x: 1, y: 1 }, 10)).toBe(true);
    const ellipse = makeRectangle('e', { type: 'ellipse' });
    expect(hitTestElement(ellipse, { x: 5, y: 5 })).toBe(false);
    expect(hitTestElement(ellipse, { x: 50, y: 1 })).toBe(true);
    const triangle = makeRectangle('t', { type: 'polygon', sides: 3 });
    expect(hitTestElement(triangle, { x: 5, y: 5 })).toBe(false);
    expect(hitTestElement(triangle, { x: 50, y: 60 })).toBe(true);
    const rotated = makeRectangle('r', { width: 200, height: 10, rotation: Math.PI / 2 });
    expect(hitTestElement(rotated, { x: 100, y: -40 })).toBe(true);
    expect(hitTestElement(rotated, { x: 10, y: 5 })).toBe(false);
  });
});

describe('transform', () => {
  test('resize keeps the opposite handle and the minimum size', () => {
    const frame = shapeFrame(makeRectangle('a'));
    const resized = resizeFrame(frame, 'se', { x: 20, y: 10 });
    expect(resized).toEqual({ centerX: 60, centerY: 55, width: 120, height: 110, rotation: 0 });
    const flipped = resizeFrame(frame, 'e', { x: -500, y: 0 }, { minSize: 5 });
    expect(flipped.width).toBe(5);
    const aspect = resizeFrame(frame, 'se', { x: 100, y: 0 }, { keepAspect: true });
    expect(aspect.width).toBe(200);
    expect(aspect.height).toBe(200);
    const centered = resizeFrame(frame, 'e', { x: 10, y: 0 }, { fromCenter: true });
    expect(centered).toMatchObject({ centerX: 50, width: 120 });
  });

  test('scales several elements around their frame', () => {
    const elements = [makeRectangle('a'), makeRectangle('b', { x: 100 })];
    const from = { centerX: 100, centerY: 50, width: 200, height: 100, rotation: 0 };
    const to = { centerX: 200, centerY: 100, width: 400, height: 200, rotation: 0 };
    const patches = scaleElements(elements, from, to);
    expect(patches.get('a')).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    expect(patches.get('b')).toEqual({ x: 200, y: 0, width: 200, height: 200 });
  });

  test('scaling text rewraps or scales the font', () => {
    const text = makeRectangle('t', {
      type: 'text',
      text: { ...textBlock('x'), sizing: 'auto-width' },
    });
    const from = shapeFrame(text);
    const wider = { ...from, width: 200 };
    expect(scaleElements([text], from, wider).get('t')!.text?.sizing).toBe('auto-height');
    const bigger = { ...from, width: 200, height: 200 };
    const scaled = scaleElements([text], from, bigger, { scaleText: true }).get('t')!;
    expect(scaled.text?.fontSize).toBe(32);
  });

  test('rotates and translates', () => {
    const patches = rotateElements([makeRectangle('a')], { x: 0, y: 0 }, Math.PI);
    const patch = patches.get('a')!;
    expect(patch.x).toBeCloseTo(-100);
    expect(patch.y).toBeCloseTo(-100);
    expect(patch.rotation).toBeCloseTo(Math.PI);
    expect(translateElements([makeRectangle('a')], 5, -5).get('a')).toEqual({ x: 5, y: -5 });
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
    expect(resizeCursor('e', 0)).toBe('ew-resize');
    expect(resizeCursor('e', Math.PI / 2)).toBe('ns-resize');
    expect(resizeCursor('se', 0)).toBe('nwse-resize');
  });
});

describe('image fit', () => {
  test('fill covers, fit contains, crop shows its part', () => {
    expect(imageUv(image(), { width: 100, height: 100 })).toEqual({
      u: 0,
      v: 0.25,
      spanU: 1,
      spanV: 0.5,
    });
    expect(imageUv(image({ imageFit: 'fit' }), { width: 100, height: 100 })).toEqual({
      u: -0.5,
      v: 0,
      spanU: 2,
      spanV: 1,
    });
    const crop = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    expect(imageUv(image({ imageFit: 'crop', crop }), { width: 100, height: 100 })).toEqual({
      u: 0.1,
      v: 0.2,
      spanU: 0.3,
      spanV: 0.4,
    });
    expect(imageRectangle(image(), { width: 100, height: 100 })).toEqual({
      x: 0,
      y: -50,
      width: 200,
      height: 200,
    });
  });

  test('switching modes keeps the picture in place', () => {
    const size = { width: 100, height: 100 };
    // The box shrinks around the whole picture where `fit` shows it.
    expect(fitBox(image(), size)).toEqual({
      x: 50,
      y: 0,
      width: 100,
      height: 100,
      imageFit: 'fit',
      crop: undefined,
    });
    expect(enterCrop(image(), size)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      imageFit: 'crop',
      crop: { x: 0, y: 0.25, width: 1, height: 0.5 },
    });
    const cropped = image({ imageFit: 'crop', crop: { x: 0, y: 0.25, width: 1, height: 0.5 } });
    expect(cropPan(cropped, size, { x: 0, y: 1000 }).crop).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 0.5,
    });
  });
});

describe('media', () => {
  test('fits sizes and lays out the audio player', () => {
    expect(fitMediaSize(1000, 500, 100)).toEqual({ width: 100, height: 50 });
    expect(fitMediaSize(10, 5, 100)).toEqual({ width: 10, height: 5 });
    const layout = audioLayout(320, 40);
    expect(layout.play.centerY).toBe(20);
    expect(layout.wave.x).toBeGreaterThan(layout.play.centerX);
    expect(layout.volume.x + layout.volume.width).toBeLessThanOrEqual(320);
  });

  test('hit tests the player controls', () => {
    const audio = makeRectangle('a', { type: 'audio', width: 320, height: 40 });
    const layout = audioLayout(320, 40);
    expect(hitTestAudio(audio, { x: layout.play.centerX, y: 20 })).toEqual({ part: 'play' });
    const wave = hitTestAudio(audio, { x: layout.wave.x + layout.wave.width / 2, y: 20 });
    expect(wave).toEqual({ part: 'wave', fraction: 0.5 });
    expect(hitTestAudio(makeRectangle('r'), { x: 10, y: 10 })).toBeNull();
    expect(audioSeekAt(audio, { x: -1000, y: 20 })).toBe(0);
  });

  test('computes normalised peaks', () => {
    const channel = new Float32Array([0, 0.5, -1, 0.25]);
    expect(computePeaks([channel], 2)).toEqual([0.5, 1]);
    expect(computePeaks([], 4)).toEqual([]);
  });

  test('allows only safe media sources', () => {
    const page = 'https://board.example';
    expect(isAllowedMediaSource('blob:https://board.example/1', [], page)).toBe(true);
    expect(isAllowedMediaSource('data:image/png;base64,AA', [], page)).toBe(true);
    expect(isAllowedMediaSource('data:text/html,hi', [], page)).toBe(false);
    expect(isAllowedMediaSource('/files/a.png', [], page)).toBe(true);
    expect(isAllowedMediaSource('https://evil.example/a.png', [], page)).toBe(false);
    expect(isAllowedMediaSource('https://cdn.example/a.png', ['https://cdn.example'], page)).toBe(
      true,
    );
    expect(isAllowedMediaSource('javascript:alert(1)', [], page)).toBe(false);
  });
});

describe('ink', () => {
  test('stores strokes as box fractions', () => {
    const geometry = inkGeometry([
      { x: 10, y: 10 },
      { x: 30, y: 20 },
    ]);
    expect(geometry).toEqual({ x: 10, y: 10, width: 20, height: 10, points: [0, 0, 1, 1] });
    const element = makeRectangle('i', { type: 'ink', ...geometry });
    expect(inkWorldPoints(element)).toEqual([
      { x: 10, y: 10 },
      { x: 30, y: 20 },
    ]);
    const flat = inkGeometry([
      { x: 0, y: 5 },
      { x: 10, y: 5 },
    ]);
    expect(flat.height).toBe(1e-3);
    expect(flat.y).toBeCloseTo(5 - 5e-4);
  });

  test('simplifies, stabilizes, relaxes and smooths', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 5, y: 0.1 },
      { x: 10, y: 0 },
    ];
    expect(simplifyStroke(line, 0.5)).toEqual([line[0], line[2]]);
    expect(pullString({ x: 0, y: 0 }, { x: 5, y: 0 }, 8)).toBeNull();
    expect(pullString({ x: 0, y: 0 }, { x: 10, y: 0 }, 8)).toEqual({ x: 2, y: 0 });
    const relaxed = relaxStroke(
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
      ],
      2,
      3,
    );
    expect(relaxed[0]).toEqual({ x: 0, y: 0 });
    expect(relaxed[relaxed.length - 1]).toEqual({ x: 20, y: 0 });
    const smooth = smoothStroke(
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
      ],
      2,
    );
    expect(smooth.some((point) => point.x === 10 && point.y === 10)).toBe(true);
  });

  test('erasing cuts a stroke into the pieces outside the eraser', () => {
    const stroke = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(eraseStroke(stroke, { x: 50, y: 50 }, 10)).toBeNull();
    const pieces = eraseStroke(stroke, { x: 50, y: 0 }, 10)!;
    expect(pieces).toHaveLength(2);
    expect(pieces[0]![pieces[0]!.length - 1]!.x).toBeCloseTo(40);
    expect(pieces[1]![0]!.x).toBeCloseTo(60);
    expect(eraseStroke([{ x: 0, y: 0 }], { x: 0, y: 0 }, 1)).toEqual([]);
  });
});

describe('element helpers', () => {
  test('which shapes hold text, patching and handle signs', () => {
    expect(canHoldText(makeRectangle('a'))).toBe(true);
    expect(canHoldText(image())).toBe(false);
    expect(canHoldText(undefined)).toBe(false);
    const patched = patchedElement(makeRectangle('a'), { x: 5, id: 'b', type: 'ellipse' } as never);
    expect(patched).toMatchObject({ id: 'a', type: 'rect', x: 5 });
    expect(handleOfSigns([1, -1])).toBe('ne');
    expect(newId('s')).toMatch(/^s-[0-9a-f-]{20,}$/);
    expect(cssColor(0xff000080)).toBe(`rgba(255, 0, 0, ${0x80 / 255})`);
    expect(unpackColor(0xff0000ff)).toEqual([1, 0, 0, 1]);
  });
});

describe('polygon geometry cache', () => {
  test('gives the same outline for the same polygon, and different ones otherwise', () => {
    const first = polygonVertices(100, 80, 5);
    expect(polygonVertices(100, 80, 5)).toBe(first);
    expect(polygonVertices(100, 80, 6)).not.toBe(first);
    expect(polygonVertices(100, 80, 6)).toHaveLength(6);
    const polygon = makeRectangle('p', { type: 'polygon', sides: 5, radius: 10 });
    const rounded = shapeSdf(polygon, { x: 0, y: -50 });
    // A rounded corner pulls the outline in at the vertex; a different radius, a different outline.
    expect(rounded).toBeGreaterThan(0);
    expect(shapeSdf({ ...polygon, radius: 0 }, { x: 0, y: -50 })).toBeCloseTo(0);
    expect(shapeSdf(polygon, { x: 0, y: -50 })).toBe(rounded);
  });
});
