import migrations from '@convex-dev/migrations/convex.config';
import workflow from '@convex-dev/workflow/convex.config.js';
import workflowMigrations from '@dev-marzahn/convex-workflow-migrations/convex.config.js';
import { defineApp } from 'convex/server';

const app = defineApp();
app.use(workflow);
app.use(workflowMigrations);
// For convex-release, which the `release` scenario deploys this app with.
app.use(migrations);
export default app;
