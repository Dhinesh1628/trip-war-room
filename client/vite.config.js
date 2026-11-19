import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Ports 5173/5174 are taken by other projects on this machine, so the client
// runs on 5180 and forwards API + WebSocket traffic to the server on 5080.
const API = process.env.VITE_API_PROXY || 'http://localhost:5080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': API,
      '/socket.io': { target: API, ws: true },
    },
  },
  // Screen tests (npm test): React Testing Library in a simulated browser.
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
    restoreMocks: true,
  },
});
