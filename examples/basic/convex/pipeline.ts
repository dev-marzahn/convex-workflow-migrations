import { vWorkflowId, type WorkflowId } from '@dev-marzahn/convex-workflow-patches';
import { v } from 'convex/values';

import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, mutation } from './_generated/server';
import { workflow } from './workflow';

// A media pipeline: one run per grab (a download the app started). Grab, wait
// for the download, import the files, publish them.
//
// Release 1 shipped exactly that. Release 2 adds two steps, each behind a
// patch, so runs that release 1 started keep replaying:
//   - "notify-after-grab": a step *before* the wait. A run that was already
//     waiting when release 2 went live passed this point without it, and
//     skips it on every replay.
//   - "prepare-before-publish": a step *after* the wait. The same waiting run
//     reaches it for the first time on release 2 code, so it runs it.
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

// Stands in for the real steps (worker jobs, file moves). Every step records
// its name, so a test can see what ran.
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
  // Annotated: the return type would otherwise depend on itself through `internal`.
  handler: async (ctx, { title }): Promise<{ grabId: Id<'grabs'>; workflowId: WorkflowId }> => {
    const grabId = await ctx.db.insert('grabs', { title, log: [] });
    const workflowId = await workflow.start(ctx, internal.pipeline.run, { grabId });
    return { grabId, workflowId };
  },
});

// The worker calls this when the download client reports completion.
export const downloadDone = mutation({
  args: { workflowId: vWorkflowId },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    await workflow.sendEvent(ctx, { workflowId, name: 'downloadDone' });
    return null;
  },
});
