import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: { '/api': 'http://localhost:5000' },
    port: 5173,
  },
  build: { outDir: 'dist' },
});
