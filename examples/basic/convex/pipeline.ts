import { migration, type PausedRun, vWorkflowId, type WorkflowId } from '@dev-marzahn/convex-workflow-migrations';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';

import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, mutation, query } from './_generated/server';
import { workflow } from './workflow';

// A media pipeline: one run per grab (a download the app started). Grab, wait
// for the download, import the files, prepare them, publish them.
//
// That was release 0. Each later release changed the steps, and added a
// migration so the runs already in flight replay on the new code:
//   1. notify after grab. Runs already past grab count as notified, at no time.
//   2. import takes when the grab was notified. Runs that imported did so without it.
//   3. prepare is renamed to transcode.
// The step functions stay backward compatible, since a step an older release
// queued runs on the current code: import's new argument is optional, and
// prepare stays, as an alias of transcode.
export const run = workflow.define({
  args: { grabId: v.id('grabs') },
  migrations: [
    migration('notify-after-grab', (h) => h.insertAfter(internal.pipeline.grab, internal.pipeline.notify, { result: { at: null } })),
    migration('import-gets-notified-at', (h) =>
      h.updateArgs(internal.pipeline.importFiles, (args) => ({ ...args, notifiedAt: h.result(internal.pipeline.notify)?.at ?? null })),
    ),
    // Named by its path, so the migration keeps compiling once the prepare alias is gone.
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

// Stand-ins for the real steps (worker jobs, file moves). Every step records
// its name, so a test can see what ran.

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
  // null for runs that were past this point when it was added: the
  // migration's stand-in result has to be a value notify could return.
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

export const startGrab = mutation({
  args: { title: v.string() },
  returns: v.object({ grabId: v.id('grabs'), workflowId: vWorkflowId }),
  // Annotated: the return type would otherwise depend on itself through `internal`.
  handler: async (ctx, { title }): Promise<{ grabId: Id<'grabs'>; workflowId: WorkflowId }> => {
    const grabId = await ctx.db.insert('grabs', { title, log: [] });
    const workflowId = await workflow.start(ctx, internal.pipeline.run, { grabId });
    await ctx.db.patch('grabs', grabId, { workflowId });
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

// For an admin, after deploying a fix: retries a paused run now, and says whether it got past its pause.
export const resume = internalMutation({
  args: { workflowId: vWorkflowId },
  returns: v.boolean(),
  handler: (ctx, { workflowId }) => workflow.resume(ctx, workflowId),
});

// For the UI: whether a run is paused, and the alerts onPause recorded for it.
export const pauses = query({
  args: { workflowId: vWorkflowId },
  returns: v.object({ paused: v.union(v.object({ reason: v.string(), attempts: v.number() }), v.null()), alerts: v.array(v.string()) }),
  handler: async (ctx, { workflowId }) => {
    // paused returns a page of runs: look through this workflow's pages for this run.
    let run: PausedRun | undefined;
    let cursor: string | null = null;
    do {
      const { page, isDone, continueCursor } = await workflow.paused(ctx, { workflow: 'pipeline:run', cursor });
      run = page.find((paused) => paused.workflowId === workflowId);
      cursor = isDone ? null : continueCursor;
    } while (!run && cursor !== null);
    const alerts = await ctx.db
      .query('alerts')
      .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
      .collect();
    return { paused: run ? { reason: run.reason, attempts: run.attempts } : null, alerts: alerts.map((alert) => alert.reason) };
  },
});

// For the UI: the steps that ran, and the run's status.
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
