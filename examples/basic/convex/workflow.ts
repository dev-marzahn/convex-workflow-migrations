import { WorkflowManager } from '@dev-marzahn/convex-workflow-migrations';

import { components } from './_generated/api';
import type { MutationCtx } from './_generated/server';

// A run that can't replay on the current code pauses, and onPause is told in
// the transaction that pauses it: here it records an alert, for the UI.
export const workflow = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  onPause: async (ctx, { workflowId, reason }) => {
    await (ctx as unknown as MutationCtx).db.insert('alerts', { workflowId, reason });
  },
});
