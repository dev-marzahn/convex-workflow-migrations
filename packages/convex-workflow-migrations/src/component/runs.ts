// The migrations component's functions. They're internal to this package: the
// workflow mutation calls `load`, `save`, `pause` and `cleanup`; a pause
// schedules `retry`, which schedules `attempt`; the `WorkflowManager` calls
// `load`, `list`, `resume`, `end` and `cleanup`. Rows and scheduled `retry`
// and `attempt` calls outlive a deploy: keep them readable from one version of
// this package to the next (CONTRIBUTING.md).
import { type FunctionHandle, paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { api } from './_generated/api.js';
import type { Doc } from './_generated/dataModel.js';
import { mutation, type MutationCtx, query, type QueryCtx } from './_generated/server.js';
import { capDetail, DETAIL_LIMIT, vPausedRun, vPauseReason, vRecord } from './schema.js';

/** Milliseconds before each retry of a paused run: 1 minute, 10 minutes, 1 hour, then every 6 hours, each ±`JITTER`. */
export const BACKOFF_MS = [60_000, 600_000, 3_600_000, 21_600_000] as const;
/** How far a retry's delay varies, either way, so runs that paused together don't all retry together. */
export const JITTER = 0.2;
const backoff = (attempts: number) => Math.round(BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]! * (1 - JITTER + 2 * JITTER * Math.random()));
/** What a retry records as `lastError` when it starts its attempt; the attempt clears or replaces it. */
export const UNFINISHED = "The attempt didn't complete: its workflow mutation may have hit a Convex limit, such as its execution time.";

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

/**
 * Calls a paused run's workflow mutation with the generation it paused at, as
 * upstream's workpool calls it after every step. Returns whether the run is
 * still paused. A workflow mutation that returned without replaying (the run
 * finished, or is at another generation) leaves the pause as it was: that
 * ends the pause too.
 */
async function callHandle(ctx: MutationCtx, paused: Doc<'pauses'>): Promise<boolean> {
  const handle = paused.handle as FunctionHandle<'mutation', { workflowId: string; generationNumber: number }>;
  await ctx.runMutation(handle, { workflowId: paused.workflowId, generationNumber: paused.generationNumber });
  const after = await pauseRow(ctx, paused.workflowId);
  if (!after) return false;
  if (after.pausedRuns !== paused.pausedRuns) return true;
  await ctx.db.delete('pauses', after._id);
  return false;
}

/**
 * A run's record, or null if it has none: a child workflow before its first
 * handler run, or a run from before the app adopted this package. `paused`
 * if the run has a pause.
 */
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

/**
 * Writes a run's record: in the transaction that creates the run, and after a
 * handler run that changed it, or got past a pause, in its transaction. Ends
 * the run's pause.
 */
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

/**
 * Deletes a run's record and its pause: for `WorkflowManager.cleanup`, after
 * upstream's, and for a paused run whose workflow is gone. Returns whether it
 * deleted anything.
 */
export const cleanup = mutation({
  args: { workflowId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { workflowId }) => {
    const [current, paused] = [await row(ctx, workflowId), await pauseRow(ctx, workflowId)];
    if (current) await ctx.db.delete('runs', current._id);
    if (paused) await ctx.db.delete('pauses', paused._id);
    return current !== null || paused !== null;
  },
});

/**
 * Pauses a run, in the handler run's transaction, which saves nothing else.
 * The first pause counts the first attempt and schedules a retry. A run paused
 * again, by a retry or `resume`, keeps its attempts and its scheduled retry.
 * Returns whether to call `onPause`: on the first pause, and when the reason
 * or the step changed.
 */
export const pause = mutation({
  args: {
    workflowId: v.string(),
    workflow: v.string(),
    reason: vPauseReason,
    detail: v.string(),
    step: v.optional(v.number()),
    stepId: v.optional(v.string()),
    appliedCount: v.number(),
    handle: v.string(),
    generationNumber: v.number(),
  },
  returns: v.object({ notify: v.boolean(), attempts: v.number(), previousReason: v.optional(vPauseReason) }),
  handler: async (ctx, { workflowId, ...pause }) => {
    // The caller cut it already (a mismatch's to about twice DETAIL_LIMIT); this only bounds the row.
    const fields = { ...pause, detail: capDetail(pause.detail, 3 * DETAIL_LIMIT) };
    const before = await pauseRow(ctx, workflowId);
    if (before) {
      // Fields left out (a step, the last attempt's error) are cleared.
      await ctx.db.patch('pauses', before._id, {
        ...fields,
        step: fields.step,
        stepId: fields.stepId,
        lastError: undefined,
        pausedRuns: before.pausedRuns + 1,
      });
      const notify = before.reason !== pause.reason || before.step !== pause.step;
      return { notify, attempts: before.attempts, previousReason: before.reason };
    }
    const at = Date.now();
    const nextAttemptAt = at + backoff(1);
    await ctx.db.insert('pauses', { workflowId, ...fields, at, attempts: 1, nextAttemptAt, pausedRuns: 1 });
    await ctx.scheduler.runAt(nextAttemptAt, api.runs.retry, { workflowId });
    return { notify: true, attempts: 1 };
  },
});

/**
 * A scheduled retry of a paused run. It's write-ahead: it counts the attempt,
 * records `UNFINISHED` as `lastError`, schedules the next retry with backoff,
 * and then schedules `attempt`, which calls the workflow mutation in a
 * transaction of its own. So an attempt that dies, even on a Convex limit,
 * leaves the next retry scheduled. Does nothing for a run that isn't paused,
 * or whose next attempt isn't due: a retry left over from an earlier pause.
 */
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

/**
 * The attempt a retry started: calls the paused run's workflow mutation. If
 * it pauses again, the pause clears `lastError`; if the workflow mutation
 * throws, the error is `lastError`. Does nothing if the run isn't paused any
 * more, or a later attempt started.
 */
export const attempt = mutation({
  args: { workflowId: v.string(), attempts: v.number() },
  returns: v.null(),
  handler: async (ctx, { workflowId, attempts }) => {
    const paused = await pauseRow(ctx, workflowId);
    if (!paused || paused.attempts !== attempts) return null;
    try {
      await callHandle(ctx, paused);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Retrying paused workflow ${workflowId}: its workflow mutation threw, so it stays paused until the next retry: ${message}`);
      await ctx.db.patch('pauses', paused._id, { lastError: capDetail(`The workflow mutation threw: ${message}`) });
    }
    return null;
  },
});

/**
 * For `WorkflowManager.resume`: calls a paused run's workflow mutation now, in
 * this transaction, so its errors reach the caller. It doesn't count an
 * attempt, and leaves the scheduled retry as it was. Throws if the run isn't
 * paused. Returns whether it's still paused.
 */
export const resume = mutation({
  args: { workflowId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { workflowId }) => {
    const paused = await pauseRow(ctx, workflowId);
    if (!paused) throw new Error(`resume: workflow ${workflowId} isn't paused.`);
    return await callHandle(ctx, paused);
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
      const { workflowId, workflow, reason, detail, step, at, attempts, nextAttemptAt, lastError } = paused;
      return {
        workflowId,
        workflow,
        reason,
        detail,
        at,
        attempts,
        nextAttemptAt,
        ...(step === undefined ? {} : { step }),
        ...(lastError === undefined ? {} : { lastError }),
      };
    });
    return { page: runs, isDone, continueCursor };
  },
});
