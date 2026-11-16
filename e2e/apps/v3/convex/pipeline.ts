import { migration, vWorkflowId, type WorkflowId } from '@dev-marzahn/convex-workflow-migrations';
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
    // Release 3: prepare was renamed to transcode. Named by its path, so the migration keeps compiling once the alias goes.
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
  // Optional: an import that release 0 or 1 queued runs here without it.
  args: { grabId: v.id('grabs'), notifiedAt: v.optional(v.union(v.number(), v.null())) },
  returns: v.null(),
  handler: (ctx, { grabId }) => log(ctx, grabId, 'import'),
});
export const transcode = step('transcode');
// For a prepare that release 2 or older queued: it runs as transcode.
export const prepare = transcode;
export const publish = step('publish');

// Everything below is the same in every fixture release.

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
