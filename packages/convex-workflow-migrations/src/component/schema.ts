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

/** Why a run paused: README, "Pausing and recovery". */
export const vPauseReason = v.union(
  v.literal('mismatch'),
  v.literal('args'),
  v.literal('threw'),
  v.literal('migration'),
  v.literal('migrations'),
  v.literal('record'),
);

/** A paused run, as `list` returns it. */
export const vPausedRun = v.object({
  workflowId: v.string(),
  // The workflow's function name, like `pipeline:run`.
  workflow: v.string(),
  reason: vPauseReason,
  detail: v.string(),
  step: v.optional(v.number()),
  at: v.number(),
  attempts: v.number(),
  nextAttemptAt: v.number(),
  lastError: v.optional(v.string()),
});

/** The longest pause detail, in characters. A mismatch's call and step are each cut to this. */
export const DETAIL_LIMIT = 8192;

/** `text`, cut to `limit` characters with an ellipsis, never inside a surrogate pair. */
export function capDetail(text: string, limit = DETAIL_LIMIT): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

/** Whether `error` is upstream's for a workflow that doesn't exist, as its `journal.load` throws it. */
export function isWorkflowNotFound(error: unknown, workflowId: string): boolean {
  return (error instanceof Error ? error.message : String(error)).includes(`Workflow not found: ${workflowId}`);
}

export default defineSchema({
  runs: defineTable({ workflowId: v.string(), ...vRecord.fields }).index('workflowId', ['workflowId']),
  // One row per paused run, written by its pause and deleted when the pause
  // ends. Kept apart from `runs`, so listing and retrying never read an overlay.
  pauses: defineTable({
    ...vPausedRun.fields,
    // The id of the step at `step`, and how many migration ids were applied: where the run paused.
    stepId: v.optional(v.string()),
    appliedCount: v.number(),
    // How many handler runs paused the run: a retry compares it to tell one that paused again from one that didn't replay.
    pausedRuns: v.number(),
    // What a retry calls: the workflow mutation's function handle, with the generation the run paused at.
    handle: v.string(),
    generationNumber: v.number(),
  })
    .index('workflowId', ['workflowId'])
    // For `list`: by workflow, then by creation time, which is when the run first paused.
    .index('workflow', ['workflow']),
});
