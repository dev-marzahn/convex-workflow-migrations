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
  v.literal('error'),
);

export const vPaused = v.object({
  reason: vPauseReason,
  detail: v.string(),
  // For a mismatch or a throw: the position in the history where replay stopped matching.
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

/**
 * Where the next handler run removes the history from, and the steps after
 * it run again: a position in the migrated history (`restartFrom`, from the
 * position `paused` reports), or the id of the step there (`restart`, which
 * resolves its position before the run's pending migrations apply, so the id
 * keeps it on the same step).
 */
export const vRestart = v.union(v.number(), v.string());

/** The format of the rows this version writes. A row with a higher one is from a newer version. */
export const FORMAT = 1;

/**
 * The longest pause `detail`, in characters. A mismatch's two calls are each
 * cut to this length before they're put together, so its detail can be
 * about twice as long.
 */
export const DETAIL_LIMIT = 8192;

/** `text`, cut to `limit` characters with an ellipsis. */
export function capDetail(text: string, limit = DETAIL_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
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
    restart: v.optional(vRestart),
    // The FORMAT of the version that wrote the row.
    format: v.number(),
  })
    .index('workflowId', ['workflowId'])
    // For `list`, the next one due first.
    .index('paused', ['paused.nextAttemptAt'])
    .index('workflowPaused', ['workflow', 'paused.nextAttemptAt'])
    // For `resumeAll`: a retry that pauses again keeps its `at`, so it
    // doesn't move past the cursor and get retried twice.
    .index('pausedAt', ['paused.at'])
    .index('workflowPausedAt', ['workflow', 'paused.at']),
});
