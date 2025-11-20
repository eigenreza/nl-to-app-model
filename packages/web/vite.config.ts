import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The shared package is aliased to its source rather than its build output so
 * that a change to the schema shows up in the browser without a rebuild step.
 * Type checking still goes through the built declarations by way of the
 * TypeScript project reference, so the two cannot drift apart silently.
 */
const sharedSource = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@nlam/shared': sharedSource },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
