import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsdown';

/**
 * One package, two entries. The workspace packages (`@apeiro/*`, TypeScript sources) are
 * bundled in; shared code goes into common chunks, so `apeiro` and `apeiro/react` see the
 * same classes. react stays a peer dependency.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/react.ts',
  },
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [/^react($|\/)/, /^react-dom($|\/)/, '@mapbox/tiny-sdf'],
    alwaysBundle: [/^@apeiro\//],
  },
  outputOptions: {
    chunkFileNames: 'chunks/[name]-[hash].js',
    // Next.js App Router: the React entry is a client module.
    banner: (chunk) => (chunk.isEntry && chunk.name === 'react' ? "'use client';" : ''),
  },
  hooks: {
    'build:done': () => {
      mkdirSync('dist', { recursive: true });
      copyFileSync('../editor/src/styles.css', 'dist/styles.css');
      // npm shows the package's own README: it is the repository's one, copied here.
      copyFileSync('../../README.md', 'README.md');
    },
  },
});
