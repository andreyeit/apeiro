import { test, describe } from 'vitest';
import { Scene } from './scene';
import { elementBounds } from '../elements/element';
import { makeRectangle } from '../test-utils';

/** Stable workload: a thousand rotated shapes and their attached straight connectors. */
function board(): Scene {
  const scene = new Scene();
  scene.transact(() => {
    for (let i = 0; i < 1000; i++) {
      scene.add(makeRectangle(`shape-${i}`, { x: i * 200, rotation: 0.3 }));
      if (i === 0) continue;
      scene.add({
        id: `line-${i}`,
        type: 'connector',
        z: 1,
        start: { kind: 'element', id: `shape-${i - 1}` },
        end: { kind: 'element', id: `shape-${i}` },
        route: 'straight',
        stroke: 0x18181bff,
        strokeWidth: 2,
        dash: 'solid',
        startCap: 'none',
        endCap: 'arrow',
      });
    }
  });
  return scene;
}

describe('Scene CPU workloads (one operation = 1000 shapes)', () => {
  const scene = board();
  let fill = 0;
  let y = 0;

  test('change fill without rerouting connectors', async ({ bench }) => {
    await bench('1000 shapes', () => {
      fill = fill === 0 ? 0xffffffff : 0;
      scene.transact(() => {
        for (let i = 0; i < 1000; i++) scene.update(`shape-${i}`, { fill });
      });
    }).run();
  });

  test('move shapes and settle attached connectors', async ({ bench }) => {
    await bench('1000 shapes', () => {
      y = y === 0 ? 10 : 0;
      scene.transact(() => {
        for (let i = 0; i < 1000; i++) scene.update(`shape-${i}`, { y });
      });
    }).run();
  });

  const shapes = Array.from({ length: 1000 }, (_, i) =>
    makeRectangle(String(i), { rotation: i / 100 }),
  );
  test('calculate rotated bounds', async ({ bench }) => {
    await bench('1000 shapes', () => {
      let checksum = 0;
      for (const shape of shapes) checksum += elementBounds(shape).maxX;
      return checksum;
    }).run();
  });
});
