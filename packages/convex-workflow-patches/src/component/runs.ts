// The patches component's functions. They're internal to this package: the
// workflow mutation calls `load` and `save`, `WorkflowManager.cleanup` calls
// `cleanup`, and the predeploy check reads `lookup` and `recorded`. A
// release's check reads what older versions of this package wrote, so keep
// `lookup` and `recorded` compatible from one version to the next.
import { v } from 'convex/values';

import type { MutationCtx, QueryCtx } from './_generated/server.js';
import { mutation, query } from './_generated/server.js';

const vMarker = v.object({ patchId: v.string(), beforeStepId: v.string() });
const vSkip = v.object({ patchId: v.string(), atStepId: v.string() });
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

async function record(ctx: MutationCtx, workflow: string, patchId: string) {
  const row = await ctx.db
    .query('recorded')
    .withIndex('workflow', (q) => q.eq('workflow', workflow).eq('patchId', patchId))
    .first();
  if (!row) await ctx.db.insert('recorded', { workflow, patchId });
}

/** A run's records. The workflow mutation reads this once per handler run, before replay. */
export const load = query({
  args: { workflowId: v.string() },
  returns: v.object({ markers: v.array(vMarker), skips: v.array(vSkip), run: v.union(vRun, v.null()) }),
  handler: async (ctx, { workflowId }) => {
    const { markers, skips, run } = await rows(ctx, workflowId);
    return {
      markers: markers.map(({ patchId, beforeStepId }) => ({ patchId, beforeStepId })),
      skips: skips.map(({ patchId, atStepId }) => ({ patchId, atStepId })),
      run: run && { workflow: run.workflow, known: run.known },
    };
  },
});

/** Records what a handler run decided. The workflow mutation calls it, inside its own transaction. */
export const save = mutation({
  args: { workflowId: v.string(), run: vRun, markers: v.array(vMarker), skips: v.array(vSkip), unskip: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { workflowId, run, markers, skips, unskip }) => {
    const current = await rows(ctx, workflowId);
    for (const marker of markers) {
      await ctx.db.insert('markers', { workflowId, ...marker });
      await record(ctx, run.workflow, marker.patchId);
    }
    const skipped = new Set(current.skips.map((row) => row.patchId));
    for (const skip of skips) {
      if (skipped.has(skip.patchId)) continue;
      await ctx.db.insert('skips', { workflowId, ...skip });
      await record(ctx, run.workflow, skip.patchId);
    }
    for (const row of current.skips) if (unskip.includes(row.patchId)) await ctx.db.delete('skips', row._id);
    if (current.run) await ctx.db.patch('runs', current.run._id, run);
    else await ctx.db.insert('runs', { workflowId, ...run });
    return null;
  },
});

/** The records of the given runs, for the predeploy check. One page of runs at a time. */
export const lookup = query({
  args: { workflowIds: v.array(v.string()) },
  returns: v.array(v.object({ workflowId: v.string(), run: v.union(vRun, v.null()), took: v.array(v.string()), skips: v.array(v.string()) })),
  handler: async (ctx, { workflowIds }) =>
    Promise.all(
      workflowIds.map(async (workflowId) => {
        const { markers, skips, run } = await rows(ctx, workflowId);
        return {
          workflowId,
          run: run && { workflow: run.workflow, known: run.known },
          took: [...new Set(markers.map((row) => row.patchId))],
          skips: skips.map((row) => row.patchId),
        };
      }),
    ),
});

/** Per workflow function, every patch id its runs have taken or skipped, for the predeploy check. */
export const recorded = query({
  args: {},
  returns: v.array(v.object({ workflow: v.string(), patchIds: v.array(v.string()) })),
  handler: async (ctx) => {
    const byWorkflow = new Map<string, string[]>();
    for (const { workflow, patchId } of await ctx.db.query('recorded').collect()) byWorkflow.set(workflow, [...(byWorkflow.get(workflow) ?? []), patchId]);
    return [...byWorkflow].map(([workflow, patchIds]) => ({ workflow, patchIds }));
  },
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
