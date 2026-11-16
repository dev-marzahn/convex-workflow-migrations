import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// One row per workflow run: which migrations its history has had, the edits
// they made, and whether the run is paused. Ids are strings because the
// workflows and their journals live in the @convex-dev/workflow component.

const vWhere = v.union(v.literal('after'), v.literal('before'));
export const vStepKind = v.union(v.literal('function'), v.literal('workflow'), v.literal('event'), v.literal('sleep'));

/**
 * One edit to a run's history. Steps are named by id: a journal entry's id, or
 * the `id` of a step an earlier `insert` added. The history is the journal
 * with these applied in order.
 */
export const vOverlayOp = v.union(
  // A finished stand-in: replay resolves the matching call with `result` and runs nothing.
  v.object({
    op: v.literal('insert'),
    id: v.string(),
    where: vWhere,
    anchor: v.string(),
    name: v.string(),
    kind: vStepKind,
    // Without args, only the name and kind are matched.
    args: v.optional(v.any()),
    result: v.any(),
  }),
  v.object({ op: v.literal('remove'), target: v.string() }),
  // What the current code calls instead: the step ran with its recorded name and args.
  v.object({ op: v.literal('rewrite'), target: v.string(), name: v.optional(v.string()), args: v.optional(v.any()) }),
);

export const vPauseReason = v.union(v.literal('mismatch'), v.literal('migration'), v.literal('migrations'), v.literal('error'));

export const vPaused = v.object({
  reason: vPauseReason,
  detail: v.string(),
  // For a mismatch: the position in the history where replay stopped matching.
  step: v.optional(v.number()),
  // When the run first paused, and how many attempts have paused it since.
  at: v.number(),
  attempts: v.number(),
  nextAttemptAt: v.number(),
  // What a retry calls: the workflow mutation's function handle, with the
  // generation the run was at.
  handle: v.string(),
  generationNumber: v.number(),
});

export default defineSchema({
  runs: defineTable({
    workflowId: v.string(),
    // The workflow's function name, from getFunctionMetadata.
    workflow: v.string(),
    // The migration ids applied to this run's history, in order.
    applied: v.array(v.string()),
    overlay: v.array(vOverlayOp),
    paused: v.optional(vPaused),
    // Set by `restartFrom` for the handler run it starts: remove every step
    // from this position of the migrated history on.
    restart: v.optional(v.number()),
  })
    .index('workflowId', ['workflowId'])
    .index('paused', ['paused.nextAttemptAt']),
});
