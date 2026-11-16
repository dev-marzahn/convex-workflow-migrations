import { vWorkflowId, type WorkflowId } from '@dev-marzahn/convex-workflow-migrations';
import { v } from 'convex/values';

import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, mutation, query } from './_generated/server';
import { workflow } from './workflow';

// Release 2: release 1 plus a step before the wait and one after it, each
// behind a patch.
export const run = workflow.define({
  args: { grabId: v.id('grabs') },
  handler: async (step, { grabId }): Promise<void> => {
    await step.runMutation(internal.pipeline.logStep, { grabId, name: 'grab' });
    if (step.patched('notify-after-grab')) {
      await step.runMutation(internal.pipeline.logStep, { grabId, name: 'notify' });
    }
    await step.awaitEvent({ name: 'downloadDone' });
    await step.runMutation(internal.pipeline.logStep, { grabId, name: 'import' });
    if (step.patched('prepare-before-publish')) {
      await step.runMutation(internal.pipeline.logStep, { grabId, name: 'prepare' });
    }
    await step.runMutation(internal.pipeline.logStep, { grabId, name: 'publish' });
  },
});

// Everything below is the same in every fixture release.

export const logStep = internalMutation({
  args: { grabId: v.id('grabs'), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { grabId, name }) => {
    const grab = await ctx.db.get('grabs', grabId);
    if (!grab) throw new Error(`Grab ${grabId} not found`);
    await ctx.db.patch('grabs', grabId, { log: [...grab.log, name] });
    return null;
  },
});

export const startGrab = mutation({
  args: { title: v.string() },
  returns: v.object({ grabId: v.id('grabs'), workflowId: vWorkflowId }),
  handler: async (ctx, { title }): Promise<{ grabId: Id<'grabs'>; workflowId: WorkflowId }> => {
    const grabId = await ctx.db.insert('grabs', { title, log: [] });
    const workflowId = await workflow.start(ctx, internal.pipeline.run, { grabId });
    await ctx.db.patch('grabs', grabId, { workflowId });
    return { grabId, workflowId };
  },
});

export const downloadDone = mutation({
  args: { workflowId: vWorkflowId },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    await workflow.sendEvent(ctx, { workflowId, name: 'downloadDone' });
    return null;
  },
});

export const grab = query({
  args: { grabId: v.id('grabs') },
  returns: v.object({ log: v.array(v.string()), status: v.string(), error: v.optional(v.string()) }),
  handler: async (ctx, { grabId }) => {
    const grab = await ctx.db.get('grabs', grabId);
    if (!grab?.workflowId) throw new Error(`Grab ${grabId} has no workflow`);
    const status = await workflow.status(ctx, grab.workflowId);
    return { log: grab.log, status: status.type, ...(status.type === 'failed' ? { error: status.error } : {}) };
  },
});
