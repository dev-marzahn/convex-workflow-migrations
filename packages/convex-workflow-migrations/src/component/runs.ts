// The migrations component's functions. They're internal to this package: the
// workflow mutation calls `load`, `save` and `pause`; a pause schedules
// `retry`, which schedules `attempt`; the `WorkflowManager` calls `load`,
// `list`, `resume`, `end` and `cleanup`. Rows and scheduled `retry` and
// `attempt` calls outlive a deploy: keep them readable from one version of
// this package to the next (CONTRIBUTING.md, which also describes the retry
// protocol).
import { type FunctionHandle, paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { api } from './_generated/api.js';
import type { Doc } from './_generated/dataModel.js';
import { mutation, type MutationCtx, query, type QueryCtx } from './_generated/server.js';
import { capDetail, vPausedRun, vPauseReason, vRecord } from './schema.js';

/** Milliseconds before each retry of a paused run: 1 minute, 10 minutes, 1 hour, then every 6 hours, each ±`JITTER`. */
export const BACKOFF_MS = [60_000, 600_000, 3_600_000, 21_600_000] as const;
/** How far a retry's delay varies, either way, so runs that paused together don't all retry together. */
export const JITTER = 0.2;
const backoff = (attempts: number) => Math.round(BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]! * (1 - JITTER + 2 * JITTER * Math.random()));
/** What a retry records as `lastError` when it starts its attempt; the attempt clears or replaces it. */
export const UNFINISHED = "The attempt didn't complete: its workflow mutation may have hit a Convex limit, such as its execution time.";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const row = (ctx: QueryCtx, workflowId: string) =>
  ctx.db
    .query('runs')
    .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
    .first();

const pauseRow = (ctx: QueryCtx, workflowId: string) =>
  ctx.db
    .query('pauses')
    .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
    .first();

/** Deletes a run's record and its pause, and returns whether it had either. */
async function deleteRun(ctx: MutationCtx, workflowId: string): Promise<boolean> {
  const [current, paused] = [await row(ctx, workflowId), await pauseRow(ctx, workflowId)];
  if (current) await ctx.db.delete('runs', current._id);
  if (paused) await ctx.db.delete('pauses', paused._id);
  return current !== null || paused !== null;
}

/**
 * Calls a paused run's workflow mutation at the generation it paused at, and
 * returns whether the run replayed past its pause, paused again, or ended
 * without a replay (it finished, is at another generation, or is gone), which
 * ends the pause.
 */
async function callHandle(ctx: MutationCtx, paused: Doc<'pauses'>): Promise<'resumed' | 'paused' | 'ended'> {
  const { workflowId, generationNumber } = paused;
  const handle = paused.handle as FunctionHandle<'mutation', { workflowId: string; generationNumber: number }>;
  try {
    await ctx.runMutation(handle, { workflowId, generationNumber });
  } catch (error) {
    // Upstream's `journal.load` throws this for a workflow it deleted, like a child its parent's cleanup removed.
    if (!message(error).includes(`Workflow not found: ${workflowId}`)) throw error;
    console.warn(`Workflow ${workflowId} is gone, so its record and pause in the migrations component were deleted.`);
    await deleteRun(ctx, workflowId);
    return 'ended';
  }
  const after = await pauseRow(ctx, workflowId);
  if (!after) return 'resumed';
  if (after.pausedRuns !== paused.pausedRuns) return 'paused';
  await ctx.db.delete('pauses', after._id);
  return 'ended';
}

/** A run's record, or null if it has none (a child workflow before its first handler run, or a run from before adoption), with `paused` if it has a pause. */
export const load = query({
  args: { workflowId: v.string() },
  returns: v.union(v.object({ ...vRecord.fields, paused: v.optional(v.literal(true)) }), v.null()),
  handler: async (ctx, { workflowId }) => {
    const found = await row(ctx, workflowId);
    if (!found) return null;
    const paused = (await pauseRow(ctx, workflowId)) !== null;
    return { applied: found.applied, overlay: found.overlay, ...(paused ? { paused: true as const } : {}) };
  },
});

/** Writes a run's record, in the transaction that creates the run or of a handler run that replayed, and ends its pause. */
export const save = mutation({
  args: { workflowId: v.string(), ...vRecord.fields },
  returns: v.null(),
  handler: async (ctx, { workflowId, ...record }) => {
    const current = await row(ctx, workflowId);
    if (current) await ctx.db.patch('runs', current._id, record);
    else await ctx.db.insert('runs', { workflowId, ...record });
    const paused = await pauseRow(ctx, workflowId);
    if (paused) await ctx.db.delete('pauses', paused._id);
    return null;
  },
});

/** For `WorkflowManager.cleanup`, after upstream's: deletes a run's record and its pause, and returns whether it had either. */
export const cleanup = mutation({
  args: { workflowId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { workflowId }) => await deleteRun(ctx, workflowId),
});

/** Pauses a run, scheduling a retry if it wasn't paused, and returns whether to call `onPause`: when the reason, step or detail is new. */
export const pause = mutation({
  args: {
    workflowId: v.string(),
    workflow: v.string(),
    reason: vPauseReason,
    detail: v.string(),
    step: v.optional(v.number()),
    handle: v.string(),
    generationNumber: v.number(),
  },
  returns: v.object({ notify: v.boolean(), attempts: v.number() }),
  handler: async (ctx, { workflowId, ...pause }) => {
    const before = await pauseRow(ctx, workflowId);
    if (before) {
      // A step left out is cleared, and so is the last attempt's error.
      await ctx.db.patch('pauses', before._id, { ...pause, step: pause.step, lastError: undefined, pausedRuns: before.pausedRuns + 1 });
      const notify = before.reason !== pause.reason || before.step !== pause.step || before.detail !== pause.detail;
      return { notify, attempts: before.attempts };
    }
    const nextAttemptAt = Date.now() + backoff(1);
    await ctx.db.insert('pauses', { workflowId, ...pause, attempts: 1, nextAttemptAt, pausedRuns: 1 });
    await ctx.scheduler.runAt(nextAttemptAt, api.runs.retry, { workflowId });
    return { notify: true, attempts: 1 };
  },
});

/** A scheduled retry: counts the attempt and schedules the next retry before it schedules `attempt`, if the run is paused and the retry is due. */
export const retry = mutation({
  args: { workflowId: v.string() },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    const paused = await pauseRow(ctx, workflowId);
    if (!paused || paused.nextAttemptAt > Date.now()) return null;
    const attempts = paused.attempts + 1;
    const nextAttemptAt = Date.now() + backoff(attempts);
    await ctx.db.patch('pauses', paused._id, { attempts, nextAttemptAt, lastError: UNFINISHED });
    await ctx.scheduler.runAt(nextAttemptAt, api.runs.retry, { workflowId });
    await ctx.scheduler.runAfter(0, api.runs.attempt, { workflowId, attempts });
    return null;
  },
});

/** The attempt a retry started: calls the run's workflow mutation, recording an error it throws as `lastError`, unless the run's pause ended or a later attempt started. */
export const attempt = mutation({
  args: { workflowId: v.string(), attempts: v.number() },
  returns: v.null(),
  handler: async (ctx, { workflowId, attempts }) => {
    const paused = await pauseRow(ctx, workflowId);
    if (!paused || paused.attempts !== attempts) return null;
    try {
      await callHandle(ctx, paused);
    } catch (error) {
      console.warn(`Retrying paused workflow ${workflowId}: its workflow mutation threw, so it stays paused until the next retry: ${message(error)}`);
      await ctx.db.patch('pauses', paused._id, { lastError: capDetail(`The workflow mutation threw: ${message(error)}`) });
    }
    return null;
  },
});

/** For `WorkflowManager.resume`: calls a paused run's workflow mutation now, in this transaction, and returns whether it replayed past its pause. */
export const resume = mutation({
  args: { workflowId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { workflowId }) => {
    const paused = await pauseRow(ctx, workflowId);
    if (!paused) throw new Error(`resume: workflow ${workflowId} isn't paused.`);
    return (await callHandle(ctx, paused)) === 'resumed';
  },
});

/** For `WorkflowManager.fail` and `cancel`: ends a run's pause, and returns it, or null if the run isn't paused. */
export const end = mutation({
  args: { workflowId: v.string() },
  returns: v.union(v.object({ generationNumber: v.number(), reason: vPauseReason, detail: v.string() }), v.null()),
  handler: async (ctx, { workflowId }) => {
    const paused = await pauseRow(ctx, workflowId);
    if (!paused) return null;
    await ctx.db.delete('pauses', paused._id);
    return { generationNumber: paused.generationNumber, reason: paused.reason, detail: paused.detail };
  },
});

/** A page of paused runs (of one workflow), the one that paused first first. */
export const list = query({
  args: { workflow: v.optional(v.string()), paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(vPausedRun), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, { workflow, paginationOpts }) => {
    const rows = workflow === undefined ? ctx.db.query('pauses') : ctx.db.query('pauses').withIndex('workflow', (q) => q.eq('workflow', workflow));
    const { page, isDone, continueCursor } = await rows.paginate(paginationOpts);
    const runs = page.map((paused) => {
      const { workflowId, workflow, reason, detail, step, attempts, nextAttemptAt, lastError } = paused;
      return {
        workflowId,
        workflow,
        reason,
        detail,
        at: paused._creationTime,
        attempts,
        nextAttemptAt,
        ...(step === undefined ? {} : { step }),
        ...(lastError === undefined ? {} : { lastError }),
      };
    });
    return { page: runs, isDone, continueCursor };
  },
});
