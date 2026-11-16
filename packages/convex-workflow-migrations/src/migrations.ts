// Migrations, and what a handler run does with a run's record: apply the
// pending migrations in memory before replay, then save the result in the
// handler run's transaction, or pause the run, which saves nothing else.
import { createFunctionHandle, type GenericDataModel, type GenericMutationCtx, makeFunctionReference } from 'convex/server';

import type { ComponentApi } from './component/_generated/component.js';
import { capDetail, DETAIL_LIMIT } from './component/schema.ts';
import { type History, HistoryView, json, type OverlayOp, type RecordedStep } from './history.ts';
import { argsValid, message, ReplayError, type ReplayReason } from './replay.ts';
import type { WorkflowId } from './vendor/workflow/publicTypes.ts';
import type { JournalEntry } from './vendor/workflow/types.ts';

/** The installed migrations component, `components.workflowMigrations`. */
export type MigrationsComponent = ComponentApi;

/** A change to a workflow's recorded histories. Create one with `migration(id, migrate)`. */
export type Migration = { readonly id: string; readonly migrate: (h: History) => void };

/**
 * A migration: `migrate` rewrites a run's history into the shape the current
 * handler expects. `id` is permanent. `migrate` must be synchronous and pure,
 * and work on any history.
 */
export function migration(id: string, migrate: (h: History) => void): Migration {
  if (typeof id !== 'string' || id === '') throw new Error('migration(id, migrate): the id must be a non-empty string.');
  return { id, migrate };
}

/** Checks a workflow's migration list when it's defined, so a duplicate id fails the push. */
export function checkMigrations(migrations: readonly Migration[] = []): readonly Migration[] {
  const seen = new Set<string>();
  for (const { id } of migrations) {
    if (seen.has(id)) throw new Error(`define({ migrations }): the id "${id}" is listed twice. Migration ids are permanent and unique per workflow.`);
    seen.add(id);
  }
  return migrations;
}

type MutationCtx = GenericMutationCtx<GenericDataModel>;

/** What `onPause` is told about a run that paused. */
export type PauseInfo = {
  workflowId: WorkflowId;
  reason: ReplayReason;
  detail: string;
  /**
   * The position in the history (from 0): for a mismatch, where replay
   * stopped matching; for the throw rule 2, the first step not replayed; for
   * rule 3, the step the handler got last. Unset otherwise.
   */
  step?: number;
  /** How many attempts the run has had: the first pause, and every scheduled retry, each counted when it starts. 1 the first time. */
  attempts: number;
};

/** What the vendored workflow mutation gets from the manager: the migrations component, the workflow's migrations, its `args` validator and `onPause`. */
export type WorkflowMigrations = {
  component: MigrationsComponent;
  list: readonly Migration[];
  args?: unknown;
  onPause?: ((ctx: MutationCtx, info: PauseInfo) => void | Promise<void>) | undefined;
};

/** A history with the run's pending migrations applied: every applied id, the ids applied now (`ran`), and those of them that edited it (`edited`). */
export type Prepared = { history: HistoryView; applied: string[]; ran: string[]; edited: string[] };

const quoted = (ids: readonly string[]) => (ids.length === 0 ? 'none' : ids.map((id) => `"${id}"`).join(', '));

/**
 * Builds the history from the journal and the stored overlay, and applies
 * the migrations the run hasn't had, in memory. Throws a `ReplayError` if the
 * overlay edits a step the journal doesn't have, the applied ids aren't a
 * prefix of the list, or a migration throws.
 */
export function prepareHistory(
  journal: readonly RecordedStep[],
  stored: { applied: readonly string[]; overlay: readonly OverlayOp[] },
  migrations: readonly Migration[],
  args: unknown,
  options: { strict?: boolean } = {},
): Prepared {
  const history = new HistoryView(journal, stored.overlay, args, options);
  const ids = migrations.map((m) => m.id);
  const applied = [...stored.applied];
  if (applied.length > ids.length || applied.some((id, i) => ids[i] !== id)) {
    throw new ReplayError(
      'migrations',
      `The run has migrations ${quoted(applied)} applied, but this code lists ${quoted(ids)}. Its applied ids must start the list, in order: ` +
        'a migration was removed, renamed or reordered, or this code is older than the code the run ran on.',
    );
  }
  const ran = ids.slice(applied.length);
  const edited: string[] = [];
  for (const m of migrations.slice(applied.length)) {
    const edits = history.edits;
    try {
      if ((m.migrate(history) as unknown) instanceof Promise) throw new Error('it returned a promise; migrations are synchronous');
    } catch (error) {
      throw new ReplayError('migration', `Migration "${m.id}" threw: ${message(error)}`);
    }
    if (history.edits > edits) edited.push(m.id);
  }
  return { history, applied: [...applied, ...ran], ran, edited };
}

/**
 * `prepareHistory`, for a run whose applied ids may be unknown: a child
 * workflow, or a run from before the app adopted this package. With journal
 * entries, it's from before the first migration: every migration applies.
 * With none, its args decide: if they pass the `args` validator (`valid`),
 * it starts with every migration applied, as a run this code started would;
 * otherwise every migration applies to the empty history.
 */
export function prepareRun(
  journal: readonly RecordedStep[],
  stored: { applied?: readonly string[] | undefined; overlay: readonly OverlayOp[] },
  migrations: readonly Migration[],
  args: unknown,
  valid: (args: unknown) => boolean,
  options: { strict?: boolean } = {},
): Prepared {
  const prepare = (applied: readonly string[]) => prepareHistory(journal, { applied, overlay: stored.overlay }, migrations, args, options);
  if (stored.applied !== undefined) return prepare(stored.applied);
  if (journal.length > 0) return prepare([]);
  const current = prepare(migrations.map((m) => m.id));
  return valid(current.history.workflowArgs) ? current : prepare([]);
}

export function recordedStep(entry: JournalEntry): RecordedStep {
  const { step } = entry;
  return {
    id: entry._id,
    name: step.name,
    // Entries from old upstream versions may have no kind.
    kind: step.kind ?? 'function',
    args: step.args,
    ...(step.inProgress || !step.runResult ? {} : { runResult: step.runResult }),
    startedAt: step.startedAt,
  };
}

type Logger = { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

/**
 * For the vendored workflow mutation, once per handler run, before replay:
 * loads the run's record and applies its pending migrations. Returns why the
 * run can't replay (`blocked`), or the prepared history and `save`, which
 * stores what changed and ends a pause, after a replay that matched; and
 * `pause`. Convex's document size limit makes `save` throw for an overlay too
 * big to store.
 */
export async function loadRecord(ctx: MutationCtx, migrations: WorkflowMigrations, run: { _id: string; args: unknown }, journal: readonly JournalEntry[]) {
  const workflowId = run._id as WorkflowId;
  const row = await ctx.runQuery(migrations.component.runs.load, { workflowId });
  const valid = (args: unknown) => argsValid({ args: migrations.args }, args, ctx.db);
  let prepared: Prepared | undefined;
  let blocked: ReplayError | undefined;
  try {
    prepared = prepareRun(journal.map(recordedStep), { applied: row?.applied, overlay: row?.overlay ?? [] }, migrations.list, run.args, valid);
  } catch (error) {
    if (!(error instanceof ReplayError)) throw error;
    blocked = error;
  }
  /**
   * Pauses the run: records why, with this workflow mutation's function
   * handle for the retry, and calls `onPause` if the pause says to. Saves
   * nothing else, so the next attempt migrates again. Logs a warning.
   */
  const pause = async (generationNumber: number, cause: ReplayError, console: Logger) => {
    const workflow = (await ctx.meta.getFunctionMetadata()).name;
    const handle = await createFunctionHandle(makeFunctionReference<'mutation'>(workflow));
    // The only cut of the whole detail, so huge args or errors can't make the pause too
    // big to store. A mismatch's call and step are cut to DETAIL_LIMIT each already.
    const info = {
      reason: cause.reason,
      detail: capDetail(cause.message, 3 * DETAIL_LIMIT),
      ...(cause.position === undefined ? {} : { step: cause.position }),
    };
    const { notify, attempts } = await ctx.runMutation(migrations.component.runs.pause, { workflowId, workflow, ...info, handle, generationNumber });
    console.warn(`Workflow ${workflow} (${workflowId}) paused (${cause.reason}): ${info.detail}`);
    if (!notify || !migrations.onPause) return;
    try {
      await migrations.onPause(ctx, { workflowId, ...info, attempts });
    } catch (error) {
      console.error(`onPause threw for workflow ${workflowId}:`, error);
    }
  };
  if (!prepared) return { blocked: blocked!, pause };
  const { applied, history } = prepared;
  const save = async () => {
    const record = { applied, overlay: history.overlay() };
    if (!row || row.paused || json({ applied: row.applied, overlay: row.overlay }) !== json(record))
      await ctx.runMutation(migrations.component.runs.save, { workflowId, ...record });
  };
  return { ...prepared, blocked: undefined, save, pause };
}

/** For the vendored workflow mutation, in the transaction that creates a run: its record, with every migration applied. */
export async function recordStart(ctx: MutationCtx, migrations: WorkflowMigrations, workflowId: WorkflowId): Promise<void> {
  await ctx.runMutation(migrations.component.runs.save, { workflowId, applied: migrations.list.map((m) => m.id), overlay: [] });
}
