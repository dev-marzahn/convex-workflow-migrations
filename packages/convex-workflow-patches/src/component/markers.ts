import { v } from 'convex/values';

import { mutation, query } from './_generated/server.js';

const vMarker = v.object({ patchId: v.string(), beforeStepId: v.string() });

/** The markers of one run. Read once per handler run, before replay. */
export const list = query({
  args: { workflowId: v.string() },
  returns: v.array(vMarker),
  handler: async (ctx, { workflowId }) => {
    const rows = await ctx.db
      .query('markers')
      .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
      .collect();
    return rows.map(({ patchId, beforeStepId }) => ({ patchId, beforeStepId }));
  },
});

/** Called by the workflow mutation, in the same transaction as the steps the markers precede. */
export const record = mutation({
  args: { workflowId: v.string(), markers: v.array(vMarker) },
  returns: v.null(),
  handler: async (ctx, { workflowId, markers }) => {
    for (const marker of markers) {
      await ctx.db.insert('markers', { workflowId, ...marker });
    }
    return null;
  },
});

/** Deletes a run's markers. `WorkflowManager.cleanup` calls this after the workflow component's cleanup. */
export const cleanup = mutation({
  args: { workflowId: v.string() },
  returns: v.number(),
  handler: async (ctx, { workflowId }) => {
    const rows = await ctx.db
      .query('markers')
      .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
      .collect();
    await Promise.all(rows.map((row) => ctx.db.delete('markers', row._id)));
    return rows.length;
  },
});

/** Which runs recorded a patch. For tooling, e.g. finding runs that still need an old branch. */
export const runsWithPatch = query({
  args: { patchId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { patchId }) => {
    const rows = await ctx.db
      .query('markers')
      .withIndex('patchId', (q) => q.eq('patchId', patchId))
      .collect();
    return [...new Set(rows.map((row) => row.workflowId))];
  },
});
