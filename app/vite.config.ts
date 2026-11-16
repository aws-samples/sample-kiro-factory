import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app builds to `web/dist`, which the server serves as static files.
// One process, one port: there is no dev proxy to keep in sync.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // The file viewer's libraries are the bulk of the bundle and are only
        // needed once a file is opened. Their own chunk keeps the canvas's
        // first load small and silences the size warning for a split that is
        // real rather than a raised limit.
        codeSplitting: {
          groups: [
            { name: 'viewer', test: /node_modules[\\/](highlight\.js|marked|dompurify)[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
