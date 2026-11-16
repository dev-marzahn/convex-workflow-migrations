import { vWorkflowId, type WorkflowId } from '@convex-dev/workflow';
import { v } from 'convex/values';

import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, mutation, query } from './_generated/server';
import { workflow } from './workflow';

// Release 0: grab, wait for the download, import, prepare, publish.
export const run = workflow.define({
  args: { grabId: v.id('grabs') },
  handler: async (step, { grabId }): Promise<void> => {
    await step.runMutation(internal.pipeline.grab, { grabId });
    await step.awaitEvent({ name: 'downloadDone' });
    await step.runMutation(internal.pipeline.importFiles, { grabId });
    await step.runMutation(internal.pipeline.prepare, { grabId });
    await step.runMutation(internal.pipeline.publish, { grabId });
  },
});

// The steps. Each records its name on the grab.

async function log(ctx: MutationCtx, grabId: Id<'grabs'>, name: string): Promise<null> {
  const grab = await ctx.db.get('grabs', grabId);
  if (!grab) throw new Error(`Grab ${grabId} not found`);
  await ctx.db.patch('grabs', grabId, { log: [...grab.log, name] });
  return null;
}

const step = (name: string) => internalMutation({ args: { grabId: v.id('grabs') }, returns: v.null(), handler: (ctx, { grabId }) => log(ctx, grabId, name) });
export const grab = step('grab');
export const importFiles = step('import');
export const prepare = step('prepare');
export const publish = step('publish');

// Everything below is the same in every release, examples/basic too.

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

export const status = query({
  args: { grabId: v.id('grabs') },
  returns: v.object({ log: v.array(v.string()), status: v.string(), error: v.optional(v.string()) }),
  handler: async (ctx, { grabId }) => {
    const grab = await ctx.db.get('grabs', grabId);
    if (!grab?.workflowId) throw new Error(`Grab ${grabId} has no workflow`);
    const status = await workflow.status(ctx, grab.workflowId);
    return { log: grab.log, status: status.type, ...(status.type === 'failed' ? { error: status.error } : {}) };
  },
});
