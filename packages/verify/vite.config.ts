import { defineConfig } from 'vite';

export default defineConfig({
  base: '/verify/',
  build: {
    target: 'esnext',
    minify: 'esbuild'
  }
});
