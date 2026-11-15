import { v } from 'convex/values';

import type { QueryCtx } from './_generated/server.js';
import { mutation, query } from './_generated/server.js';

const vMarker = v.object({ patchId: v.string(), beforeStepId: v.string() });
const vRun = v.object({ workflow: v.string(), known: v.array(v.string()) });

async function rows(ctx: QueryCtx, workflowId: string) {
  const [markers, skips, runs] = await Promise.all([
    ctx.db
      .query('markers')
      .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
      .collect(),
    ctx.db
      .query('skips')
      .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
      .collect(),
    ctx.db
      .query('runs')
      .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
      .first(),
  ]);
  return { markers, skips, run: runs };
}

const deployedRow = (ctx: QueryCtx, workflow: string) =>
  ctx.db
    .query('workflows')
    .withIndex('workflow', (q) => q.eq('workflow', workflow))
    .first();

/** A run's records. The workflow mutation reads this once per handler run, before replay. */
export const load = query({
  args: { workflowId: v.string(), workflow: v.string() },
  returns: v.object({
    markers: v.array(vMarker),
    skips: v.array(v.string()),
    run: v.union(vRun, v.null()),
    deployed: v.union(v.array(v.string()), v.null()),
  }),
  handler: async (ctx, { workflowId, workflow }) => {
    const [{ markers, skips, run }, deployed] = await Promise.all([rows(ctx, workflowId), deployedRow(ctx, workflow)]);
    return {
      markers: markers.map(({ patchId, beforeStepId }) => ({ patchId, beforeStepId })),
      skips: skips.map((row) => row.patchId),
      run: run && { workflow: run.workflow, known: run.known },
      deployed: deployed?.declared ?? null,
    };
  },
});

/**
 * Records what a handler run decided. Called by the workflow mutation, in its
 * own transaction; don't call it yourself.
 */
export const save = mutation({
  args: {
    workflowId: v.string(),
    run: vRun,
    markers: v.array(vMarker),
    skips: v.array(v.string()),
    unskip: v.array(v.string()),
    deployed: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, { workflowId, run, markers, skips, unskip, deployed }) => {
    const current = await rows(ctx, workflowId);
    for (const marker of markers) await ctx.db.insert('markers', { workflowId, ...marker });
    const skipped = new Set(current.skips.map((row) => row.patchId));
    for (const patchId of skips) if (!skipped.has(patchId)) await ctx.db.insert('skips', { workflowId, patchId });
    for (const row of current.skips) if (unskip.includes(row.patchId)) await ctx.db.delete('skips', row._id);
    if (current.run) await ctx.db.patch('runs', current.run._id, run);
    else await ctx.db.insert('runs', { workflowId, ...run });
    if (deployed) {
      const row = await deployedRow(ctx, run.workflow);
      if (row) await ctx.db.patch('workflows', row._id, { declared: deployed });
      else await ctx.db.insert('workflows', { workflow: run.workflow, declared: deployed });
    }
    return null;
  },
});

/** The records of the given runs, for `convex-workflow-patches check`. One page of runs at a time. */
export const lookup = query({
  args: { workflowIds: v.array(v.string()) },
  returns: v.array(v.object({ workflowId: v.string(), run: v.union(vRun, v.null()), skips: v.array(v.string()) })),
  handler: async (ctx, { workflowIds }) =>
    Promise.all(
      workflowIds.map(async (workflowId) => {
        const { skips, run } = await rows(ctx, workflowId);
        return { workflowId, run: run && { workflow: run.workflow, known: run.known }, skips: skips.map((row) => row.patchId) };
      }),
    ),
});

/** Per workflow function, the patch ids the deployed release declares (as of its last run), for `check`. */
export const deployed = query({
  args: {},
  returns: v.array(v.object({ workflow: v.string(), declared: v.array(v.string()) })),
  handler: async (ctx) => (await ctx.db.query('workflows').collect()).map(({ workflow, declared }) => ({ workflow, declared })),
});

/** Deletes a run's records. `WorkflowManager.cleanup` calls this after the workflow component's cleanup. */
export const cleanup = mutation({
  args: { workflowId: v.string() },
  returns: v.number(),
  handler: async (ctx, { workflowId }) => {
    const { markers, skips, run } = await rows(ctx, workflowId);
    for (const row of markers) await ctx.db.delete('markers', row._id);
    for (const row of skips) await ctx.db.delete('skips', row._id);
    if (run) await ctx.db.delete('runs', run._id);
    return markers.length + skips.length + (run ? 1 : 0);
  },
});
