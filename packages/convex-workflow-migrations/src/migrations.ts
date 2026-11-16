// Migrations, and what a handler run does with a run's record: apply the
// pending migrations in memory, then save the result if replay succeeds or
// pause the run if it doesn't. A pause commits nothing of the handler run but
// the pause.
import { createFunctionHandle, type GenericDataModel, type GenericMutationCtx, makeFunctionReference } from 'convex/server';

import type { ComponentApi } from './component/_generated/component.js';
import { FORMAT, isWorkflowNotFound } from './component/schema.ts';
import { type History, HistoryView, type OverlayOp, type PauseReason, type RecordedStep, ReplayPause, sameOverlay } from './history.ts';
import { argsValid, type Replay } from './replay.ts';
import type { WorkflowId } from './vendor/workflow/publicTypes.ts';
import { safeFunctionName } from './vendor/workflow/safeFunctionName.ts';
import type { StepRequest } from './vendor/workflow/step.ts';
import type { JournalEntry, WorkflowComponent } from './vendor/workflow/types.ts';

export type { PauseReason } from './history.ts';

/** The installed migrations component, `components.workflowMigrations`. */
export type MigrationsComponent = ComponentApi;

/** A change to a workflow's recorded histories. Create one with `migration(id, migrate)`. */
export type Migration = { readonly id: string; readonly migrate: (h: History) => void };

/**
 * A migration: `migrate` rewrites a run's history into the shape the current
 * handler expects. `id` is permanent: a run stores the ids applied to it.
 * `migrate` must be synchronous and pure, and work on any history, including
 * one that hasn't reached the steps it edits. It names steps as they were at
 * the release that added it.
 */
export function migration(id: string, migrate: (h: History) => void): Migration {
  if (typeof id !== 'string' || id === '') throw new Error('migration(id, migrate): the id must be a non-empty string.');
  if (typeof migrate !== 'function') throw new Error(`migration("${id}", migrate): migrate must be a function.`);
  return { id, migrate };
}

/** Checks a workflow's migration list when it's defined, so a mistake fails the push. */
export function checkMigrations(migrations: readonly Migration[] | undefined): readonly Migration[] {
  const list = migrations ?? [];
  if (!Array.isArray(list)) throw new Error('define({ migrations }): migrations must be an array of migration(id, migrate).');
  const seen = new Set<string>();
  for (const m of list) {
    if (typeof m?.id !== 'string' || typeof m.migrate !== 'function')
      throw new Error('define({ migrations }): every entry must come from migration(id, migrate).');
    if (seen.has(m.id)) throw new Error(`define({ migrations }): the id "${m.id}" is listed twice. Migration ids are permanent and unique per workflow.`);
    seen.add(m.id);
  }
  return list;
}

/** What `onPause` is told about a run that paused. */
export type PauseInfo = {
  workflowId: WorkflowId;
  /** The workflow's function name. */
  workflow: string;
  reason: PauseReason;
  detail: string;
  /**
   * The position in the history (from 0), for `restartFrom`: for a mismatch,
   * where replay stopped matching; for the throw rule 2, the first step not
   * replayed; for rule 3, the step the handler got last. Unset for rule 5
   * and the other reasons.
   */
  step?: number;
  /**
   * How many attempts the run has had: the first pause, and every scheduled
   * retry and every retry `resumeAll` schedules, each counted when it starts.
   * `resume` and `restartFrom` don't count. 1 the first time.
   */
  attempts: number;
  /**
   * Why the run was paused before, if it was: `onPause` is called again when
   * the code it paused on changed (another reason, step or number of
   * migrations applied, or for a mismatch another detail).
   */
  previousReason?: PauseReason;
};

/** What the vendored workflow mutation gets from the manager: the migrations component, the workflow's migrations, its `args` validator and `onPause`. */
export type WorkflowMigrations = {
  component: MigrationsComponent;
  list: readonly Migration[];
  /** The workflow's `args` validator, for `prepareRun`. */
  args?: unknown;
  onPause?: (ctx: GenericMutationCtx<GenericDataModel>, info: PauseInfo) => void | Promise<void>;
};

/** The largest overlay a run may store, in bytes: half of Convex's 1 MiB document limit, which the row's other fields share. */
export const OVERLAY_LIMIT = 512 * 1024;

export type Prepared = {
  history: HistoryView;
  applied: string[];
  /** The migrations applied now, with how many edits each made. */
  ran: { id: string; edits: number }[];
  /** Why the run can't replay: it pauses without replaying. */
  blocked?: ReplayPause;
};

const list = (ids: readonly string[]) => (ids.length === 0 ? 'none' : ids.map((id) => `"${id}"`).join(', '));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const kib = (bytes: number) => `${Math.ceil(bytes / 1024)} KiB`;

/** What `prepareHistory` reads from a run's record. */
export type StoredRecord = {
  applied: readonly string[];
  overlay: readonly OverlayOp[];
  /** From `restart`: the id of the step to remove the history from. */
  restart?: string;
  /** From `restartFrom`: the position to remove the history from, in the history the pause saw. */
  restartFrom?: number;
  /** The pause `restartFrom`'s position was read from. */
  pause?: { reason: PauseReason; step?: number; stepId?: string; appliedCount: number };
  format?: number;
};

/**
 * `strict`, for `/test`'s helpers: each `updateResult` runs a second time on
 * its own output, and throws if that changes it (`HistoryView`).
 */
export type PrepareOptions = { strict?: boolean };

/**
 * Builds the history from the journal and the stored overlay and applies the
 * migrations the run hasn't had, in memory. Then `restart` removes every
 * step from that step on (by id), and `restartFrom` from that position on.
 * Throws if `restartFrom` is past the end of the history, or the history
 * changed since the pause it was read from: a release added migrations, or
 * the paused step moved.
 */
export function prepareHistory(
  journal: readonly RecordedStep[],
  stored: StoredRecord,
  migrations: readonly Migration[],
  args: unknown,
  options: PrepareOptions = {},
): Prepared {
  const applied = [...stored.applied];
  const ran: Prepared['ran'] = [];
  if ((stored.format ?? 1) > FORMAT) {
    // Don't read an overlay this version may not understand.
    const detail = `The run's record has format ${stored.format}, from a newer version of @dev-marzahn/convex-workflow-migrations; this one reads format ${FORMAT}. Deploy the newer version again.`;
    return { history: new HistoryView(journal, [], args), applied, ran, blocked: new ReplayPause('migrations', detail) };
  }
  const history = new HistoryView(journal, stored.overlay, args, options);
  const ids = migrations.map((m) => m.id);
  const blocked = (pause: ReplayPause): Prepared => ({ history, applied, ran, blocked: pause });
  if (applied.length > ids.length || applied.some((id, i) => ids[i] !== id)) {
    return blocked(
      new ReplayPause(
        'migrations',
        `The run has migrations ${list(applied)} applied, but this code lists ${list(ids)}. ` +
          'Its applied ids must start the list, in order: a migration was removed, renamed or reordered, or this code is older than the code the run ran on.',
      ),
    );
  }
  for (const m of migrations.slice(applied.length)) {
    try {
      const edits = history.migrateAs(() => {
        const returned: unknown = m.migrate(history);
        if (returned instanceof Promise) throw new Error('it returned a promise; migrations are synchronous');
      });
      ran.push({ id: m.id, edits });
    } catch (error) {
      return blocked(new ReplayPause('migration', `Migration "${m.id}" threw: ${message(error)}`));
    }
    applied.push(m.id);
  }
  if (stored.restart !== undefined) {
    // From `restart`, the id of the step it named: where that step is now.
    const position = history.position(stored.restart);
    if (position >= 0) {
      try {
        history.truncate(position);
      } catch (error) {
        return blocked(new ReplayPause('migration', message(error)));
      }
    } else if (!history.deleted(stored.restart) && stored.restartFrom === undefined) {
      // restartFrom, which cuts the history itself, is how a run paused here recovers: it takes precedence.
      const detail = `Can't restart from step ${stored.restart}: a migration removed it. Use restartFrom with a position in the history.`;
      return blocked(new ReplayPause('migration', detail));
    }
    // Otherwise upstream's restart deleted the step's journal entry, and every step from there on with it.
  }
  if (stored.restartFrom !== undefined) {
    const { pause, restartFrom } = stored;
    if (pause?.reason === 'migration' && pause.appliedCount !== applied.length) {
      // It paused partway through its migrations, which apply now: `paused` gave no position in this history.
      throw new Error(
        `restartFrom: the run paused before its migrations had all applied (a migration threw), so it has no position to restart from yet. Call resume: with the fixed code its migrations apply, and it replays, or pauses again at a position paused reports.`,
      );
    }
    if (
      pause &&
      (pause.appliedCount !== applied.length || (pause.step !== undefined && pause.stepId !== undefined && history.idAt(pause.step) !== pause.stepId))
    ) {
      throw new Error(
        `restartFrom: the history changed since the run paused (a release added migrations, or the steps before step ${pause.step ?? 0} changed), so its positions moved. Call resume, then read the position from paused again.`,
      );
    }
    if (restartFrom >= history.length) {
      throw new Error(`restartFrom: the history has ${history.length} steps, so step must be below ${history.length}, got ${restartFrom}.`);
    }
    try {
      history.truncate(restartFrom);
    } catch (error) {
      return blocked(new ReplayPause('migration', message(error)));
    }
  }
  // The stored overlay fit; only what this handler run added can make it too big to save.
  const restarted = stored.restart !== undefined || stored.restartFrom !== undefined;
  if (ran.length > 0 || restarted) {
    const bytes = history.size();
    if (bytes > OVERLAY_LIMIT) {
      const added = [...ran.filter((m) => m.edits > 0).map((m) => `migration "${m.id}"`), ...(restarted ? ['the restart'] : [])];
      const by = added.length === 0 ? '' : ` This handler run added to it: ${added.join(', ')}.`;
      return blocked(new ReplayPause('overlay', `The run's overlay would be ${kib(bytes)}, over the ${kib(OVERLAY_LIMIT)} limit.${by}`));
    }
  }
  return { history, applied, ran };
}

/**
 * `prepareHistory`, for a record whose `applied` may be unknown: a run without
 * a record, from before the app adopted this package, or a child workflow
 * before its first handler run, whose parent's code didn't know its
 * migrations. With journal entries, the run is from before adoption, and
 * every migration applies. With none, its args are all its history has: if
 * they pass the current `args` validator (`valid`), it starts with every
 * migration applied, as a run this code started would; otherwise every
 * migration applies to the empty history, where only `updateWorkflowArgs`
 * does anything, and if the args still don't pass, replay pauses the run with
 * `args`. The vendored workflow mutation and `replayHistory` in /test both
 * call this, so the two make the same choice.
 */
export function prepareRun(
  journal: readonly RecordedStep[],
  stored: Omit<StoredRecord, 'applied'> & { applied?: readonly string[] | undefined },
  migrations: readonly Migration[],
  args: unknown,
  valid: (args: unknown) => boolean,
  options: PrepareOptions = {},
): Prepared {
  const { applied, ...rest } = stored;
  if (applied !== undefined) return prepareHistory(journal, { ...rest, applied }, migrations, args, options);
  if (journal.length > 0) return prepareHistory(journal, { ...rest, applied: [] }, migrations, args, options);
  const current = prepareHistory(journal, { ...rest, applied: migrations.map((m) => m.id) }, migrations, args, options);
  if (current.blocked || valid(current.history.workflowArgs)) return current;
  return prepareHistory(journal, { ...rest, applied: [] }, migrations, args, options);
}

/** The migrations that edited the history in this handler run. */
export function editedNow(prepared: Prepared): string[] {
  return prepared.ran.filter((m) => m.edits > 0).map((m) => m.id);
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
type Logger = { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

/**
 * A run's record during one handler run of the vendored workflow mutation,
 * and what `replayHandler` replays: the history, the migrated args, and the
 * migrations that edited the history now.
 */
export class RunRecord implements Replay {
  private constructor(
    private readonly migrations: WorkflowMigrations,
    private readonly workflowId: WorkflowId,
    private readonly workflow: string,
    private readonly stored: { applied?: readonly string[]; overlay: readonly OverlayOp[]; dirty: boolean; live: boolean },
    private readonly prepared: Prepared,
  ) {}

  /** Loads the run's record and applies pending migrations. Call once per handler run, before replay. */
  public static async load(
    ctx: MutationCtx,
    migrations: WorkflowMigrations,
    run: { _id: string; args: unknown },
    journal: readonly JournalEntry[],
  ): Promise<RunRecord> {
    const workflowId = run._id as WorkflowId;
    const workflow = (await ctx.meta.getFunctionMetadata()).name;
    const row = await ctx.runQuery(migrations.component.runs.load, { workflowId });
    const overlay = row?.overlay ?? [];
    const stored: Parameters<typeof prepareRun>[1] = { applied: row?.applied, overlay };
    if (row) {
      stored.format = row.format;
      if (row.restart !== undefined) stored.restart = row.restart;
      if (row.paused) {
        stored.pause = row.paused;
        if (row.paused.restartFrom !== undefined) stored.restartFrom = row.paused.restartFrom;
      }
    }
    const definition = { args: migrations.args };
    const prepared = prepareRun(journal.map(recordedStep), stored, migrations.list, run.args, (args) => argsValid(definition, args, ctx.db));
    const dirty =
      !row || row.applied === undefined || row.workflow !== workflow || row.paused !== undefined || row.restart !== undefined || row.format !== FORMAT;
    return new RunRecord(
      migrations,
      workflowId,
      workflow,
      { ...(row?.applied ? { applied: row.applied } : {}), overlay, dirty, live: row?.live ?? false },
      prepared,
    );
  }

  /** The history to replay against. */
  public get history(): HistoryView {
    return this.prepared.history;
  }

  /** The workflow's args, as the migrations left them, for the handler. */
  public get args(): any {
    return this.prepared.history.workflowArgs;
  }

  /** Why the run can't replay, if it can't: it pauses without replaying. */
  public get blocked(): ReplayPause | undefined {
    return this.prepared.blocked;
  }

  /** The migrations that edited the history in this handler run. */
  public get editedNow(): string[] {
    return editedNow(this.prepared);
  }

  /**
   * After a replay that matched: saves the applied ids and overlay, whether
   * this handler run completed the run (`done`), and ends a pause. Writes
   * nothing if nothing changed.
   */
  public async save(ctx: MutationCtx, done: boolean): Promise<void> {
    const { applied, history } = this.prepared;
    const overlay = history.overlay();
    const stored = this.stored.applied;
    const same = stored !== undefined && stored.length === applied.length && stored.every((id, i) => applied[i] === id);
    if (!this.stored.dirty && same && sameOverlay(this.stored.overlay, overlay) && this.stored.live !== done) return;
    await ctx.runMutation(this.migrations.component.runs.save, { workflowId: this.workflowId, workflow: this.workflow, applied, overlay, done });
  }

  /**
   * Gives the child workflows that steps this handler run started records,
   * linked to this run, in its transaction. The vendored executor calls it
   * with the steps it just started.
   */
  public async recordChildren(ctx: MutationCtx, messages: readonly StepRequest[], entries: readonly JournalEntry[]): Promise<void> {
    const children = entries.flatMap(({ step }, i) => {
      const target = messages[i]?.target;
      return step.kind === 'workflow' && step.workflowId && target?.kind === 'workflow'
        ? [{ workflowId: step.workflowId, workflow: safeFunctionName(target.function) }]
        : [];
    });
    if (children.length > 0) await ctx.runMutation(this.migrations.component.runs.children, { parent: this.workflowId, children });
  }

  /**
   * Pauses the run: records why, schedules a retry through this workflow
   * mutation's function handle, and calls `onPause` if the run wasn't paused
   * already, or was for another reason or at another step. Saves nothing
   * else, so the next attempt migrates again. Logs a warning on every attempt
   * that pauses.
   */
  public async pause(ctx: MutationCtx, generationNumber: number, cause: ReplayPause, console: Logger): Promise<void> {
    const pause = { reason: cause.reason, detail: cause.detail, ...(cause.position === undefined ? {} : { step: cause.position }) };
    const stepId = cause.position === undefined ? undefined : this.prepared.history.idAt(cause.position);
    const handle = await createFunctionHandle(makeFunctionReference<'mutation'>(this.workflow));
    const { notify, attempts, previousReason } = await ctx.runMutation(this.migrations.component.runs.pause, {
      workflowId: this.workflowId,
      workflow: this.workflow,
      ...pause,
      ...(stepId === undefined ? {} : { stepId }),
      appliedCount: this.prepared.applied.length,
      handle,
      generationNumber,
    });
    console.warn(`Workflow ${this.workflow} (${this.workflowId}) paused (${pause.reason}): ${pause.detail}`);
    if (!notify || !this.migrations.onPause) return;
    try {
      const info: PauseInfo = { workflowId: this.workflowId, workflow: this.workflow, ...pause, attempts, ...(previousReason ? { previousReason } : {}) };
      await this.migrations.onPause(ctx, info);
    } catch (error) {
      console.error(`onPause threw for workflow ${this.workflowId}:`, error);
    }
  }
}

/**
 * For the vendored workflow mutation, in the transaction that creates a run:
 * the run's record, with every migration the workflow lists applied, since
 * its history starts in the current shape.
 */
export async function recordStart(ctx: MutationCtx, migrations: WorkflowMigrations, workflowId: WorkflowId, workflow: string): Promise<void> {
  await ctx.runMutation(migrations.component.runs.start, { workflowId, workflow, applied: migrations.list.map((m) => m.id) });
}

/**
 * Upstream's `journal.load`, for the vendored workflow mutation. If the
 * workflow is gone and the run has a record or a pause, for example a paused
 * child workflow its parent's cleanup deleted, deletes them, and its
 * children's records, and returns undefined: its retries would otherwise fail
 * forever. Throws upstream's error for a workflow this package never saw.
 */
export async function loadJournal(ctx: MutationCtx, component: WorkflowComponent, migrations: WorkflowMigrations, workflowId: WorkflowId) {
  try {
    return await ctx.runQuery(component.journal.load, { workflowId, shortCircuit: true });
  } catch (error) {
    if (!isWorkflowNotFound(error, workflowId)) throw error;
    const journal = await createFunctionHandle(component.journal.load);
    const removed = await ctx.runMutation(migrations.component.runs.cleanup, { workflowId, journal });
    if (removed === 0) throw error;
    console.warn(`Workflow ${workflowId} is gone, so its record in the migrations component was deleted.`);
    return undefined;
  }
}

/**
 * For the vendored workflow mutation, called for a run that has finished,
 * which upstream's component finished past the manager, for example at a
 * retry of a paused child canceled with its parent: its record stops being
 * live, so the CLI doesn't list it as running.
 */
export async function recordFinished(ctx: MutationCtx, migrations: WorkflowMigrations, workflowId: WorkflowId): Promise<void> {
  await ctx.runMutation(migrations.component.runs.finished, { workflowId });
}
