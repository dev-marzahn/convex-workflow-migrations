import { defineConfig } from 'vite-plus';

export default defineConfig({
  // For convex-test (grab.test.ts). pipeline.test.ts, which uses only /replay, needs none of this.
  test: {
    environment: 'edge-runtime',
    // These ship test helpers that use import.meta.glob: this package's /test does, its /replay doesn't.
    server: { deps: { inline: ['convex-test', '@convex-dev/workflow', '@convex-dev/workpool', '@dev-marzahn/convex-workflow-migrations'] } },
  },
});
