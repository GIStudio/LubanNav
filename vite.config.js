import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  base: './',
  build: {
    target: 'es2020',
    sourcemap: true,
  },
  server: {
    proxy: {
      // 本地 dev: 把 /api 反代到车机 8901（与生产 nginx 一致, 前端同源访问）
      '/api': {
        target: 'http://10.7.181.161:8901',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
  },
});
