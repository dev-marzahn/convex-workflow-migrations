// The migrations component's functions. They're internal to this package: the
// workflow mutation calls `load`, `save` and `pause`; a pause schedules
// `retry`; the `WorkflowManager` calls `list`, `retry`, `unpause` and
// `cleanup`; the CLI's `histories` reads `load`. Rows, scheduled `retry` calls
// and `load`'s result outlive a deploy, so keep them readable from one version
// of this package to the next (see CONTRIBUTING.md).
import type { FunctionHandle } from 'convex/server';
import { type Infer, v } from 'convex/values';

import { api } from './_generated/api.js';
import type { Doc } from './_generated/dataModel.js';
import type { MutationCtx, QueryCtx } from './_generated/server.js';
import { mutation, query } from './_generated/server.js';
import { vOverlayOp, vPaused, vPauseReason } from './schema.js';

/** Minutes before each retry of a paused run: 1, 10, 60, then every 6 hours. */
export const BACKOFF_MS = [60_000, 600_000, 3_600_000, 21_600_000] as const;
const backoff = (attempts: number) => BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;

const vRecord = v.object({
  workflow: v.string(),
  applied: v.array(v.string()),
  overlay: v.array(vOverlayOp),
  paused: v.optional(vPaused),
  restart: v.optional(v.number()),
});

const vPausedRun = v.object({
  workflowId: v.string(),
  workflow: v.string(),
  reason: vPauseReason,
  detail: v.string(),
  step: v.optional(v.number()),
  at: v.number(),
  attempts: v.number(),
  nextAttemptAt: v.number(),
});

async function row(ctx: QueryCtx, workflowId: string) {
  return await ctx.db
    .query('runs')
    .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
    .first();
}

type Pause = Omit<Infer<typeof vPaused>, 'at' | 'attempts' | 'nextAttemptAt'>;

/** Pauses the run, or counts another attempt of a paused one, and schedules the next retry. */
async function setPaused(ctx: MutationCtx, workflowId: string, current: Doc<'runs'>, pause: Pause): Promise<void> {
  const now = Date.now();
  const attempts = (current.paused?.attempts ?? 0) + 1;
  const nextAttemptAt = now + backoff(attempts);
  await ctx.db.patch('runs', current._id, { paused: { ...pause, at: current.paused?.at ?? now, attempts, nextAttemptAt } });
  await ctx.scheduler.runAt(nextAttemptAt, api.runs.retry, { workflowId });
}

/** A run's record, or null if it has none yet. The workflow mutation reads this once per handler run, before replay. */
export const load = query({
  args: { workflowId: v.string() },
  returns: v.union(vRecord, v.null()),
  handler: async (ctx, { workflowId }) => {
    const found = await row(ctx, workflowId);
    if (!found) return null;
    const { workflow, applied, overlay, paused, restart } = found;
    return { workflow, applied, overlay, ...(paused ? { paused } : {}), ...(restart === undefined ? {} : { restart }) };
  },
});

/** Saves what a handler run applied and recorded, and ends a pause. The workflow mutation calls it, inside its own transaction. */
export const save = mutation({
  args: { workflowId: v.string(), workflow: v.string(), applied: v.array(v.string()), overlay: v.array(vOverlayOp) },
  returns: v.null(),
  handler: async (ctx, { workflowId, ...record }) => {
    const current = await row(ctx, workflowId);
    if (current) await ctx.db.replace('runs', current._id, { workflowId, ...record });
    else await ctx.db.insert('runs', { workflowId, ...record });
    return null;
  },
});

/**
 * Pauses a run and schedules a retry. `record` is saved too when given: the
 * handler run executed a step a migration inserted, so its migrations stand.
 * Returns whether the run wasn't paused before, so the caller alerts once.
 */
export const pause = mutation({
  args: {
    workflowId: v.string(),
    workflow: v.string(),
    reason: vPauseReason,
    detail: v.string(),
    step: v.optional(v.number()),
    handle: v.string(),
    generationNumber: v.number(),
    record: v.optional(v.object({ applied: v.array(v.string()), overlay: v.array(vOverlayOp) })),
  },
  returns: v.object({ first: v.boolean() }),
  handler: async (ctx, { workflowId, workflow, record, ...pause }) => {
    let current = await row(ctx, workflowId);
    if (!current) {
      // A run from before the app adopted this package: nothing applied yet.
      const id = await ctx.db.insert('runs', { workflowId, workflow, applied: [], overlay: [] });
      current = (await ctx.db.get('runs', id))!;
    }
    if (record) await ctx.db.patch('runs', current._id, record);
    const first = current.paused === undefined;
    await setPaused(ctx, workflowId, current, pause);
    return { first };
  },
});

/**
 * Retries a paused run: calls its workflow mutation with the generation it
 * paused at, the call upstream's workpool makes after every step. Scheduled
 * by a pause, it runs only when its attempt is due, and an error from the
 * workflow mutation counts as another failed attempt. Called with `now` or
 * `restartFrom` (by `WorkflowManager.resume` and `restartFrom`), it runs
 * right away and errors reach the caller. `restartFrom` throws, undoing
 * everything, if the run would pause again. Returns whether the run is still
 * paused.
 */
export const retry = mutation({
  args: { workflowId: v.string(), now: v.optional(v.boolean()), restartFrom: v.optional(v.number()) },
  returns: v.boolean(),
  handler: async (ctx, { workflowId, now, restartFrom }) => {
    const current = await row(ctx, workflowId);
    if (!current?.paused) return false;
    const { paused } = current;
    const forced = now === true || restartFrom !== undefined;
    // A later attempt is scheduled: this one is left over from an earlier pause.
    if (!forced && paused.nextAttemptAt > Date.now()) return true;
    if (restartFrom !== undefined) await ctx.db.patch('runs', current._id, { restart: restartFrom });
    const handle = paused.handle as FunctionHandle<'mutation', { workflowId: string; generationNumber: number }>;
    const args = { workflowId, generationNumber: paused.generationNumber };
    if (forced) {
      await ctx.runMutation(handle, args);
    } else {
      try {
        await ctx.runMutation(handle, args);
      } catch (error) {
        const detail = `The workflow mutation threw: ${error instanceof Error ? error.message : String(error)}`;
        await setPaused(ctx, workflowId, current, { reason: 'error', detail, handle: paused.handle, generationNumber: paused.generationNumber });
        return true;
      }
    }
    const after = (await row(ctx, workflowId))!;
    if (after.paused && after.paused.attempts === paused.attempts) {
      // The workflow mutation returned without replaying: the run finished,
      // was canceled or restarted, so it isn't paused any more.
      await ctx.db.patch('runs', after._id, { paused: undefined, restart: undefined });
      return false;
    }
    if (after.restart !== undefined) await ctx.db.patch('runs', after._id, { restart: undefined });
    if (restartFrom !== undefined && after.paused) {
      throw new Error(`Restarting ${workflowId} from step ${restartFrom} would pause it again (${after.paused.reason}): ${after.paused.detail}`);
    }
    return after.paused !== undefined;
  },
});

/** Ends a pause without retrying: the run was canceled or failed. */
export const unpause = mutation({
  args: { workflowId: v.string() },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    const current = await row(ctx, workflowId);
    if (current?.paused) await ctx.db.patch('runs', current._id, { paused: undefined, restart: undefined });
    return null;
  },
});

/** Paused runs, the next one due for a retry first. */
export const list = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(vPausedRun),
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query('runs')
      .withIndex('paused', (q) => q.gte('paused.nextAttemptAt', 0))
      .take(limit ?? 100);
    return rows.flatMap(({ workflowId, workflow, paused }) =>
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
            },
          ]
        : [],
    );
  },
});

/** Deletes a run's record. `WorkflowManager.cleanup` calls this after the workflow component's cleanup. */
export const cleanup = mutation({
  args: { workflowId: v.string() },
  returns: v.number(),
  handler: async (ctx, { workflowId }) => {
    const current = await row(ctx, workflowId);
    if (current) await ctx.db.delete('runs', current._id);
    return current ? 1 : 0;
  },
});
