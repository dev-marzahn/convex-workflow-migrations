import { WorkflowManager } from '@dev-marzahn/convex-workflow-migrations';

import { components } from './_generated/api';

export const workflow = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  // Records each pause, so the scenarios can check it's reported once.
  onPause: async (ctx, { workflowId, reason }) => {
    await ctx.db.insert('pauses', { workflowId, reason });
  },
});
