// For the e2e `queued` and `queued-step` scenarios: runs and steps that wait
// in upstream's workpool, not yet started, across a deploy. `serial` makes the
// workflow component's workpool run one job at a time, so `hold`, an action
// that sleeps, keeps every job enqueued after it waiting.
import { vWorkflowId, type WorkflowId, WorkflowManager } from '@dev-marzahn/convex-workflow-migrations';
import { v } from 'convex/values';

import { components, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalAction, mutation } from './_generated/server';
import { workflow } from './workflow';

/** How long `hold` keeps the workpool busy by default: long enough to export the queued runs and deploy the next release. */
const HOLD_MS = 30_000;

const serial = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  onPause: async (ctx, { workflowId, reason }) => {
    await ctx.db.insert('pauses', { workflowId, reason });
  },
  workpoolOptions: { maxParallelism: 1 },
});

export const hold = internalAction({
  args: { ms: v.optional(v.number()) },
  returns: v.null(),
  handler: async (_ctx, { ms = HOLD_MS }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return null;
  },
});

/** Takes the workpool's one slot for `ms`, `HOLD_MS` by default. */
export const block = serial.define({
  args: { ms: v.optional(v.number()) },
  handler: async (step, { ms }): Promise<void> => {
    await step.runAction(internal.queued.hold, ms === undefined ? {} : { ms });
  },
});

/** Runs a pipeline run as its child. */
export const batch = serial.define({
  args: { grabId: v.id('grabs') },
  handler: async (step, { grabId }): Promise<void> => {
    await step.runWorkflow(internal.pipeline.run, { grabId });
  },
});

const vIds = v.object({ grabId: v.id('grabs'), workflowId: vWorkflowId });
type Ids = { grabId: Id<'grabs'>; workflowId: WorkflowId };

/** Starts `block`, then a `batch` whose child waits behind it, then a pipeline run with startAsync, which waits too. */
export const startQueued = mutation({
  args: {},
  returns: v.object({ queued: vIds, child: vIds, parent: vWorkflowId }),
  handler: async (ctx): Promise<{ queued: Ids; child: Ids; parent: WorkflowId }> => {
    // Inline: its handler run sets the workpool to one job at a time, and enqueues hold, which takes it.
    await serial.start(ctx, internal.queued.block, {});
    // Inline too: its handler run creates the child, which is enqueued behind hold.
    const childGrab = await ctx.db.insert('grabs', { title: 'queued child', log: [] });
    const parent: WorkflowId = await serial.start(ctx, internal.queued.batch, { grabId: childGrab });
    const step = (await serial.listSteps(ctx, parent)).page.find((s) => s.kind === 'workflow');
    if (step?.kind !== 'workflow') throw new Error('batch started no child workflow');
    const child: WorkflowId = step.nestedWorkflowId;
    await ctx.db.patch('grabs', childGrab, { workflowId: child });
    const grabId = await ctx.db.insert('grabs', { title: 'queued run', log: [] });
    const queued: WorkflowId = await workflow.start(ctx, internal.pipeline.run, { grabId }, { startAsync: true });
    await ctx.db.patch('grabs', grabId, { workflowId: queued });
    return { queued: { grabId, workflowId: queued }, child: { grabId: childGrab, workflowId: child }, parent };
  },
});

/** How long `startBehindHold` holds the workpool: long enough to deploy the next release. */
const STEP_HOLD_MS = 15_000;

/**
 * Starts `block`, then a pipeline run, both inline: the run's first handler
 * run, on this release, starts grab, which waits behind hold with this
 * release's args.
 */
export const startBehindHold = mutation({
  args: {},
  returns: vIds,
  handler: async (ctx): Promise<Ids> => {
    await serial.start(ctx, internal.queued.block, { ms: STEP_HOLD_MS });
    const grabId = await ctx.db.insert('grabs', { title: 'grab queued behind hold', log: [] });
    const workflowId: WorkflowId = await workflow.start(ctx, internal.pipeline.run, { grabId });
    await ctx.db.patch('grabs', grabId, { workflowId });
    return { grabId, workflowId };
  },
});
