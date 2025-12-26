import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/verify': {
        target: 'http://localhost:5174',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/verify/, ''),
      },
    },
  },
  build: {
    target: 'esnext',
    minify: 'esbuild'
  }
});
