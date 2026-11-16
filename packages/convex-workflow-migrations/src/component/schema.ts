import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// A record per workflow run: the migrations applied to its history, and the
// edits they made (the overlay). Ids are strings because the workflows and
// their journals live in the @convex-dev/workflow component.

export const vStepKind = v.union(v.literal('function'), v.literal('workflow'), v.literal('event'), v.literal('sleep'));

/**
 * One edit to a run's history, which is the journal with these applied in
 * order. Steps are named by id: a journal entry's, or a stand-in's.
 */
export const vOverlayOp = v.union(
  // A finished stand-in: replay resolves the call with `result`. Without `args`, only the name and kind are matched.
  v.object({
    op: v.literal('insert'),
    id: v.string(),
    where: v.union(v.literal('after'), v.literal('before')),
    anchor: v.string(),
    name: v.string(),
    kind: vStepKind,
    args: v.optional(v.any()),
    result: v.any(),
  }),
  v.object({ op: v.literal('remove'), target: v.string() }),
  // What the current code calls instead, and the result replay gives the call. The step ran as recorded.
  v.object({ op: v.literal('rewrite'), target: v.string(), name: v.optional(v.string()), args: v.optional(v.any()), result: v.optional(v.any()) }),
  // The workflow's args as the current code expects them. The run keeps its own.
  v.object({ op: v.literal('workflowArgs'), args: v.any() }),
);

export const vRecord = v.object({
  // The migration ids applied to the history, in order: a prefix of the workflow's list.
  applied: v.array(v.string()),
  overlay: v.array(vOverlayOp),
});

export default defineSchema({
  runs: defineTable({ workflowId: v.string(), ...vRecord.fields }).index('workflowId', ['workflowId']),
});
