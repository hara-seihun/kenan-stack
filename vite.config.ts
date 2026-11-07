import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { precompress } from './build/precompress.js';
import { budget } from './build/budget.js';
import { preactAliases } from './build/preact.js';
export default defineConfig({
  root: 'web', base: './', plugins: [react(), precompress(), budget()],
  resolve: { alias: preactAliases },
  // Source maps only for analysis (KENAN_ANALYZE=1); production ships none.
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: process.env.KENAN_ANALYZE === '1', target: 'es2022', modulePreload: { polyfill: false } },
  server: { host: '127.0.0.1', port: 18192, strictPort: true, proxy: { '^/api(?:/|$)': { target: 'http://127.0.0.1:18190', ws: true } } },
});
