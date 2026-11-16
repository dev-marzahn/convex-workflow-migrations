import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// A record per workflow run (`runs`): which migrations its history has had,
// the edits they made, whether it's still running and which run started it.
// A paused run also has a row in `pauses`, kept apart so that listing and
// retrying paused runs never reads a record's overlay. Ids are strings because
// the workflows and their journals live in the @convex-dev/workflow component.

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

/** A run's pause, as `pauses` stores it and `runs:load` returns it. */
export const vPaused = v.object({
  reason: vPauseReason,
  detail: v.string(),
  // For a mismatch, rule 2 or rule 3: the position in the history where
  // replay stopped matching, and the id of the step there.
  step: v.optional(v.number()),
  stepId: v.optional(v.string()),
  // How many migration ids the history had applied when it paused. With
  // `stepId`, `restartFrom` checks that `step` still means the same place.
  appliedCount: v.number(),
  // When the run first paused, and how many attempts it has had: the first
  // pause and every scheduled or `resumeAll` retry, each counted when it starts.
  at: v.number(),
  attempts: v.number(),
  nextAttemptAt: v.number(),
  // Why the last attempt didn't complete: its workflow mutation threw, or
  // never finished. A handler run that pauses clears it. It keeps the pause.
  lastError: v.optional(v.string()),
  // How many handler runs have paused the run. A retry compares it before and
  // after calling the workflow mutation, to tell a handler run that paused
  // again from one that returned without replaying.
  pausedRuns: v.number(),
  // What a retry calls: the workflow mutation's function handle, with the
  // generation the run was at.
  handle: v.string(),
  generationNumber: v.number(),
  // From `restartFrom`, only inside its transaction: a position in the
  // history as the pause saw it, after `restart`.
  restartFrom: v.optional(v.number()),
});

/**
 * Who created a run's record. `start`: the workflow mutation, in the
 * transaction that created the run. `child`: its parent's handler run, in the
 * transaction whose `runWorkflow` step created it. `adopted`: the run's first
 * handler run, or `restart`, for a run from before the app adopted this
 * package; its child workflows have no `parent` links.
 */
export const vOrigin = v.union(v.literal('start'), v.literal('child'), v.literal('adopted'));

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

/** How many run ids one `forget` call takes: what the manager passes, and what `forget` schedules per call. */
export const FORGET_BATCH = 500;

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
    // The workflow's function name: from getFunctionMetadata, or for a child
    // workflow before its first handler run, the function its parent ran.
    workflow: v.string(),
    // The migration ids applied to this run's history, in order. Missing for
    // a child workflow before its first handler run: its parent's code
    // doesn't know the child's migrations (`prepareRun` in src/migrations.ts).
    applied: v.optional(v.array(v.string())),
    overlay: v.array(vOverlayOp),
    // From `WorkflowManager.restart`: the id of the step the next handler
    // run removes the history from, so the steps from there run again. The
    // id is resolved before the run's pending migrations apply, and keeps it
    // on the same step when they do.
    restart: v.optional(v.string()),
    // Whether the run is running, as far as this package saw: set when it's
    // created and restarted, cleared when a handler run completes it and when
    // the manager fails or cancels it. The CLI lists runs by it.
    live: v.boolean(),
    origin: vOrigin,
    // For a child workflow: the run whose `runWorkflow` step started it.
    // `cleanup` follows these links to the records upstream deletes with a run.
    parent: v.optional(v.string()),
    // The FORMAT of the version that wrote the row.
    format: v.number(),
  })
    .index('workflowId', ['workflowId'])
    // For the CLI's export of every running run.
    .index('workflowLive', ['workflow', 'live'])
    .index('parent', ['parent']),
  // One row per paused run. A run's record is written only when a handler run
  // replays it; pausing, listing, resuming and backoff touch only this table.
  pauses: defineTable({ workflowId: v.string(), workflow: v.string(), ...vPaused.fields })
    .index('workflowId', ['workflowId'])
    // For `list` and `resumeAll`, the one that paused first first. A run that
    // pauses again keeps its `at`, so it doesn't move past a cursor and get
    // listed or retried twice.
    .index('at', ['at'])
    .index('workflowAt', ['workflow', 'at']),
});
