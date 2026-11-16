import { migration, vWorkflowId, type WorkflowId } from '@dev-marzahn/convex-workflow-patches';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';

import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, mutation, query } from './_generated/server';
import { workflow } from './workflow';

// Releases 1 to 3 on top of release 0: release 3 renames prepare to
// transcode. It lists every migration, so a run from release 0 replays here
// without release 1 or 2 ever being deployed.
export const run = workflow.define({
  args: { grabId: v.id('grabs') },
  migrations: [
    // Release 1 added notify after grab. Runs already past grab count as notified, at no time.
    migration('notify-after-grab', (h) => h.insertAfter(internal.pipeline.grab, internal.pipeline.notify, { result: { at: null } })),
    // Release 2: import takes notifiedAt. Runs that already imported did so without it.
    migration('import-gets-notified-at', (h) =>
      h.updateArgs(internal.pipeline.importFiles, (args) => ({ ...args, notifiedAt: h.result(internal.pipeline.notify)?.at ?? null })),
    ),
    // Release 3: prepare was renamed to transcode. The old function is gone, so it's named by its path.
    migration('prepare-becomes-transcode', (h) => h.rename(makeFunctionReference<'mutation'>('pipeline:prepare'), internal.pipeline.transcode)),
  ],
  handler: async (step, { grabId }): Promise<void> => {
    await step.runMutation(internal.pipeline.grab, { grabId });
    const { at } = await step.runMutation(internal.pipeline.notify, { grabId });
    await step.awaitEvent({ name: 'downloadDone' });
    await step.runMutation(internal.pipeline.importFiles, { grabId, notifiedAt: at });
    await step.runMutation(internal.pipeline.transcode, { grabId });
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
export const notify = internalMutation({
  args: { grabId: v.id('grabs') },
  // null for runs that were past this point when it was added.
  returns: v.object({ at: v.union(v.number(), v.null()) }),
  handler: async (ctx, { grabId }): Promise<{ at: number | null }> => {
    await log(ctx, grabId, 'notify');
    return { at: Date.now() };
  },
});
export const importFiles = internalMutation({
  args: { grabId: v.id('grabs'), notifiedAt: v.union(v.number(), v.null()) },
  returns: v.null(),
  handler: (ctx, { grabId }) => log(ctx, grabId, 'import'),
});
export const transcode = step('transcode');
export const publish = step('publish');

// Everything below is the same in every fixture release from 1 on.

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

/** The run's pause, if it's paused, and every pause onPause recorded for it. */
export const pauses = query({
  args: { workflowId: vWorkflowId },
  returns: v.object({ paused: v.union(v.object({ reason: v.string(), attempts: v.number() }), v.null()), alerts: v.array(v.string()) }),
  handler: async (ctx, { workflowId }) => {
    const paused = (await workflow.paused(ctx)).find((run) => run.workflowId === workflowId);
    const alerts = await ctx.db
      .query('pauses')
      .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
      .collect();
    return { paused: paused ? { reason: paused.reason, attempts: paused.attempts } : null, alerts: alerts.map((alert) => alert.reason) };
  },
});

export const resume = mutation({
  args: { workflowId: vWorkflowId },
  returns: v.boolean(),
  handler: async (ctx, { workflowId }) => await workflow.resume(ctx, workflowId),
});
