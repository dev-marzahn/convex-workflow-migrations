import { defineConfig } from 'vite-plus';

// Lint and format settings live in the repo root's vite.config.ts.
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    // These ship test helpers that use import.meta.glob.
    server: { deps: { inline: ['convex-test', '@convex-dev/workflow', '@convex-dev/workpool'] } },
  },
});
