// The migrations component's functions. They're internal to this package: the
// workflow mutation calls `load`, `save`, `pause` and `cleanup`; a pause
// schedules `retry`; the `WorkflowManager` calls `load`, `list`, `retry`,
// `resumeAll`, `restart`, `claim`, `unpause` and `cleanupMany`; the CLI's
// `histories` reads `load`. Rows, scheduled `retry`, `resumeAll` and
// `cleanupMany` calls and `load`'s result outlive a deploy, so keep them
// readable from one version of this package to the next (see CONTRIBUTING.md).
import { paginationOptsValidator, type FunctionHandle } from 'convex/server';
import { type Infer, v } from 'convex/values';

import { api } from './_generated/api.js';
import type { Doc } from './_generated/dataModel.js';
import type { MutationCtx, QueryCtx } from './_generated/server.js';
import { mutation, query } from './_generated/server.js';
import { capDetail, DETAIL_LIMIT, FORMAT, vOverlayOp, vPaused, vPausedPage, vPauseReason } from './schema.js';

/** Milliseconds before each retry of a paused run: 1 minute, 10 minutes, 1 hour, then every 6 hours, each ±`JITTER`. */
export const BACKOFF_MS = [60_000, 600_000, 3_600_000, 21_600_000] as const;
/** How far a retry's delay varies, either way, so runs that paused together don't all retry together. */
export const JITTER = 0.2;
const backoff = (attempts: number) => Math.round(BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]! * (1 - JITTER + 2 * JITTER * Math.random()));

/** How many paused runs `list` returns by default, and `resumeAll` reschedules per transaction. */
export const PAGE_SIZE = 100;
/** How far apart, in milliseconds, `resumeAll` schedules its retries. */
export const RESUME_SPACING_MS = 100;
/** How long `fail`'s claim holds a run: retries skip it until then, and the first one after ends the pause if `fail` finished. */
export const CLAIM_MS = 60_000;
/** How many records `cleanupMany` deletes per transaction. */
export const CLEANUP_BATCH = 500;

const vRecord = v.object({
  workflow: v.string(),
  applied: v.array(v.string()),
  overlay: v.array(vOverlayOp),
  paused: v.optional(vPaused),
  restart: v.optional(v.string()),
  restartFrom: v.optional(v.number()),
  format: v.number(),
});

async function row(ctx: QueryCtx, workflowId: string) {
  return await ctx.db
    .query('runs')
    .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
    .first();
}

/** Paused rows, the one that paused first first, of one workflow or of all, that paused by `until` if given. A retry doesn't move a row in this order. */
function pausedRows(ctx: QueryCtx, workflow: string | undefined, until?: number) {
  return workflow === undefined
    ? ctx.db.query('runs').withIndex('pausedAt', (q) => (until === undefined ? q.gte('paused.at', 0) : q.gte('paused.at', 0).lte('paused.at', until)))
    : ctx.db
        .query('runs')
        .withIndex('workflowPausedAt', (q) =>
          until === undefined ? q.eq('workflow', workflow).gte('paused.at', 0) : q.eq('workflow', workflow).gte('paused.at', 0).lte('paused.at', until),
        );
}

type Paused = Infer<typeof vPaused>;
type Pause = Omit<Paused, 'at' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'claimedUntil'>;

/** Why and where a run paused, and how to retry it: what an attempt that throws keeps. */
function kept({ reason, detail, step, stepId, appliedCount, handle, generationNumber }: Paused): Pause {
  return { reason, detail, ...(step === undefined ? {} : { step }), ...(stepId === undefined ? {} : { stepId }), appliedCount, handle, generationNumber };
}

/** Counts another attempt of a run, and schedules the next retry. Returns the attempts so far. */
async function attempt(ctx: MutationCtx, workflowId: string, current: Doc<'runs'>, pause: Pause & { lastError?: string }): Promise<number> {
  const now = Date.now();
  const attempts = (current.paused?.attempts ?? 0) + 1;
  const nextAttemptAt = now + backoff(attempts);
  await ctx.db.patch('runs', current._id, { paused: { ...pause, at: current.paused?.at ?? now, attempts, nextAttemptAt } });
  await ctx.scheduler.runAt(nextAttemptAt, api.runs.retry, { workflowId });
  return attempts;
}

/** A run's record, or null if it has none. The workflow mutation reads this once per handler run, before replay. */
export const load = query({
  args: { workflowId: v.string() },
  returns: v.union(vRecord, v.null()),
  handler: async (ctx, { workflowId }) => {
    const found = await row(ctx, workflowId);
    if (!found) return null;
    const { workflow, applied, overlay, paused, restart, restartFrom, format } = found;
    return {
      workflow,
      applied,
      overlay,
      ...(paused ? { paused } : {}),
      ...(restart === undefined ? {} : { restart }),
      ...(restartFrom === undefined ? {} : { restartFrom }),
      format,
    };
  },
});

/**
 * Saves what a handler run applied and recorded, and ends a pause. The
 * workflow mutation calls it inside its own transaction. A record with
 * nothing applied and no overlay is what a missing one means, so it's
 * deleted instead.
 */
export const save = mutation({
  args: { workflowId: v.string(), workflow: v.string(), applied: v.array(v.string()), overlay: v.array(vOverlayOp) },
  returns: v.null(),
  handler: async (ctx, { workflowId, ...record }) => {
    const current = await row(ctx, workflowId);
    if (record.applied.length === 0 && record.overlay.length === 0) {
      if (current) await ctx.db.delete('runs', current._id);
      return null;
    }
    const doc = { workflowId, ...record, format: FORMAT };
    if (current) await ctx.db.replace('runs', current._id, doc);
    else await ctx.db.insert('runs', doc);
    return null;
  },
});

/**
 * Pauses a run and schedules a retry. Nothing else of the handler run is
 * saved. Returns whether to alert (the run wasn't paused before, or paused
 * for another reason or at another step), how many attempts have paused it,
 * and why it was paused before. A retry that throws keeps the pause it
 * retried, so the reason and step here are the last ones `onPause` got.
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
  handler: async (ctx, { workflowId, workflow, ...pause }) => {
    let current = await row(ctx, workflowId);
    if (!current) {
      // A run with nothing applied yet: new, or from before the app adopted this package.
      const id = await ctx.db.insert('runs', { workflowId, workflow, applied: [], overlay: [], format: FORMAT });
      current = (await ctx.db.get('runs', id))!;
    }
    const before = current.paused;
    // The caller cut it already (a mismatch's to about twice DETAIL_LIMIT); this only bounds the row.
    const attempts = await attempt(ctx, workflowId, current, { ...pause, detail: capDetail(pause.detail, 3 * DETAIL_LIMIT) });
    const notify = before === undefined || before.reason !== pause.reason || before.step !== pause.step;
    return { notify, attempts, ...(before ? { previousReason: before.reason } : {}) };
  },
});

/**
 * Retries a paused run: calls its workflow mutation with the generation it
 * paused at, the call upstream's workpool makes after every step. Scheduled
 * by a pause, it runs only when its attempt is due, and an error from the
 * workflow mutation counts as another attempt, which keeps the pause and
 * records the error as `lastError`; scheduled by `resumeAll` (`due`), it runs
 * right away, the same way. Called with `now` or `restartFrom` (by
 * `WorkflowManager.resume` and `restartFrom`), it runs right away, errors
 * reach the caller, and it throws if the run isn't paused or `fail` holds it.
 * `restartFrom` throws, undoing everything, if the run would pause again.
 * Returns whether the run is still paused.
 */
export const retry = mutation({
  args: { workflowId: v.string(), now: v.optional(v.boolean()), restartFrom: v.optional(v.number()), due: v.optional(v.boolean()) },
  returns: v.boolean(),
  handler: async (ctx, { workflowId, now, restartFrom, due }) => {
    const current = await row(ctx, workflowId);
    const forced = now === true || restartFrom !== undefined;
    const action = restartFrom === undefined ? 'resume' : 'restartFrom';
    if (!current?.paused) {
      if (forced) throw new Error(`${action}: workflow ${workflowId} isn't paused.`);
      return false;
    }
    const { paused } = current;
    if (paused.claimedUntil !== undefined && paused.claimedUntil > Date.now()) {
      if (forced) throw new Error(`${action}: workflow ${workflowId} is being failed.`);
      return true;
    }
    // A later attempt is scheduled: this one is left over from an earlier pause.
    if (!forced && due !== true && paused.nextAttemptAt > Date.now()) return true;
    if (restartFrom !== undefined) await ctx.db.patch('runs', current._id, { restartFrom });
    const handle = paused.handle as FunctionHandle<'mutation', { workflowId: string; generationNumber: number }>;
    const args = { workflowId, generationNumber: paused.generationNumber };
    if (forced) {
      await ctx.runMutation(handle, args);
    } else {
      try {
        await ctx.runMutation(handle, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Retrying paused workflow ${workflowId} threw, which counts as another attempt: ${message}`);
        await attempt(ctx, workflowId, current, { ...kept(paused), lastError: capDetail(`The workflow mutation threw: ${message}`) });
        return true;
      }
    }
    const after = await row(ctx, workflowId);
    // The workflow mutation deleted the record: the workflow is gone, or it saved one with nothing in it.
    if (!after) return false;
    if (after.paused && after.paused.attempts === paused.attempts) {
      // The workflow mutation returned without replaying: the run finished,
      // was canceled or restarted, so it isn't paused any more.
      await ctx.db.patch('runs', after._id, { paused: undefined, restart: undefined, restartFrom: undefined });
      return false;
    }
    if (restartFrom !== undefined && after.paused) {
      throw new Error(`Restarting ${workflowId} from step ${restartFrom} would pause it again (${after.paused.reason}): ${after.paused.detail}`);
    }
    return after.paused !== undefined;
  },
});

/**
 * Schedules a retry of every run (of one workflow) that was paused when it
 * was first called, each in its own transaction, `RESUME_SPACING_MS` apart.
 * It reads `numItems` runs (`PAGE_SIZE` by default) per transaction, in the
 * order they paused, and schedules itself for the rest after their retries,
 * so each run is retried once. `until` bounds the runs to those that paused
 * by the first call, so new pauses don't keep it going.
 */
export const resumeAll = mutation({
  args: {
    workflow: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { workflow, cursor, numItems, until = Date.now() }) => {
    const { page, isDone, continueCursor } = await pausedRows(ctx, workflow, until).paginate({ numItems: numItems ?? PAGE_SIZE, cursor: cursor ?? null });
    let scheduled = 0;
    for (const { workflowId, paused } of page) {
      if (paused) await ctx.scheduler.runAfter(RESUME_SPACING_MS * scheduled++, api.runs.retry, { workflowId, due: true });
    }
    if (!isDone) {
      const next = { ...(workflow === undefined ? {} : { workflow }), cursor: continueCursor, until, ...(numItems === undefined ? {} : { numItems }) };
      await ctx.scheduler.runAfter(RESUME_SPACING_MS * scheduled, api.runs.resumeAll, next);
    }
    return null;
  },
});

/**
 * For `WorkflowManager.restart`, before it restarts a finished run: the id
 * of the step the restarted run's first handler run removes the history
 * from, or, with `from` left out, none, which clears a step stored before.
 * With `from`, it creates the record of a run that has none, with nothing
 * applied.
 */
export const restart = mutation({
  args: { workflowId: v.string(), workflow: v.string(), from: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { workflowId, workflow, from }) => {
    const current = await row(ctx, workflowId);
    if (current) await ctx.db.patch('runs', current._id, { restart: from });
    else if (from !== undefined) await ctx.db.insert('runs', { workflowId, workflow, applied: [], overlay: [], restart: from, format: FORMAT });
    return null;
  },
});

/**
 * For `WorkflowManager.fail`: holds a paused run for `CLAIM_MS`, so no retry
 * resumes it while `fail` completes it, and returns the generation to
 * complete and why it paused. The retry it schedules for the end of the hold
 * ends the pause if `fail` didn't get to (the run finished), and retries the
 * run as usual if `fail` never completed it. Throws if the run isn't paused.
 */
export const claim = mutation({
  args: { workflowId: v.string() },
  returns: v.object({ generationNumber: v.number(), reason: vPauseReason, detail: v.string() }),
  handler: async (ctx, { workflowId }) => {
    const current = await row(ctx, workflowId);
    if (!current?.paused) throw new Error(`fail: workflow ${workflowId} isn't paused.`);
    const { paused } = current;
    const claimedUntil = Date.now() + CLAIM_MS;
    await ctx.db.patch('runs', current._id, { paused: { ...paused, claimedUntil, nextAttemptAt: claimedUntil } });
    await ctx.scheduler.runAt(claimedUntil, api.runs.retry, { workflowId });
    return { generationNumber: paused.generationNumber, reason: paused.reason, detail: paused.detail };
  },
});

/** Ends a pause without retrying: the run was canceled or failed. */
export const unpause = mutation({
  args: { workflowId: v.string() },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    const current = await row(ctx, workflowId);
    if (current?.paused) await ctx.db.patch('runs', current._id, { paused: undefined, restart: undefined, restartFrom: undefined });
    return null;
  },
});

/** A page of paused runs (of one workflow), the one that paused first first. */
export const list = query({
  args: { workflow: v.optional(v.string()), paginationOpts: v.optional(paginationOptsValidator) },
  returns: vPausedPage,
  handler: async (ctx, { workflow, paginationOpts }) => {
    const { page, isDone, continueCursor } = await pausedRows(ctx, workflow).paginate(paginationOpts ?? { numItems: PAGE_SIZE, cursor: null });
    return {
      page: page.flatMap(({ workflowId, workflow, paused }) =>
        paused
          ? [
              {
                workflowId,
                workflow,
                reason: paused.reason,
                detail: paused.detail,
                ...(paused.step === undefined ? {} : { step: paused.step }),
                at: paused.at,
                attempts: paused.attempts,
                nextAttemptAt: paused.nextAttemptAt,
                ...(paused.lastError === undefined ? {} : { lastError: paused.lastError }),
              },
            ]
          : [],
      ),
      isDone,
      continueCursor,
    };
  },
});

/**
 * Deletes a run's record. The workflow mutation calls it for a run whose
 * workflow is gone, for example a child workflow its parent's cleanup
 * deleted.
 */
export const cleanup = mutation({
  args: { workflowId: v.string() },
  returns: v.number(),
  handler: async (ctx, { workflowId }) => {
    const current = await row(ctx, workflowId);
    if (current) await ctx.db.delete('runs', current._id);
    return current ? 1 : 0;
  },
});

/**
 * Deletes the records of these runs, `CLEANUP_BATCH` per transaction, and
 * schedules itself for the rest. `WorkflowManager.cleanup` calls it with a
 * run and the child workflows upstream deletes with it.
 */
export const cleanupMany = mutation({
  args: { workflowIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { workflowIds }) => {
    for (const workflowId of workflowIds.slice(0, CLEANUP_BATCH)) {
      const current = await row(ctx, workflowId);
      if (current) await ctx.db.delete('runs', current._id);
    }
    if (workflowIds.length > CLEANUP_BATCH) await ctx.scheduler.runAfter(0, api.runs.cleanupMany, { workflowIds: workflowIds.slice(CLEANUP_BATCH) });
    return null;
  },
});
