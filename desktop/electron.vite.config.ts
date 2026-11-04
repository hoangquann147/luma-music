import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { developmentCsp } from './dev-csp';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: resolve('electron/main/index.ts'),
        output: { format: 'es', entryFileNames: 'index.js' },
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist-electron/preload',
      externalizeDeps: false,
      rollupOptions: {
        input: resolve('electron/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: '.',
    plugins: [developmentCsp(), react(), tailwindcss()],
    server: { host: '127.0.0.1' },
    build: { outDir: 'dist', rollupOptions: { input: resolve('index.html') } },
  },
});
