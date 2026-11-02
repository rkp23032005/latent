import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Pinned: another Vite project on this machine holds [::1]:5173, which is
  // what `localhost` resolves to first. strictPort makes a clash fail loudly
  // instead of silently serving the wrong app.
  server: { host: true, port: 5273, strictPort: true },
  preview: { port: 5274, strictPort: true },
  build: { outDir: 'dist', sourcemap: true },
});
