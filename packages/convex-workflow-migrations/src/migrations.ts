// Migrations, and what a handler run does with a run's record: apply the
// pending migrations in memory before replay, and save the result in the
// handler run's transaction. A run they can't be applied to fails.
import type { GenericDataModel, GenericMutationCtx } from 'convex/server';

import type { ComponentApi } from './component/_generated/component.js';
import { type History, HistoryView, json, type OverlayOp, type RecordedStep } from './history.ts';
import { argsValid, ReplayError } from './replay.ts';
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

/** What the vendored workflow mutation gets from the manager: the migrations component, the workflow's migrations, and its `args` validator. */
export type WorkflowMigrations = { component: MigrationsComponent; list: readonly Migration[]; args?: unknown };

/** The largest overlay a run may store, in bytes: half of Convex's 1 MiB document limit. */
export const OVERLAY_LIMIT = 512 * 1024;

/** A history with the run's pending migrations applied: the ids applied now, and how many edits each migration made. */
export type Prepared = { history: HistoryView; applied: string[]; ran: { id: string; edits: number }[] };

const quoted = (ids: readonly string[]) => (ids.length === 0 ? 'none' : ids.map((id) => `"${id}"`).join(', '));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Builds the history from the journal and the stored overlay, and applies
 * the migrations the run hasn't had, in memory. Throws a `ReplayError` if the
 * applied ids aren't a prefix of the list, a migration throws, or the overlay
 * grows past `OVERLAY_LIMIT`.
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
  const ran: Prepared['ran'] = [];
  for (const m of migrations.slice(applied.length)) {
    try {
      const edits = history.migrateAs(() => {
        if ((m.migrate(history) as unknown) instanceof Promise) throw new Error('it returned a promise; migrations are synchronous');
      });
      ran.push({ id: m.id, edits });
    } catch (error) {
      throw new ReplayError('migration', `Migration "${m.id}" threw: ${message(error)}`);
    }
    applied.push(m.id);
  }
  // The stored overlay fit; only what this handler run added can make it too big to save.
  const bytes = ran.length > 0 ? history.size() : 0;
  if (bytes > OVERLAY_LIMIT) {
    const added = quoted(ran.filter((m) => m.edits > 0).map((m) => m.id));
    throw new ReplayError(
      'overlay',
      `The run's overlay would be ${Math.ceil(bytes / 1024)} KiB, over the ${OVERLAY_LIMIT / 1024} KiB limit. Added to it now: ${added}.`,
    );
  }
  return { history, applied, ran };
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

type MutationCtx = GenericMutationCtx<GenericDataModel>;

/**
 * For the vendored workflow mutation, once per handler run, before replay:
 * loads the run's record and applies its pending migrations, or throws a
 * `ReplayError`. Returns the history, the args as the migrations left them,
 * and `save`, which stores what changed, after a replay that matched.
 */
export async function loadRecord(ctx: MutationCtx, migrations: WorkflowMigrations, run: { _id: string; args: unknown }, journal: readonly JournalEntry[]) {
  const workflowId = run._id as WorkflowId;
  const workflow = (await ctx.meta.getFunctionMetadata()).name;
  const row = await ctx.runQuery(migrations.component.runs.load, { workflowId });
  const valid = (args: unknown) => argsValid({ args: migrations.args }, args, ctx.db);
  const { history, applied } = prepareRun(journal.map(recordedStep), { applied: row?.applied, overlay: row?.overlay ?? [] }, migrations.list, run.args, valid);
  const save = async () => {
    const record = { workflow, applied, overlay: history.overlay() };
    if (!row || json(row) !== json(record)) await ctx.runMutation(migrations.component.runs.save, { workflowId, ...record });
  };
  return { history, args: history.workflowArgs as unknown, save };
}

/** For the vendored workflow mutation, in the transaction that creates a run: its record, with every migration applied. */
export async function recordStart(ctx: MutationCtx, migrations: WorkflowMigrations, workflowId: WorkflowId, workflow: string): Promise<void> {
  await ctx.runMutation(migrations.component.runs.save, { workflowId, workflow, applied: migrations.list.map((m) => m.id), overlay: [] });
}
