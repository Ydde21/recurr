import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Dev server proxies the API to a local recurr-server (default :4780). */
const apiTarget = process.env.RECURR_API ?? 'http://127.0.0.1:4780';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    proxy: {
      '/v1': apiTarget,
      '/healthz': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
