import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages serves this project under /<repository>/. The deploy workflow passes that
// path; local development, previews, and tests stay at the site root.
const basePath = process.env.BASE_PATH?.trim() || '/';

export default defineConfig({
  base: basePath.endsWith('/') ? basePath : `${basePath}/`,
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/lib/testSetup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['src/**/*.rules.test.ts'],
    restoreMocks: true,
    maxWorkers: 2,
  },
});
