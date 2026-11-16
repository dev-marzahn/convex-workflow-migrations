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
  // Removes the journal entries from `from` through `through`, in journal
  // order: what `restartFrom` drops. Entries recorded later stay.
  v.object({ op: v.literal('truncate'), from: v.string(), through: v.string() }),
  // What the current code calls instead, and the result replay gives the
  // call: the step ran with its recorded name and args, and returned its
  // recorded result.
  v.object({ op: v.literal('rewrite'), target: v.string(), name: v.optional(v.string()), args: v.optional(v.any()), result: v.optional(v.any()) }),
  // The workflow's args as the current code expects them. The run keeps its own.
  v.object({ op: v.literal('workflowArgs'), args: v.any() }),
);

export const vPauseReason = v.union(
  v.literal('mismatch'),
  v.literal('args'),
  v.literal('threw'),
  v.literal('migration'),
  v.literal('migrations'),
  v.literal('overlay'),
);

export const vPaused = v.object({
  reason: vPauseReason,
  detail: v.string(),
  // For a mismatch or a throw: the position in the history where replay
  // stopped matching, and the id of the step there.
  step: v.optional(v.number()),
  stepId: v.optional(v.string()),
  // How many migration ids the history had applied when it paused. With
  // `stepId`, `restartFrom` checks that `step` still means the same place.
  appliedCount: v.number(),
  // When the run first paused, and how many attempts have paused it since.
  at: v.number(),
  attempts: v.number(),
  nextAttemptAt: v.number(),
  // Why the last attempt's workflow mutation threw, if it did. It keeps the pause.
  lastError: v.optional(v.string()),
  // `fail` holds the run until then: retries skip it, and `resume` and `restartFrom` throw.
  claimedUntil: v.optional(v.number()),
  // What a retry calls: the workflow mutation's function handle, with the
  // generation the run was at.
  handle: v.string(),
  generationNumber: v.number(),
});

/** A paused run, as `list` returns it. */
export const vPausedRun = v.object({
  workflowId: v.string(),
  workflow: v.string(),
  reason: vPauseReason,
  detail: v.string(),
  step: v.optional(v.number()),
  at: v.number(),
  attempts: v.number(),
  nextAttemptAt: v.number(),
  lastError: v.optional(v.string()),
});

export const vPausedPage = v.object({ page: v.array(vPausedRun), isDone: v.boolean(), continueCursor: v.string() });

/** The format of the rows this version writes. A row with a higher one is from a newer version. */
export const FORMAT = 1;

/**
 * The longest pause `detail`, in characters. A mismatch's two calls are each
 * cut to this length before they're put together, so its detail can be
 * about twice as long, about 16 KiB. The row's detail is cut to three times
 * this, 24,576 characters, whatever the caller passed.
 */
export const DETAIL_LIMIT = 8192;

/** `text`, cut to `limit` characters with an ellipsis, never inside a surrogate pair. */
export function capDetail(text: string, limit = DETAIL_LIMIT): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

export default defineSchema({
  runs: defineTable({
    workflowId: v.string(),
    // The workflow's function name, from getFunctionMetadata.
    workflow: v.string(),
    // The migration ids applied to this run's history, in order.
    applied: v.array(v.string()),
    overlay: v.array(vOverlayOp),
    paused: v.optional(vPaused),
    // From `WorkflowManager.restart`: the id of the step the next handler
    // run removes the history from, so the steps from there run again. The
    // id is resolved before the run's pending migrations apply, and keeps it
    // on the same step when they do.
    restart: v.optional(v.string()),
    // From `restartFrom`, only inside its transaction: a position in the
    // history as the pause saw it, after `restart`.
    restartFrom: v.optional(v.number()),
    // The FORMAT of the version that wrote the row.
    format: v.number(),
  })
    .index('workflowId', ['workflowId'])
    // For `list` and `resumeAll`, the one that paused first first. A retry
    // that pauses again keeps its `at`, so it doesn't move past a cursor and
    // get listed or retried twice.
    .index('pausedAt', ['paused.at'])
    .index('workflowPausedAt', ['workflow', 'paused.at']),
});
