// Release 4 of v3's queued.ts: the pipeline run takes a channel, so `batch`
// passes one, and a migration gives the runs that started their child without
// one the args the call now has.
import { migration, vWorkflowId, WorkflowManager } from '@dev-marzahn/convex-workflow-migrations';
import { v } from 'convex/values';

import { components, internal } from './_generated/api';
import { internalAction, mutation } from './_generated/server';

const HOLD_MS = 30_000;

const serial = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  onPause: async (ctx, { workflowId, reason }) => {
    await ctx.db.insert('pauses', { workflowId, reason });
  },
  workpoolOptions: { maxParallelism: 1 },
});

export const hold = internalAction({
  args: {},
  returns: v.null(),
  handler: async () => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    return null;
  },
});

export const block = serial.define({
  args: {},
  handler: async (step): Promise<void> => {
    await step.runAction(internal.queued.hold, {});
  },
});

export const batch = serial.define({
  args: { grabId: v.id('grabs') },
  migrations: [
    // Release 4: the child gets the channel. Runs that started it before passed none.
    migration('child-gets-channel', (h) => h.updateArgs({ workflow: internal.pipeline.run }, (args) => ({ ...args, channel: 'default' }))),
  ],
  handler: async (step, { grabId }): Promise<void> => {
    await step.runWorkflow(internal.pipeline.run, { grabId, channel: 'default' });
  },
});

/** Deletes a finished batch, its journal and its records, and its child's, which upstream deletes with it. */
export const cleanup = mutation({
  args: { workflowId: vWorkflowId },
  returns: v.boolean(),
  handler: async (ctx, { workflowId }) => await serial.cleanup(ctx, workflowId),
});
