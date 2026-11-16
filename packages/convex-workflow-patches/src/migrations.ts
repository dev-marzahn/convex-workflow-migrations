// Migrations, and what a handler run does with a run's record: apply the
// pending migrations in memory, then save the result if replay succeeds or
// pause the run if it doesn't.
import { createFunctionHandle, type GenericDataModel, type GenericMutationCtx, makeFunctionReference } from 'convex/server';

import type { ComponentApi } from './component/_generated/component.js';
import { type History, HistoryView, type OverlayOp, type RecordedStep, type ReplayMismatch, sameOverlay } from './history.ts';
import type { WorkflowId } from './vendor/workflow/publicTypes.ts';
import type { JournalEntry } from './vendor/workflow/types.ts';

/** The installed patches component, `components.workflowPatches`. */
export type PatchesComponent = ComponentApi;

/** A change to a workflow's recorded histories. Create one with `migration(id, migrate)`. */
export type Migration = { readonly id: string; readonly migrate: (h: History) => void };

/**
 * A migration: `migrate` rewrites a run's history into the shape the current
 * handler expects. `id` is permanent: a run stores the ids applied to it.
 * `migrate` must be synchronous and pure, and work on any history, including
 * one that hasn't reached the steps it edits.
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

export type PauseReason = 'mismatch' | 'migration' | 'migrations' | 'error';

/** What `onPause` is told about a run that paused. */
export type PauseInfo = { workflowId: WorkflowId; workflow: string; reason: PauseReason; detail: string };

/** What the vendored workflow mutation gets from the manager. */
export type WorkflowPatches = {
  component: PatchesComponent;
  migrations: readonly Migration[];
  onPause?: (ctx: GenericMutationCtx<GenericDataModel>, info: PauseInfo) => void | Promise<void>;
};

type Blocked = { reason: 'migration' | 'migrations'; detail: string };

export type Prepared = { history: HistoryView; applied: string[]; blocked?: Blocked };

const list = (ids: readonly string[]) => (ids.length === 0 ? 'none' : ids.map((id) => `"${id}"`).join(', '));

/**
 * Builds the history from the journal and the stored overlay and applies the
 * migrations the run hasn't had, in memory. `restart` (from `restartFrom`)
 * then removes every step from that position on.
 */
export function prepareHistory(
  journal: readonly RecordedStep[],
  stored: { applied: readonly string[]; overlay: readonly OverlayOp[]; restart?: number },
  migrations: readonly Migration[],
): Prepared {
  const history = new HistoryView(journal, stored.overlay);
  const ids = migrations.map((m) => m.id);
  const applied = [...stored.applied];
  if (applied.length > ids.length || applied.some((id, i) => ids[i] !== id)) {
    return {
      history,
      applied,
      blocked: {
        reason: 'migrations',
        detail:
          `The run has migrations ${list(applied)} applied, but this code lists ${list(ids)}. ` +
          'Its applied ids must start the list, in order: a migration was removed, renamed or reordered, or this code is older than the code the run ran on.',
      },
    };
  }
  for (const m of migrations.slice(applied.length)) {
    try {
      const returned: unknown = m.migrate(history);
      if (returned instanceof Promise) throw new Error('it returned a promise; migrations are synchronous');
    } catch (error) {
      return {
        history,
        applied,
        blocked: { reason: 'migration', detail: `Migration "${m.id}" threw: ${error instanceof Error ? error.message : String(error)}` },
      };
    }
    applied.push(m.id);
  }
  if (stored.restart !== undefined) {
    try {
      history.truncate(stored.restart);
    } catch (error) {
      return { history, applied, blocked: { reason: 'migration', detail: error instanceof Error ? error.message : String(error) } };
    }
  }
  return { history, applied };
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

/** A run's record during one handler run of the vendored workflow mutation. */
export class RunRecord {
  private constructor(
    private readonly patches: WorkflowPatches,
    private readonly workflowId: WorkflowId,
    private readonly workflow: string,
    private readonly stored: { applied: readonly string[]; overlay: readonly OverlayOp[]; dirty: boolean },
    private readonly prepared: Prepared,
  ) {}

  /** Loads the run's record and applies pending migrations. Call once per handler run, before replay. */
  public static async load(ctx: MutationCtx, patches: WorkflowPatches, workflowId: WorkflowId, journal: readonly JournalEntry[]): Promise<RunRecord> {
    const workflow = (await ctx.meta.getFunctionMetadata()).name;
    const row = await ctx.runQuery(patches.component.runs.load, { workflowId });
    // A run without a record is new, or from before the app adopted this
    // package. A new run's history is empty and in the current shape, so it
    // starts with every migration applied.
    const applied = row ? row.applied : journal.length === 0 ? patches.migrations.map((m) => m.id) : [];
    const overlay = row?.overlay ?? [];
    const prepared = prepareHistory(
      journal.map(recordedStep),
      { applied, overlay, ...(row?.restart === undefined ? {} : { restart: row.restart }) },
      patches.migrations,
    );
    const dirty = !row || row.workflow !== workflow || row.paused !== undefined || row.restart !== undefined;
    return new RunRecord(patches, workflowId, workflow, { applied, overlay, dirty }, prepared);
  }

  /** The history to replay against. */
  public get history(): HistoryView {
    return this.prepared.history;
  }

  /** Why the migrations couldn't be applied, if they couldn't: the run pauses without replaying. */
  public get blocked(): Blocked | undefined {
    return this.prepared.blocked;
  }

  /** After a replay that matched: saves the applied ids and overlay, and ends a pause. Writes nothing if nothing changed. */
  public async save(ctx: MutationCtx): Promise<void> {
    const { applied, history } = this.prepared;
    const overlay = history.overlay();
    const same = this.stored.applied.length === applied.length && this.stored.applied.every((id, i) => applied[i] === id);
    if (!this.stored.dirty && same && sameOverlay(this.stored.overlay, overlay)) return;
    await ctx.runMutation(this.patches.component.runs.save, { workflowId: this.workflowId, workflow: this.workflow, applied, overlay });
  }

  /**
   * Pauses the run: records why, schedules a retry through this workflow
   * mutation's function handle, and calls `onPause` if the run wasn't paused
   * already. Saves nothing else, so the next attempt migrates again, unless
   * replay issued a step a migration inserted: that step has run, so the
   * migrations stand.
   */
  public async pause(ctx: MutationCtx, generationNumber: number, cause: Blocked | ReplayMismatch, console: Logger): Promise<void> {
    const pause =
      'position' in cause ? { reason: 'mismatch' as const, detail: cause.message, step: cause.position } : { reason: cause.reason, detail: cause.detail };
    const handle = await createFunctionHandle(makeFunctionReference<'mutation'>(this.workflow));
    const { history, applied } = this.prepared;
    const { first } = await ctx.runMutation(this.patches.component.runs.pause, {
      workflowId: this.workflowId,
      workflow: this.workflow,
      ...pause,
      handle,
      generationNumber,
      ...(history.lateStepRan ? { record: { applied, overlay: history.overlay() } } : {}),
    });
    console.warn(`Workflow ${this.workflow} (${this.workflowId}) paused (${pause.reason}): ${pause.detail}`);
    if (!first || !this.patches.onPause) return;
    try {
      await this.patches.onPause(ctx, { workflowId: this.workflowId, workflow: this.workflow, reason: pause.reason, detail: pause.detail });
    } catch (error) {
      console.error(`onPause threw for workflow ${this.workflowId}:`, error);
    }
  }
}
