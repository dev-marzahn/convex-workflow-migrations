import migrations from '@convex-dev/migrations/convex.config';
import workflow from '@convex-dev/workflow/convex.config.js';
import workflowPatches from '@dev-marzahn/convex-workflow-patches/convex.config.js';
import { defineApp } from 'convex/server';

const app = defineApp();
app.use(workflow);
app.use(workflowPatches);
// For convex-release, which the `release` scenario deploys this app with.
app.use(migrations);
export default app;
