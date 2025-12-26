import { defineConfig } from 'vite';

export default defineConfig({
  base: '/typedcode/',
  build: {
    target: 'esnext',
    minify: 'esbuild',
    rollupOptions: {
      input: {
        main: './index.html',
        verify: './verify.html'
      }
    }
  }
});
