import workflow from '@convex-dev/workflow/convex.config.js';
import workflowPatches from '@dev-marzahn/convex-workflow-patches/convex.config.js';
import { defineApp } from 'convex/server';

const app = defineApp();
app.use(workflow);
app.use(workflowPatches);
export default app;
