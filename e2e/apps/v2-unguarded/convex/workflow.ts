import { WorkflowManager } from '@dev-marzahn/convex-workflow-migrations';

import { components } from './_generated/api';
import type { MutationCtx } from './_generated/server';

export const workflow = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  onPause: async (ctx, { workflowId, reason }) => {
    await (ctx as unknown as MutationCtx).db.insert('alerts', { workflowId, reason });
  },
});
