// The migrations component's functions. They're internal to this package: the
// workflow mutation calls `load` and `save`, and the `WorkflowManager` calls
// `load` and `cleanup`.
import { v } from 'convex/values';

import { mutation, query, type QueryCtx } from './_generated/server.js';
import { vRecord } from './schema.js';

const row = (ctx: QueryCtx, workflowId: string) =>
  ctx.db
    .query('runs')
    .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
    .first();

/**
 * A run's record, or null if it has none: a child workflow before its first
 * handler run, or a run from before the app adopted this package.
 */
export const load = query({
  args: { workflowId: v.string() },
  returns: v.union(vRecord, v.null()),
  handler: async (ctx, { workflowId }) => {
    const found = await row(ctx, workflowId);
    return found && { applied: found.applied, overlay: found.overlay };
  },
});

/**
 * Writes a run's record: in the transaction that creates the run, and after a
 * handler run that changed it, in its transaction.
 */
export const save = mutation({
  args: { workflowId: v.string(), ...vRecord.fields },
  returns: v.null(),
  handler: async (ctx, { workflowId, ...record }) => {
    const current = await row(ctx, workflowId);
    if (current) await ctx.db.patch('runs', current._id, record);
    else await ctx.db.insert('runs', { workflowId, ...record });
    return null;
  },
});

/** Deletes a run's record. `WorkflowManager.cleanup` calls this after upstream's cleanup. */
export const cleanup = mutation({
  args: { workflowId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { workflowId }) => {
    const current = await row(ctx, workflowId);
    if (current) await ctx.db.delete('runs', current._id);
    return current !== null;
  },
});
