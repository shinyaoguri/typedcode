import { defineConfig } from 'vite';

export default defineConfig({
  base: '/typedcode/verify/',
  build: {
    target: 'esnext',
    minify: 'esbuild'
  }
});
