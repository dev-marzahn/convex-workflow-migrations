// Migrations, and what a handler run does with a run's record: apply the
// pending migrations in memory, then save the result if replay succeeds or
// pause the run if it doesn't. A pause commits nothing of the handler run but
// the pause.
import { createFunctionHandle, type GenericDataModel, type GenericMutationCtx, makeFunctionReference } from 'convex/server';

import type { ComponentApi } from './component/_generated/component.js';
import { FORMAT } from './component/schema.ts';
import { type History, HistoryView, type OverlayOp, type PauseReason, type RecordedStep, ReplayPause, sameOverlay } from './history.ts';
import type { Replay } from './replay.ts';
import type { WorkflowId } from './vendor/workflow/publicTypes.ts';
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
  /** For a mismatch or a throw: the position in the history (from 0), for `restartFrom`. */
  step?: number;
  /** How many attempts have paused the run, this one included: 1 the first time. */
  attempts: number;
  /** Why the run was paused before this attempt, if it was: `onPause` is called again when the reason or the step changes. */
  previousReason?: PauseReason;
};

/** What the vendored workflow mutation gets from the manager: the migrations component, the workflow's migrations and `onPause`. */
export type WorkflowMigrations = {
  component: MigrationsComponent;
  list: readonly Migration[];
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
  pause?: { step?: number; stepId?: string; appliedCount: number };
  format?: number;
};

/**
 * Builds the history from the journal and the stored overlay and applies the
 * migrations the run hasn't had, in memory. Then `restart` removes every
 * step from that step on (by id), and `restartFrom` from that position on.
 * Throws if `restartFrom` is past the end of the history, or the history
 * changed since the pause it was read from: a release added migrations, or
 * the paused step moved.
 */
export function prepareHistory(journal: readonly RecordedStep[], stored: StoredRecord, migrations: readonly Migration[], args: unknown): Prepared {
  const applied = [...stored.applied];
  const ran: Prepared['ran'] = [];
  if ((stored.format ?? 1) > FORMAT) {
    // Don't read an overlay this version may not understand.
    const detail = `The run's record has format ${stored.format}, from a newer version of @dev-marzahn/convex-workflow-migrations; this one reads format ${FORMAT}. Deploy the newer version again.`;
    return { history: new HistoryView(journal, [], args), applied, ran, blocked: new ReplayPause('migrations', detail) };
  }
  const history = new HistoryView(journal, stored.overlay, args);
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
    } else if (!history.deleted(stored.restart)) {
      const detail = `Can't restart from step ${stored.restart}: a migration removed it. Use restartFrom with a position in the history.`;
      return blocked(new ReplayPause('migration', detail));
    }
    // Otherwise upstream's restart deleted the step's journal entry, and every step from there on with it.
  }
  if (stored.restartFrom !== undefined) {
    const { pause, restartFrom } = stored;
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
    private readonly stored: { applied: readonly string[]; overlay: readonly OverlayOp[]; dirty: boolean; exists: boolean },
    private readonly prepared: Prepared,
    /** Whether the run has journal entries: it isn't new. */
    public readonly hasHistory: boolean,
  ) {}

  /** Loads the run's record and applies pending migrations. Call once per handler run, before replay. */
  public static async load(
    ctx: MutationCtx,
    migrations: WorkflowMigrations,
    run: { _id: string; args: unknown },
    journal: readonly JournalEntry[],
  ): Promise<RunRecord> {
    const workflowId = run._id as WorkflowId;
    const args = run.args;
    const workflow = (await ctx.meta.getFunctionMetadata()).name;
    const row = await ctx.runQuery(migrations.component.runs.load, { workflowId });
    // A run without a record is new, or from before the app adopted this
    // package. A new run's history is empty and in the current shape, so it
    // starts with every migration applied.
    const applied = row ? row.applied : journal.length === 0 ? migrations.list.map((m) => m.id) : [];
    const overlay = row?.overlay ?? [];
    const stored: StoredRecord = { applied, overlay };
    if (row) {
      stored.format = row.format;
      if (row.restart !== undefined) stored.restart = row.restart;
      if (row.restartFrom !== undefined) stored.restartFrom = row.restartFrom;
      if (row.paused) stored.pause = row.paused;
    }
    const prepared = prepareHistory(journal.map(recordedStep), stored, migrations.list, args);
    const dirty =
      !row || row.workflow !== workflow || row.paused !== undefined || row.restart !== undefined || row.restartFrom !== undefined || row.format !== FORMAT;
    return new RunRecord(migrations, workflowId, workflow, { applied, overlay, dirty, exists: row !== null }, prepared, journal.length > 0);
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

  /** After a replay that matched: saves the applied ids and overlay, and ends a pause. Writes nothing if nothing changed. */
  public async save(ctx: MutationCtx): Promise<void> {
    const { applied, history } = this.prepared;
    const overlay = history.overlay();
    const same = this.stored.applied.length === applied.length && this.stored.applied.every((id, i) => applied[i] === id);
    if (!this.stored.dirty && same && sameOverlay(this.stored.overlay, overlay)) return;
    // A missing record already means nothing applied and no overlay.
    if (!this.stored.exists && applied.length === 0 && overlay.length === 0) return;
    await ctx.runMutation(this.migrations.component.runs.save, { workflowId: this.workflowId, workflow: this.workflow, applied, overlay });
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
 * Upstream's `journal.load`, for the vendored workflow mutation. If the
 * workflow is gone and the run has a record, for example a paused child
 * workflow its parent's cleanup deleted, deletes the record and returns
 * undefined: its retries would otherwise fail forever. Throws upstream's
 * error for a workflow without a record.
 */
export async function loadJournal(ctx: MutationCtx, component: WorkflowComponent, migrations: WorkflowMigrations, workflowId: WorkflowId) {
  try {
    return await ctx.runQuery(component.journal.load, { workflowId, shortCircuit: true });
  } catch (error) {
    if (!message(error).includes(`Workflow not found: ${workflowId}`)) throw error;
    const removed = await ctx.runMutation(migrations.component.runs.cleanup, { workflowId });
    if (removed === 0) throw error;
    console.warn(`Workflow ${workflowId} is gone, so its record in the migrations component was deleted.`);
    return undefined;
  }
}
