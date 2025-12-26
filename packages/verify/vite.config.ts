import { defineConfig } from 'vite';

const isDev = process.env.NODE_ENV !== 'production';

export default defineConfig({
  base: isDev ? '/' : '/verify/',
  server: {
    port: 5174,
  },
  build: {
    target: 'esnext',
    minify: 'esbuild'
  }
});
