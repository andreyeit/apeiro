import { defineConfig } from 'vite';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  build: { rolldownOptions: { input: ['index.html', 'collaboration.html'] } },
  server: {
    port: 5173,
    proxy: { '/socket.io': { target: 'http://127.0.0.1:3001', ws: true } },
  },
});
