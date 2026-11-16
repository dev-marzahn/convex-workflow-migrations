import { WorkflowManager as UpstreamWorkflowManager, type WorkflowComponent, type WorkflowDefinition, type WorkflowId } from '@convex-dev/workflow';
import type { WorkpoolOptions } from '@convex-dev/workpool';
import type { GenericActionCtx, GenericDataModel, GenericMutationCtx, GenericQueryCtx, RegisteredMutation } from 'convex/server';
import type { Infer, PropertyValidators, Validator } from 'convex/values';

import { FORMAT, type vPausedPage, type vPausedRun } from './component/schema.ts';
import { HistoryView, type OverlayOp, type StepRef } from './history.ts';
import { checkMigrations, type Migration, type MigrationsComponent, type PauseInfo, recordedStep, type WorkflowMigrations } from './migrations.ts';
import type { InferFromOptionalValidator, JournalEntry, WorkflowHandler, WorkflowMutationResult } from './vendor/workflow/types.ts';
import { type WorkflowArgs, workflowMutation } from './vendor/workflow/workflowMutation.ts';

// Upstream's exports that don't replay a handler, unchanged. Left out on
// purpose, because they bypass the migrations or the run's record:
// `defineWorkflow` (use `workflow.define`), and the standalone `cancel`,
// `restart` and `cleanup` (use the manager's). tests/exports.test.ts keeps
// this list complete.
export {
  createEvent,
  defineEvent,
  getStatus,
  list,
  listByName,
  listSteps,
  sendEvent,
  start,
  vEventId,
  vResultValidator,
  vWorkflowId,
  vWorkflowStep,
} from '@convex-dev/workflow';
export type {
  CallbackOptions,
  EventId,
  RunOptions,
  RunResult,
  StepDefaults,
  WorkflowComponent,
  WorkflowDefinition,
  WorkflowId,
  WorkflowMutationResult,
  WorkflowStatus,
  WorkflowStep,
} from '@convex-dev/workflow';
export { migration } from './migrations.ts';
export type { Migration, MigrationsComponent, PauseInfo, PauseReason } from './migrations.ts';
export type { History, HistoryStep, InsertOptions, OverlayOp, RecordedHistory, RecordedStep, StepArgs, StepRef, StepResult, StepSelector } from './history.ts';
export type { Redactable } from './redact.ts';
export type { WorkflowHandler } from './vendor/workflow/types.ts';
export type { WorkflowCtx } from './vendor/workflow/workflowContext.ts';
export type { WorkflowArgs } from './vendor/workflow/workflowMutation.ts';

type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, 'runQuery'>;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, 'runQuery' | 'runMutation'>;
type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, 'runQuery' | 'runMutation' | 'runAction'>;

type WorkflowMutation<ArgsValidator extends PropertyValidators, ReturnsValidator extends Validator<unknown, 'required', string> | void> = RegisteredMutation<
  'internal',
  WorkflowArgs<ArgsValidator>,
  WorkflowMutationResult<InferFromOptionalValidator<ReturnsValidator>>
>;

type Definition<ArgsValidator extends PropertyValidators, ReturnsValidator extends Validator<unknown, 'required', string> | void> = WorkflowDefinition<
  ArgsValidator,
  ReturnsValidator
> & {
  /** The workflow's migrations, oldest first. Append only: never remove, rename or reorder one. */
  migrations?: readonly Migration[];
};

/**
 * A paused run, as `WorkflowManager.paused` lists it: its workflow's function
 * name; why it paused (`detail` is always set, and for a mismatch has the
 * position, the call the code made and the step the history has there);
 * `step`, for a mismatch or a throw, the position in the history (from 0) for
 * `restartFrom`; when it first paused, how many attempts have paused it
 * since, and when the next one is; and `lastError`, why the last attempt's
 * workflow mutation threw, if it did.
 */
export type PausedRun = Omit<Infer<typeof vPausedRun>, 'workflowId'> & { workflowId: WorkflowId };

/** A page of paused runs. Pass `continueCursor` as `cursor` for the next one, until `isDone`. */
export type PausedPage = Omit<Infer<typeof vPausedPage>, 'page'> & { page: PausedRun[] };

export type WorkflowManagerOptions = {
  /** The migrations component, `components.workflowMigrations`. */
  migrationsComponent: MigrationsComponent;
  /**
   * Called when a run pauses, in the transaction that pauses it, and again
   * when a retry pauses it for another reason or at another step. `ctx` is
   * the workflow mutation's: cast it to your app's `MutationCtx` to use your
   * tables. An error it throws is logged, and what it wrote before is kept;
   * the run stays paused.
   */
  onPause?(ctx: GenericMutationCtx<GenericDataModel>, info: PauseInfo): void | Promise<void>;
  workpoolOptions?: WorkpoolOptions;
};

/**
 * `@convex-dev/workflow`'s `WorkflowManager`, for workflows with migrations.
 * A run whose history doesn't match the code pauses and is retried, instead
 * of failing.
 *
 * ```ts
 * export const workflow = new WorkflowManager(components.workflow, {
 *   migrationsComponent: components.workflowMigrations,
 * });
 * ```
 */
export class WorkflowManager extends UpstreamWorkflowManager {
  private readonly migrationsComponent: MigrationsComponent;
  private readonly onPause: WorkflowMigrations['onPause'];

  public constructor(component: WorkflowComponent, options: WorkflowManagerOptions) {
    super(component, options.workpoolOptions ? { workpoolOptions: options.workpoolOptions } : undefined);
    this.migrationsComponent = options.migrationsComponent;
    this.onPause = options.onPause?.bind(options);
  }

  /**
   * Upstream's `define`, with `migrations`: the changes this workflow's
   * recorded histories need to replay on the current handler, oldest first.
   * Throws if two have the same id.
   */
  public override define<ArgsValidator extends PropertyValidators, ReturnsValidator extends Validator<unknown, 'required', string> | void>(
    workflow: Definition<ArgsValidator, ReturnsValidator> & { handler: WorkflowHandler<ArgsValidator, ReturnsValidator> },
  ): WorkflowMutation<ArgsValidator, ReturnsValidator>;
  public override define<ArgsValidator extends PropertyValidators, ReturnsValidator extends Validator<unknown, 'required', string> | void>(
    workflow: Definition<ArgsValidator, ReturnsValidator>,
  ): {
    handler(fn: WorkflowHandler<ArgsValidator, ReturnsValidator>): WorkflowMutation<ArgsValidator, ReturnsValidator>;
  };
  public override define<ArgsValidator extends PropertyValidators, ReturnsValidator extends Validator<unknown, 'required', string> | void>(
    workflow: Definition<ArgsValidator, ReturnsValidator> & { handler?: WorkflowHandler<ArgsValidator, ReturnsValidator> },
  ): unknown {
    const { migrations, handler, ...definition } = workflow;
    const setup: WorkflowMigrations = { component: this.migrationsComponent, list: checkMigrations(migrations), onPause: this.onPause };
    const build = (fn: WorkflowHandler<ArgsValidator, ReturnsValidator>) =>
      workflowMutation(this.component, setup, { ...definition, handler: fn }, this.options?.workpoolOptions);
    return handler ? build(handler) : { handler: build };
  }

  /**
   * A page of paused runs (of one workflow, by its function name, like
   * `pipeline:run`), the one that paused first first. `numItems` defaults
   * to 100.
   */
  public async paused(ctx: QueryCtx, opts?: { workflow?: string; cursor?: string | null; numItems?: number }): Promise<PausedPage> {
    const paginationOpts = { numItems: opts?.numItems ?? 100, cursor: opts?.cursor ?? null };
    const result = await ctx.runQuery(this.migrationsComponent.runs.list, {
      paginationOpts,
      ...(opts?.workflow === undefined ? {} : { workflow: opts.workflow }),
    });
    // The component stores upstream's workflow ids as strings.
    return { ...result, page: result.page.map((run) => ({ ...run, workflowId: run.workflowId as WorkflowId })) };
  }

  /**
   * Retries a paused run now, for example after deploying a fix. Returns
   * whether it got past its pause; if not, it stays paused with the new
   * reason. Throws if the run isn't paused, or `fail` is failing it, and an
   * error from the workflow mutation is thrown too. One transaction.
   */
  public async resume(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    return !(await ctx.runMutation(this.migrationsComponent.runs.retry, { workflowId, now: true }));
  }

  /**
   * Schedules one retry of every paused run, or of one workflow's (by its
   * function name), starting now, 100 ms apart. Each retry is its own
   * transaction, and a retry that throws counts as another failed attempt,
   * as a scheduled one does. Call it after deploying a fix, for example from
   * an internal mutation run after the deploy.
   */
  public async resumeAll(ctx: MutationCtx | ActionCtx, opts?: { workflow?: string }): Promise<void> {
    await ctx.runMutation(this.migrationsComponent.runs.resumeAll, opts?.workflow === undefined ? {} : { workflow: opts.workflow });
  }

  /**
   * Removes every step of a paused run's history from position `step` on
   * (the `step` that `paused` reports), and retries: those steps run again.
   * Throws, changing nothing, if the run isn't paused, `fail` is failing it,
   * `step` is past the end of the history, the history changed since the
   * pause (a release added migrations, or the paused step moved: `resume`,
   * then read `paused` again), or the run would still pause. One transaction.
   */
  public async restartFrom(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId, step: number): Promise<void> {
    if (!Number.isInteger(step) || step < 0) throw new Error(`restartFrom: step must be a position in the history, got ${step}.`);
    await ctx.runMutation(this.migrationsComponent.runs.retry, { workflowId, restartFrom: step });
  }

  /**
   * Completes a paused run as failed, with why it paused as the error, then
   * ends the pause. `onComplete` runs. Throws if the run isn't paused. It
   * first claims the run, so no retry resumes it meanwhile. From an action,
   * those are three transactions; if the last ones don't happen, the claim
   * runs out after a minute, and the retry then ends the pause if the run
   * was completed, or retries it as usual if it wasn't.
   */
  public async fail(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<void> {
    const { generationNumber, reason, detail } = await ctx.runMutation(this.migrationsComponent.runs.claim, { workflowId });
    await ctx.runMutation(this.component.workflow.complete, {
      workflowId,
      generationNumber,
      runResult: { kind: 'failed', error: `Paused (${reason}): ${detail}` },
    });
    await ctx.runMutation(this.migrationsComponent.runs.unpause, { workflowId });
  }

  /**
   * Upstream's `cancel`. A paused run's pause ends too. From an action,
   * those are two transactions.
   */
  public override async cancel(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<void> {
    await super.cancel(ctx, workflowId);
    await ctx.runMutation(this.migrationsComponent.runs.unpause, { workflowId });
  }

  /**
   * Upstream's `restart` of a finished run, with `from` in the run's history
   * as its last handler run left it, without migrations a newer release
   * added: a position (from 0), a step name or a step reference, which means
   * its last occurrence, as upstream's does. Steps from there on run again,
   * including steps migrations inserted, and the steps before it replay as
   * they did. Like `restartFrom`, it stores the step on the run's record,
   * and the restarted run's first handler run applies any pending
   * migrations, then removes the history from that step on. Upstream's
   * journal keeps every entry, except for a run with an entry still marked
   * running, as a canceled run's wait is: upstream's restart deletes the
   * entries from that step on, or from the running one if it comes first,
   * since the run would wait on it forever otherwise. Throws if the run is
   * still running (for a paused one, use `restartFrom`), or if `from` is past
   * the end of the history. From an action, the record is updated in a
   * transaction before the restart.
   */
  public override async restart(
    ctx: MutationCtx | ActionCtx,
    workflowId: WorkflowId,
    options?: { from?: number | string | StepRef; startAsync?: boolean },
  ): Promise<void> {
    const startAsync = options?.startAsync === undefined ? {} : { startAsync: options.startAsync };
    const { workflow, journalEntries, ok } = await ctx.runQuery(this.component.journal.load, { workflowId });
    const record = await ctx.runQuery(this.migrationsComponent.runs.load, { workflowId });
    if (!workflow.runResult) {
      throw new Error(`restart: workflow ${workflowId} is still running.${record?.paused ? ' It is paused: use restartFrom.' : ''}`);
    }
    const entries = journalEntries as JournalEntry[];
    const running = entries.some((entry) => entry.step.inProgress);
    const point = options?.from === undefined && !running ? {} : this.restartPoint(workflowId, options?.from, { entries, ok, args: workflow.args }, record);
    if (point.deleteFrom !== undefined) {
      // Upstream deletes the child workflows of the entries it deletes, and theirs.
      const children = entries.flatMap((entry) =>
        entry.stepNumber >= point.deleteFrom! && entry.step.kind === 'workflow' && entry.step.workflowId ? [entry.step.workflowId] : [],
      );
      if (children.length > 0) {
        await ctx.runMutation(this.migrationsComponent.runs.cleanupMany, { workflowIds: [...children, ...(await this.descendants(ctx, children))] });
      }
    }
    // Without a step, this clears a step a restart from an action stored but didn't get to.
    if (record || point.id !== undefined) {
      await ctx.runMutation(this.migrationsComponent.runs.restart, {
        workflowId,
        workflow: record?.workflow ?? workflow.name ?? '',
        ...(point.id === undefined ? {} : { from: point.id }),
      });
    }
    await super.restart(ctx, workflowId, { ...startAsync, ...(point.deleteFrom === undefined ? {} : { from: point.deleteFrom }) });
  }

  /**
   * Deletes a finished workflow, its journal and its record, and the
   * records of the child workflows upstream deletes with it, and of theirs.
   * For a workflow that's already gone, it deletes the record. From a
   * mutation, all in its transaction; from an action, the records go in a
   * later one.
   */
  public override async cleanup(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    let finished: boolean;
    try {
      finished = (await ctx.runQuery(this.component.workflow.getStatus, { workflowId })).workflow.runResult !== undefined;
    } catch (error) {
      if (!message(error).includes(`Workflow not found: ${workflowId}`)) throw error;
      // Gone already, for example with its parent: only the record is left.
      await ctx.runMutation(this.migrationsComponent.runs.cleanupMany, { workflowIds: [workflowId] });
      return false;
    }
    // Read before upstream deletes the journal that names them.
    const children = finished ? await this.descendants(ctx, [workflowId]) : [];
    const removed = await super.cleanup(ctx, workflowId);
    if (removed) await ctx.runMutation(this.migrationsComponent.runs.cleanupMany, { workflowIds: [workflowId, ...children] });
    return removed;
  }

  /** The child workflows these workflows started, and theirs, from their journals: what upstream's cleanup deletes with them. */
  private async descendants(ctx: MutationCtx | ActionCtx, workflowIds: readonly string[]): Promise<string[]> {
    const seen = new Set(workflowIds);
    const found: string[] = [];
    for (let i = 0; i < found.length + workflowIds.length; i++) {
      const parent = i < workflowIds.length ? workflowIds[i]! : found[i - workflowIds.length]!;
      let cursor: string | null = null;
      for (;;) {
        const steps: { page: { kind: string; nestedWorkflowId?: string }[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(
          this.component.workflow.listSteps,
          { workflowId: parent, order: 'asc', paginationOpts: { numItems: 1000, cursor } },
        );
        for (const step of steps.page) {
          if (step.kind !== 'workflow' || !step.nestedWorkflowId || seen.has(step.nestedWorkflowId)) continue;
          seen.add(step.nestedWorkflowId);
          found.push(step.nestedWorkflowId);
        }
        if (steps.isDone) break;
        cursor = steps.continueCursor;
      }
    }
    return found;
  }

  /**
   * Where `restart` restarts from: the id of the step, stored on the record,
   * and, for a run with an entry still marked running, the step number from
   * which upstream deletes the journal. Throws if it can't restart from there.
   */
  private restartPoint(
    workflowId: WorkflowId,
    from: number | string | StepRef | undefined,
    run: { entries: JournalEntry[]; ok: boolean; args: unknown },
    record: { overlay: OverlayOp[]; format: number } | null,
  ): { id?: string; deleteFrom?: number } {
    if (!run.ok) throw new Error(`restart: workflow ${workflowId}'s journal is too big to load whole, so its history can't be read.`);
    if (record && record.format > FORMAT) {
      throw new Error(`restart: workflow ${workflowId}'s record has format ${record.format}, from a newer version of this package; this one reads ${FORMAT}.`);
    }
    const history = new HistoryView(run.entries.map(recordedStep), record?.overlay ?? [], run.args);
    let position: number | undefined;
    if (typeof from === 'number') {
      if (!Number.isInteger(from) || from < 0) throw new Error(`restart: from must be a position in the history, got ${from}.`);
      if (from >= history.length)
        throw new Error(`restart: workflow ${workflowId}'s history has ${history.length} steps, so from must be below ${history.length}, got ${from}.`);
      position = from;
    } else if (from !== undefined) {
      position = history.lastPosition(from);
      if (position < 0)
        throw new Error(`restart: workflow ${workflowId}'s history has no step ${typeof from === 'string' ? `"${from}"` : 'that matches from'}.`);
    }
    const id = position === undefined ? undefined : history.idAt(position);
    const running = run.entries.filter((entry) => entry.step.inProgress).map((entry) => entry.stepNumber);
    if (running.length === 0) {
      // Throws now, rather than in the restarted run, if the history can't be cut there.
      if (position !== undefined) history.truncate(position);
      return id === undefined ? {} : { id };
    }
    const stepNumbers = new Map(run.entries.map((entry) => [entry._id, entry.stepNumber]));
    const recorded = position === undefined ? undefined : history.recordedAt(position);
    const deleteFrom = Math.min(...running, ...(recorded === undefined ? [] : [stepNumbers.get(recorded)!]));
    return { ...(id === undefined ? {} : { id }), deleteFrom };
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
