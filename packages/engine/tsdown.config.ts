import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsdown';

/**
 * One package, five entries. The workspace packages (`@apeiro/*`, TypeScript sources) are
 * bundled in; shared code goes into common chunks, so `apeiro` and `apeiro/react` see the
 * same classes. React and collaboration dependencies stay external.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/react.ts',
    yjs: 'src/yjs.ts',
    'socket.io': 'src/socket.io.ts',
    'socket.io-server': 'src/socket.io-server.ts',
  },
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [
      /^react($|\/)/,
      /^react-dom($|\/)/,
      '@mapbox/tiny-sdf',
      /^yjs($|\/)/,
      /^y-protocols($|\/)/,
      /^socket\.io($|\/)/,
      /^socket\.io-client($|\/)/,
    ],
    alwaysBundle: [/^@apeiro\//, /^lib0\//],
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
