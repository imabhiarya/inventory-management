import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // API_PORT lets you avoid port clashes (macOS AirPlay Receiver uses 5000).
    proxy: { '/api': { target: `http://localhost:${process.env.API_PORT || 5000}`, changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
