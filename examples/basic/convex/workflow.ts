import { WorkflowManager } from '@dev-marzahn/convex-workflow-migrations';

import { components } from './_generated/api';

export const workflow = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  // A run whose history doesn't match the code pauses instead of failing. Alert on it.
  onPause: (_ctx, { workflowId, workflow, reason, detail }) => {
    console.error(`Workflow ${workflow} ${workflowId} paused (${reason}): ${detail}`);
  },
});
