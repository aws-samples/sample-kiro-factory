import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app builds to `web/dist`, which the server serves as static files.
// One process, one port: there is no dev proxy to keep in sync.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
