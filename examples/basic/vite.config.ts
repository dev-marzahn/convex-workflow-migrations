import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    environment: 'edge-runtime',
    // These ship test helpers that use import.meta.glob.
    server: { deps: { inline: ['convex-test', '@convex-dev/workflow', '@convex-dev/workpool', '@dev-marzahn/convex-workflow-patches'] } },
  },
});
