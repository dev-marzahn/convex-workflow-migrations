// The migrations component's functions. They're internal to this package: the
// workflow mutation calls `start`, `load`, `save`, `children`, `pause`,
// `finished` and `cleanup`; a pause schedules `retry`, which schedules
// `attempt`; the `WorkflowManager` calls `load`, `list`, `resume`,
// `resumeAll`, `restart`, `end` and `forget`, and `end` schedules
// `finishDescendants`; the CLI's `histories` reads `load`, `live` and
// `origins`. Rows, scheduled `retry`, `attempt`, `resumeAll`, `forget` and
// `finishDescendants` calls and what the CLI reads outlive a deploy, so keep
// them readable from one version of this package to the next (see
// CONTRIBUTING.md).
import { type FunctionHandle, paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';

import { api } from './_generated/api.js';
import type { Doc } from './_generated/dataModel.js';
import type { MutationCtx, QueryCtx } from './_generated/server.js';
import { mutation, query } from './_generated/server.js';
import { capDetail, DETAIL_LIMIT, FORGET_BATCH, FORMAT, isWorkflowNotFound, vOrigin, vOverlayOp, vPaused, vPausedPage, vPauseReason } from './schema.js';

/** Milliseconds before each retry of a paused run: 1 minute, 10 minutes, 1 hour, then every 6 hours, each ±`JITTER`. */
export const BACKOFF_MS = [60_000, 600_000, 3_600_000, 21_600_000] as const;
/** How far a retry's delay varies, either way, so runs that paused together don't all retry together. */
export const JITTER = 0.2;
const backoff = (attempts: number) => Math.round(BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]! * (1 - JITTER + 2 * JITTER * Math.random()));

/** How many paused runs `list` returns by default, and `resumeAll` reschedules per transaction. */
export const PAGE_SIZE = 100;
/** How far apart, in milliseconds, `resumeAll` schedules its retries. */
export const RESUME_SPACING_MS = 100;
/** How many child records `forget` reads per page. */
const FORGET_PAGE = 100;
/** The most a page of `live` reads, so a page of records with big overlays stays under Convex's read limit. */
const LIVE_PAGE_BYTES = 4 << 20;
/** What a retry records as `lastError` when it starts its attempt; the attempt clears or replaces it. */
export const UNFINISHED = "The attempt didn't complete: its workflow mutation may have hit a Convex limit, such as its execution time.";

const vRecord = v.object({
  workflow: v.string(),
  applied: v.optional(v.array(v.string())),
  overlay: v.array(vOverlayOp),
  restart: v.optional(v.string()),
  live: v.boolean(),
  origin: vOrigin,
  parent: v.optional(v.string()),
  format: v.number(),
  paused: v.optional(vPaused),
});

async function row(ctx: QueryCtx, workflowId: string) {
  return await ctx.db
    .query('runs')
    .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
    .first();
}

async function pauseRow(ctx: QueryCtx, workflowId: string) {
  return await ctx.db
    .query('pauses')
    .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
    .first();
}

/** Paused runs, the one that paused first first, of one workflow or of all, that paused by `until` if given. A retry doesn't move a run in this order. */
function pausedRows(ctx: QueryCtx, workflow: string | undefined, until?: number) {
  return workflow === undefined
    ? ctx.db.query('pauses').withIndex('at', (q) => (until === undefined ? q : q.lte('at', until)))
    : ctx.db.query('pauses').withIndex('workflowAt', (q) => (until === undefined ? q.eq('workflow', workflow) : q.eq('workflow', workflow).lte('at', until)));
}

/** The fields of a pause, without its table's. */
function pauseOf({ _id, _creationTime, workflowId: _workflowId, workflow: _workflow, ...paused }: Doc<'pauses'>) {
  return paused;
}

/** Throws, changing nothing, for a record that a newer version of this package wrote: this one may misread it. */
function refuseNewer(current: Doc<'runs'> | null, action: string, workflowId: string): void {
  if (current && current.format > FORMAT) {
    throw new Error(
      `${action}: workflow ${workflowId}'s record has format ${current.format}, from a newer version of @dev-marzahn/convex-workflow-migrations; this one reads ${FORMAT}.`,
    );
  }
}

/**
 * What calling a paused run's workflow mutation did: the run paused again
 * (with its new pause), got past its pause (`resumed`), or the workflow
 * mutation returned without replaying (`skipped`): the run finished, was
 * canceled, or is at another generation, past the manager.
 */
type Called = { kind: 'paused'; pause: Doc<'pauses'> } | { kind: 'resumed' } | { kind: 'skipped' };

/**
 * Calls a paused run's workflow mutation with the generation it paused at,
 * the call upstream's workpool makes after every step. A workflow mutation
 * that returned without replaying leaves the pause as it was; that ends the
 * pause too.
 */
async function callHandle(ctx: MutationCtx, paused: Doc<'pauses'>): Promise<Called> {
  const handle = paused.handle as FunctionHandle<'mutation', { workflowId: string; generationNumber: number }>;
  await ctx.runMutation(handle, { workflowId: paused.workflowId, generationNumber: paused.generationNumber });
  const after = await pauseRow(ctx, paused.workflowId);
  if (!after) return { kind: 'resumed' };
  if (after.pausedRuns === paused.pausedRuns) {
    await ctx.db.delete('pauses', after._id);
    return { kind: 'skipped' };
  }
  return { kind: 'paused', pause: after };
}

/** Whether the transaction has used about half of a limit, as upstream's cleanup checks: time to schedule the rest. */
async function budgetSpent(ctx: MutationCtx): Promise<boolean> {
  const m = await ctx.meta.getTransactionMetrics();
  return (
    m.bytesRead.used > m.bytesRead.remaining ||
    m.bytesWritten.used > m.bytesWritten.remaining ||
    m.databaseQueries.used > m.databaseQueries.remaining ||
    m.documentsRead.used > m.documentsRead.remaining ||
    m.documentsWritten.used > m.documentsWritten.remaining ||
    m.functionsScheduled.used > m.functionsScheduled.remaining ||
    m.scheduledFunctionArgsBytes.used > m.scheduledFunctionArgsBytes.remaining
  );
}

/** A run's record, with its pause if it's paused, or null if it has neither. The workflow mutation reads this once per handler run, before replay. */
export const load = query({
  args: { workflowId: v.string() },
  returns: v.union(vRecord, v.null()),
  handler: async (ctx, { workflowId }) => {
    const found = await row(ctx, workflowId);
    if (!found) return null;
    const { _id, _creationTime, workflowId: _, ...record } = found;
    const paused = await pauseRow(ctx, workflowId);
    return { ...record, ...(paused ? { paused: pauseOf(paused) } : {}) };
  },
});

/** A run's record, written by the workflow mutation in the transaction that creates the run: the migrations its code lists, which its history is in the shape of. */
export const start = mutation({
  args: { workflowId: v.string(), workflow: v.string(), applied: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { workflowId, workflow, applied }) => {
    await ctx.db.insert('runs', { workflowId, workflow, applied, overlay: [], live: true, origin: 'start', format: FORMAT });
    return null;
  },
});

/**
 * Records of the child workflows a handler run's `runWorkflow` steps just
 * created, linked to the parent. Upstream's component created them, so their
 * migrations aren't known until their first handler run.
 */
export const children = mutation({
  args: { parent: v.string(), children: v.array(v.object({ workflowId: v.string(), workflow: v.string() })) },
  returns: v.null(),
  handler: async (ctx, { parent, children }) => {
    for (const { workflowId, workflow } of children) {
      const current = await row(ctx, workflowId);
      if (!current) await ctx.db.insert('runs', { workflowId, workflow, overlay: [], live: true, origin: 'child', parent, format: FORMAT });
      else if (current.parent === undefined) await ctx.db.patch('runs', current._id, { parent });
    }
    return null;
  },
});

/**
 * Saves what a handler run applied and recorded, whether it completed the
 * run, and ends a pause. The workflow mutation calls it inside its own
 * transaction. A run without a record, from before the app adopted this
 * package, gets one.
 */
export const save = mutation({
  args: { workflowId: v.string(), workflow: v.string(), applied: v.array(v.string()), overlay: v.array(vOverlayOp), done: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { workflowId, workflow, applied, overlay, done }) => {
    const current = await row(ctx, workflowId);
    const fields = { workflow, applied, overlay, live: !done, format: FORMAT };
    if (current) await ctx.db.patch('runs', current._id, { ...fields, restart: undefined });
    else await ctx.db.insert('runs', { workflowId, ...fields, origin: 'adopted' });
    const paused = await pauseRow(ctx, workflowId);
    if (paused) await ctx.db.delete('pauses', paused._id);
    return null;
  },
});

/**
 * Pauses a run. Nothing else of the handler run is saved. A run that wasn't
 * paused gets its first attempt and a retry scheduled. A run paused again,
 * by a retry or `resume`, keeps its attempts and its scheduled retry: a
 * retry counts its attempt when it starts. Returns whether to alert, how
 * many attempts the run has had, and why it was paused before. It alerts when
 * the run wasn't paused before, and when the code it paused on changed: it
 * paused for another reason, at another step, with another number of
 * migrations applied, or, for a mismatch, with another detail. A retry that
 * throws keeps the pause it retried, so what it compares with is what
 * `onPause` got last.
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
    // The caller cut it already (a mismatch's to about twice DETAIL_LIMIT); this only bounds the row.
    const where = { ...pause, detail: capDetail(pause.detail, 3 * DETAIL_LIMIT) };
    const before = await pauseRow(ctx, workflowId);
    if (before) {
      // Fields left out (a step, a restartFrom, the error of the attempt) are cleared.
      await ctx.db.patch('pauses', before._id, {
        workflow,
        ...where,
        step: where.step,
        stepId: where.stepId,
        lastError: undefined,
        restartFrom: undefined,
        pausedRuns: before.pausedRuns + 1,
      });
      const notify =
        before.reason !== pause.reason ||
        before.step !== pause.step ||
        before.appliedCount !== pause.appliedCount ||
        (pause.reason === 'mismatch' && before.detail !== where.detail);
      return { notify, attempts: before.attempts, previousReason: before.reason };
    }
    const now = Date.now();
    const nextAttemptAt = now + backoff(1);
    await ctx.db.insert('pauses', { workflowId, workflow, ...where, at: now, attempts: 1, nextAttemptAt, pausedRuns: 1 });
    await ctx.scheduler.runAt(nextAttemptAt, api.runs.retry, { workflowId });
    // A run from before the app adopted this package: a record, with its migrations not known yet.
    if (!(await row(ctx, workflowId))) await ctx.db.insert('runs', { workflowId, workflow, overlay: [], live: true, origin: 'adopted', format: FORMAT });
    return { notify: true, attempts: 1 };
  },
});

/**
 * A scheduled retry of a paused run. Scheduled by a pause or by the retry
 * before it, it runs when its attempt is due; scheduled by `resumeAll`
 * (`due`), right away. It starts the attempt write-ahead: it counts the
 * attempt, records `UNFINISHED` as `lastError`, schedules the next retry with
 * backoff, and schedules `attempt`, which calls the workflow mutation in a
 * transaction of its own. So a workflow mutation that dies, even on a Convex
 * limit, leaves the next retry scheduled. Does nothing for a run that isn't
 * paused, or whose next attempt isn't due. Returns whether the run is paused.
 */
export const retry = mutation({
  args: { workflowId: v.string(), due: v.optional(v.boolean()) },
  returns: v.boolean(),
  handler: async (ctx, { workflowId, due }) => {
    const paused = await pauseRow(ctx, workflowId);
    if (!paused) return false;
    // A later retry is scheduled: this one is left over from before it.
    if (due !== true && paused.nextAttemptAt > Date.now()) return true;
    const attempts = paused.attempts + 1;
    const nextAttemptAt = Date.now() + backoff(attempts);
    await ctx.db.patch('pauses', paused._id, { attempts, nextAttemptAt, lastError: UNFINISHED });
    await ctx.scheduler.runAt(nextAttemptAt, api.runs.retry, { workflowId });
    await ctx.scheduler.runAfter(0, api.runs.attempt, { workflowId, attempts });
    return true;
  },
});

/**
 * For `WorkflowManager.resume` and `restartFrom`: calls a paused run's
 * workflow mutation now, in this transaction, so errors reach the caller.
 * It doesn't count an attempt, and leaves the scheduled retry as it was.
 * Throws if the run isn't paused. With `restartFrom`, it throws, undoing
 * everything, if the run would pause again, or if the workflow mutation
 * returned without replaying: the run finished, or is at another
 * generation, so nothing was restarted. Returns whether the run is still
 * paused.
 */
export const resume = mutation({
  args: { workflowId: v.string(), restartFrom: v.optional(v.number()) },
  returns: v.boolean(),
  handler: async (ctx, { workflowId, restartFrom }) => {
    const action = restartFrom === undefined ? 'resume' : 'restartFrom';
    const paused = await pauseRow(ctx, workflowId);
    if (!paused) throw new Error(`${action}: workflow ${workflowId} isn't paused.`);
    if (restartFrom === undefined) return (await callHandle(ctx, paused)).kind === 'paused';
    await ctx.db.patch('pauses', paused._id, { restartFrom });
    const called = await callHandle(ctx, paused);
    if (called.kind === 'paused') {
      throw new Error(`Restarting ${workflowId} from step ${restartFrom} would pause it again (${called.pause.reason}): ${called.pause.detail}`);
    }
    if (called.kind === 'skipped') {
      throw new Error(
        `restartFrom: workflow ${workflowId} isn't running in upstream's component any more (it finished, for example canceled with its parent, or was restarted, past the manager), so nothing was restarted. resume, fail or cancel ends its pause.`,
      );
    }
    return false;
  },
});

/**
 * An attempt `retry` started: calls the paused run's workflow mutation. If the
 * replay gets past the pause, the pause ends, and the retry scheduled for
 * later finds nothing to do. If it pauses again, the pause clears `lastError`;
 * if the workflow mutation throws, the error is `lastError`. Does nothing if
 * the run isn't paused any more, or a later attempt started.
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
 * Schedules a retry of every run (of one workflow) that was paused when it
 * was first called, each in its own transaction, `RESUME_SPACING_MS` apart.
 * It reads `PAGE_SIZE` paused runs per transaction, in the order they paused,
 * and schedules itself for the rest after their retries, so each run is
 * retried once. `until`, the time of the first call, bounds the runs to
 * those paused by then, so new pauses don't keep it going.
 */
export const resumeAll = mutation({
  args: { workflow: v.optional(v.string()), cursor: v.optional(v.union(v.string(), v.null())), until: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { workflow, cursor, until = Date.now() }) => {
    const { page, isDone, continueCursor } = await pausedRows(ctx, workflow, until).paginate({ numItems: PAGE_SIZE, cursor: cursor ?? null });
    for (const [i, { workflowId }] of page.entries()) await ctx.scheduler.runAfter(RESUME_SPACING_MS * i, api.runs.retry, { workflowId, due: true });
    if (!isDone) {
      const next = { ...(workflow === undefined ? {} : { workflow }), cursor: continueCursor, until };
      await ctx.scheduler.runAfter(RESUME_SPACING_MS * page.length, api.runs.resumeAll, next);
    }
    return null;
  },
});

/**
 * For `WorkflowManager.restart`, before it restarts a finished run: the id
 * of the step the restarted run's first handler run removes the history
 * from, or, with `from` left out, none, which clears a step stored before.
 * The run is live again. A run without a record, from before the app adopted
 * this package, gets one with nothing applied. A pause left over from before
 * the run finished, if upstream's component completed it past the manager,
 * ends. With `overlay`, the record's overlay with the stand-ins that would
 * lose their anchors anchored again, it replaces the stored one. Throws,
 * changing nothing, for a record a newer version wrote.
 */
export const restart = mutation({
  args: { workflowId: v.string(), workflow: v.string(), from: v.optional(v.string()), overlay: v.optional(v.array(vOverlayOp)) },
  returns: v.null(),
  handler: async (ctx, { workflowId, workflow, from, overlay }) => {
    const current = await row(ctx, workflowId);
    refuseNewer(current, 'restart', workflowId);
    if (current) await ctx.db.patch('runs', current._id, { restart: from, live: true, ...(overlay === undefined ? {} : { overlay }) });
    else
      await ctx.db.insert('runs', {
        workflowId,
        workflow,
        applied: [],
        overlay: [],
        live: true,
        origin: 'adopted',
        format: FORMAT,
        ...(from === undefined ? {} : { restart: from }),
      });
    const paused = await pauseRow(ctx, workflowId);
    if (paused) await ctx.db.delete('pauses', paused._id);
    return null;
  },
});

/**
 * For `WorkflowManager.fail` and `cancel`: ends a run's pause, if it has one,
 * and marks its record finished. Returns the pause it ended. With `paused`,
 * for `fail`, it throws, changing nothing, if the run isn't paused. With
 * `canceled`, it then marks finished the records of the descendants
 * upstream's cancel canceled with the run (`finishDescendants`). Throws,
 * changing nothing, for a record a newer version wrote.
 */
export const end = mutation({
  args: { workflowId: v.string(), paused: v.optional(v.boolean()), canceled: v.optional(v.boolean()) },
  returns: v.union(v.object({ generationNumber: v.number(), reason: vPauseReason, detail: v.string() }), v.null()),
  handler: async (ctx, { workflowId, paused: mustBePaused, canceled }) => {
    const current = await row(ctx, workflowId);
    refuseNewer(current, mustBePaused ? 'fail' : 'cancel', workflowId);
    const paused = await pauseRow(ctx, workflowId);
    if (!paused && mustBePaused) throw new Error(`fail: workflow ${workflowId} isn't paused.`);
    if (paused) await ctx.db.delete('pauses', paused._id);
    if (current && (current.live || current.restart !== undefined)) await ctx.db.patch('runs', current._id, { live: false, restart: undefined });
    if (canceled) await ctx.scheduler.runAfter(0, api.runs.finishDescendants, { workflowIds: [], from: { workflowId, cursor: null } });
    return paused ? { generationNumber: paused.generationNumber, reason: paused.reason, detail: paused.detail } : null;
  },
});

/**
 * For the workflow mutation, called for a run upstream's component has
 * finished, for example a child workflow canceled with its parent past the
 * manager: marks its record finished, if it's still live. Its pause, if it
 * has one, is left to the retry that called it.
 */
export const finished = mutation({
  args: { workflowId: v.string() },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    const current = await row(ctx, workflowId);
    if (current?.live && current.format <= FORMAT) await ctx.db.patch('runs', current._id, { live: false });
    return null;
  },
});

const vListing = v.object({ workflowId: v.string(), cursor: v.union(v.string(), v.null()) });

/**
 * After a cancel: marks finished the live records linked to these runs (and
 * to `from`, the run whose children it was listing), and then to those, as
 * upstream's cancel cancels a run's running child workflows, and theirs. A
 * child whose record isn't live finished on its own, so its children are
 * left alone. It works in batches, as `forget` does.
 */
export const finishDescendants = mutation({
  args: { workflowIds: v.array(v.string()), from: v.optional(vListing) },
  returns: v.null(),
  handler: async (ctx, { workflowIds, from }) => {
    if (workflowIds.length > FORGET_BATCH) throw new Error(`finishDescendants: at most ${FORGET_BATCH} runs per call, got ${workflowIds.length}.`);
    const queue = [...workflowIds];
    const found: string[] = [];
    let listing = from;
    while (listing || queue.length > 0) {
      const parent: { workflowId: string; cursor: string | null } = listing ?? { workflowId: queue.shift()!, cursor: null };
      const page = await ctx.db
        .query('runs')
        .withIndex('parent', (q) => q.eq('parent', parent.workflowId))
        .paginate({ numItems: FORGET_PAGE, cursor: parent.cursor });
      for (const child of page.page) {
        if (!child.live || child.format > FORMAT) continue;
        await ctx.db.patch('runs', child._id, { live: false });
        found.push(child.workflowId);
      }
      listing = page.isDone ? undefined : { workflowId: parent.workflowId, cursor: page.continueCursor };
      if (await budgetSpent(ctx)) break;
    }
    if (listing || queue.length > 0) await ctx.scheduler.runAfter(0, api.runs.finishDescendants, { workflowIds: queue, ...(listing ? { from: listing } : {}) });
    for (let i = 0; i < found.length; i += FORGET_BATCH) {
      await ctx.scheduler.runAfter(0, api.runs.finishDescendants, { workflowIds: found.slice(i, i + FORGET_BATCH) });
    }
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
      page: page.map((paused) => ({
        workflowId: paused.workflowId,
        workflow: paused.workflow,
        reason: paused.reason,
        detail: paused.detail,
        ...(paused.step === undefined ? {} : { step: paused.step }),
        at: paused.at,
        attempts: paused.attempts,
        nextAttemptAt: paused.nextAttemptAt,
        ...(paused.lastError === undefined ? {} : { lastError: paused.lastError }),
      })),
      isDone,
      continueCursor,
    };
  },
});

/** For the CLI: a page of the ids of a workflow's live runs, oldest first. A page stops early rather than read more than `LIVE_PAGE_BYTES`. */
export const live = query({
  args: { workflow: v.string(), paginationOpts: paginationOptsValidator },
  returns: v.object({ page: v.array(v.string()), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, { workflow, paginationOpts }) => {
    const result = await ctx.db
      .query('runs')
      .withIndex('workflowLive', (q) => q.eq('workflow', workflow).eq('live', true))
      .paginate({ ...paginationOpts, maximumBytesRead: LIVE_PAGE_BYTES });
    return { page: result.page.map((run) => run.workflowId), isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

/** For the CLI: who created the records of these runs, for those that have one. At most `PAGE_SIZE` ids. */
export const origins = query({
  args: { workflowIds: v.array(v.string()) },
  returns: v.array(v.object({ workflowId: v.string(), origin: vOrigin })),
  handler: async (ctx, { workflowIds }) => {
    if (workflowIds.length > PAGE_SIZE) throw new Error(`origins: at most ${PAGE_SIZE} ids, got ${workflowIds.length}.`);
    const found = await Promise.all(workflowIds.map((workflowId) => row(ctx, workflowId)));
    return found.flatMap((run) => (run ? [{ workflowId: run.workflowId, origin: run.origin }] : []));
  },
});

/**
 * Deletes a run's record and pause, for a run whose workflow is gone, and
 * then the records of its child workflows, which upstream deletes with it.
 * The workflow mutation calls it at the run's next retry, with `journal`, a
 * handle to upstream's `journal.load`, for the descendants from before
 * adoption whose journals upstream hasn't deleted yet. The run's own journal
 * is gone, so the records of its children that aren't linked to it, if it's
 * from before adoption, are left. Returns how many rows it deleted, so 0 for
 * a run this package never saw.
 */
export const cleanup = mutation({
  args: { workflowId: v.string(), journal: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, { workflowId, journal }) => {
    const [current, paused] = [await row(ctx, workflowId), await pauseRow(ctx, workflowId)];
    if (current) await ctx.db.delete('runs', current._id);
    if (paused) await ctx.db.delete('pauses', paused._id);
    if (current) {
      await ctx.scheduler.runAfter(0, api.runs.forget, { workflowIds: [], from: { workflowId, cursor: null }, ...(journal === undefined ? {} : { journal }) });
    }
    return (current ? 1 : 0) + (paused ? 1 : 0);
  },
});

/**
 * Deletes the records and pauses of these runs and of their descendants: the
 * child workflows upstream deletes with a run, and theirs. A run's children
 * are the records linked to it (`parent`), and, for a run from before the app
 * adopted this package, whose children aren't linked, the `runWorkflow`
 * entries of its journal, read through `journal` (a handle to upstream's
 * `journal.load`) before the run's own record goes. It works in batches: when
 * the transaction has used about half of a Convex limit, it schedules itself
 * for the rest (`from` is the run whose children it was listing), and it
 * schedules the children it found, `FORGET_BATCH` per call.
 */
export const forget = mutation({
  args: {
    workflowIds: v.array(v.string()),
    from: v.optional(vListing),
    journal: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { workflowIds, from, journal }) => {
    // Far below Convex's 8,192 elements per array: callers pass, and it schedules, batches.
    if (workflowIds.length > FORGET_BATCH) throw new Error(`forget: at most ${FORGET_BATCH} runs per call, got ${workflowIds.length}.`);
    const queue = [...workflowIds];
    const found = new Set<string>();
    let listing = from;
    while (listing || queue.length > 0) {
      if (listing) {
        const parent = listing.workflowId;
        const page = await ctx.db
          .query('runs')
          .withIndex('parent', (q) => q.eq('parent', parent))
          .paginate({ numItems: FORGET_PAGE, cursor: listing.cursor });
        for (const child of page.page) found.add(child.workflowId);
        listing = page.isDone ? undefined : { workflowId: parent, cursor: page.continueCursor };
      } else {
        const workflowId = queue.shift()!;
        const [current, paused] = [await row(ctx, workflowId), await pauseRow(ctx, workflowId)];
        // Its journal first: `cleanup` from a mutation deletes it later in this transaction.
        if (journal && (!current || current.origin === 'adopted')) for (const child of await unlinkedChildren(ctx, journal, workflowId)) found.add(child);
        if (current) await ctx.db.delete('runs', current._id);
        if (paused) await ctx.db.delete('pauses', paused._id);
        listing = { workflowId, cursor: null };
      }
      if (await budgetSpent(ctx)) break;
    }
    const withJournal = journal === undefined ? {} : { journal };
    if (listing || queue.length > 0)
      await ctx.scheduler.runAfter(0, api.runs.forget, { workflowIds: queue, ...(listing ? { from: listing } : {}), ...withJournal });
    const children = [...found];
    for (let i = 0; i < children.length; i += FORGET_BATCH) {
      await ctx.scheduler.runAfter(0, api.runs.forget, { workflowIds: children.slice(i, i + FORGET_BATCH), ...withJournal });
    }
    return null;
  },
});

/**
 * The child workflows a run's journal started that aren't linked to it: none
 * if its workflow is gone. Raw entries, so ones without a kind, from older
 * upstream versions, count as function calls. A journal too big to load
 * whole names only the children in the part that loaded; it says so.
 */
async function unlinkedChildren(ctx: MutationCtx, journal: string, workflowId: string): Promise<string[]> {
  type Loaded = { journalEntries: { step: { kind?: string; workflowId?: string } }[]; ok: boolean };
  let loaded: Loaded;
  try {
    loaded = await ctx.runQuery(journal as FunctionHandle<'query', { workflowId: string }, Loaded>, { workflowId });
  } catch (error) {
    if (isWorkflowNotFound(error, workflowId)) return [];
    throw error;
  }
  const entries = loaded.journalEntries;
  if (loaded.ok === false) {
    console.warn(`Workflow ${workflowId}'s journal is too big to load whole: the records of its child workflows past what loaded are left.`);
  }
  const children: string[] = [];
  for (const { step } of entries) {
    if (step.kind !== 'workflow' || !step.workflowId) continue;
    // A linked child is listed from the index.
    if ((await row(ctx, step.workflowId))?.parent !== workflowId) children.push(step.workflowId);
  }
  return children;
}
