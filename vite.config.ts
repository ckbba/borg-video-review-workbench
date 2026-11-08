import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { feishuBase } from './server/feishuBase';
import { swapApi } from './swap/server';
// Two pages on one dev server: / is the internal review workbench, /swap.html is the user-facing swap app.
export default defineConfig({
  plugins: [react(), feishuBase(), swapApi()],
  build: { rollupOptions: { input: { main: 'index.html', swap: 'swap.html' } } },
  server: { watch: { ignored: ['**/swap/data/**', '**/swap/templates/**'] } },
  test: { environment: 'jsdom' }
});
