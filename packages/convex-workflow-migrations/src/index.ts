import {
  type CallbackOptions,
  start as startWorkflow,
  WorkflowManager as UpstreamWorkflowManager,
  type WorkflowComponent,
  type WorkflowDefinition,
  type WorkflowId,
} from '@convex-dev/workflow';
import type { WorkpoolOptions } from '@convex-dev/workpool';
import {
  createFunctionHandle,
  type FunctionArgs,
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type RegisteredMutation,
} from 'convex/server';
import type { Infer, PropertyValidators, Validator } from 'convex/values';

import { FORGET_BATCH, FORMAT, type vPausedPage, type vPausedRun } from './component/schema.ts';
import { HistoryView, type OverlayOp, type StepRef } from './history.ts';
import { checkMigrations, type Migration, type MigrationsComponent, type PauseInfo, recordedStep, type WorkflowMigrations } from './migrations.ts';
import { REPLAY, type ReplayTarget } from './replay.ts';
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
/** A mutation's ctx, and not an action's: `db` tells them apart. */
type MutationOnlyCtx = Pick<GenericMutationCtx<GenericDataModel>, 'runQuery' | 'runMutation' | 'db'>;

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
 * `step`, for a mismatch and the throw rules 2 and 3, the position in the
 * history (from 0) for `restartFrom`; when it first paused, how many attempts
 * it has had, and when the next retry is; and `lastError`, why the last
 * attempt didn't complete, if it didn't: its workflow mutation threw, or never
 * finished.
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
   * the run stays paused. Required: a paused run isn't failed, so nothing
   * else reports it. Pass `null` to opt out.
   */
  onPause: ((ctx: GenericMutationCtx<GenericDataModel>, info: PauseInfo) => void | Promise<void>) | null;
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
 *   onPause: async (ctx, info) => console.error(`Workflow ${info.workflowId} paused (${info.reason}): ${info.detail}`),
 * });
 * ```
 */
export class WorkflowManager extends UpstreamWorkflowManager {
  private readonly migrationsComponent: MigrationsComponent;
  private readonly onPause: WorkflowMigrations['onPause'];

  public constructor(component: WorkflowComponent, options: WorkflowManagerOptions) {
    super(component, options.workpoolOptions ? { workpoolOptions: options.workpoolOptions } : undefined);
    if (options.onPause === undefined) {
      throw new Error('new WorkflowManager: pass onPause, which is told when a run pauses instead of failing, or onPause: null to opt out.');
    }
    this.migrationsComponent = options.migrationsComponent;
    this.onPause = options.onPause ? options.onPause.bind(options) : undefined;
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
    const setup: WorkflowMigrations = {
      component: this.migrationsComponent,
      list: checkMigrations(migrations),
      args: definition.args,
      ...(this.onPause ? { onPause: this.onPause } : {}),
    };
    const build = (fn: WorkflowHandler<ArgsValidator, ReturnsValidator>) => {
      const registered = { ...definition, handler: fn };
      const mutation = workflowMutation(this.component, setup, registered, this.options?.workpoolOptions);
      // For expectReplays() and migrate() in /test, which replay a history without Convex.
      const target: ReplayTarget = {
        definition: registered,
        migrations: setup.list,
        workpoolOptions: { ...this.options?.workpoolOptions, ...definition.workpoolOptions },
      };
      Object.defineProperty(mutation, REPLAY, { value: target });
      return mutation;
    };
    return handler ? build(handler) : { handler: build };
  }

  /**
   * Upstream's `start`, always through the workflow mutation, with or without
   * `startAsync`: it writes the run's record, with the migrations this code
   * lists, in the transaction that creates the run, so a run that first runs
   * on a later release migrates from them. The workflow mutation checks the
   * args against its validator, with `startAsync` too.
   */
  public override async start<Context = unknown, F extends FunctionReference<'mutation', 'internal'> = FunctionReference<'mutation', 'internal'>>(
    ctx: MutationCtx | ActionCtx,
    workflow: F,
    args: FunctionArgs<F>['args'],
    options?: CallbackOptions<Context> & { startAsync?: boolean },
  ): Promise<WorkflowId> {
    return await startWorkflow(ctx, workflow, args, options);
  }

  /**
   * A page of paused runs (of one workflow, by its function name, like
   * `pipeline:run`), the one that paused first first. `numItems` defaults
   * to 100. It reads only the runs' pauses, not their records.
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
   * reason, and its attempts and next retry stay as they were. Throws if the
   * run isn't paused, and an error from the workflow mutation is thrown too.
   * One transaction, from an action too.
   */
  public async resume(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    return !(await ctx.runMutation(this.migrationsComponent.runs.retry, { workflowId, now: true }));
  }

  /**
   * Schedules one retry of every run paused now, or of one workflow's (by
   * its function name), 100 ms apart. Runs that pause after the call aren't
   * included. Each retry is a scheduled retry that's due now: it counts as an
   * attempt, and an attempt whose workflow mutation throws or never finishes
   * records that as `lastError`. Call it after deploying a fix, for example
   * from an internal mutation run after the deploy.
   */
  public async resumeAll(ctx: MutationCtx | ActionCtx, opts?: { workflow?: string }): Promise<void> {
    await ctx.runMutation(this.migrationsComponent.runs.resumeAll, opts?.workflow === undefined ? {} : { workflow: opts.workflow });
  }

  /**
   * Removes every step of a paused run's history from position `step` on
   * (the `step` that `paused` reports), and retries: those steps run again.
   * Throws, changing nothing, if the run isn't paused, `step` is past the end
   * of the history, the history changed since the pause (a release added
   * migrations, or the step at the paused position changed: `resume`, then
   * read `paused` again), or the run would still pause. One transaction, from
   * an action too.
   */
  public async restartFrom(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId, step: number): Promise<void> {
    if (!Number.isInteger(step) || step < 0) throw new Error(`restartFrom: step must be a position in the history, got ${step}.`);
    await ctx.runMutation(this.migrationsComponent.runs.retry, { workflowId, restartFrom: step });
  }

  /**
   * Completes a paused run as failed, with why it paused as the error, and
   * ends the pause, in the caller's transaction: so it takes a mutation's
   * ctx, not an action's. `onComplete` runs. Throws, changing nothing, if
   * the run isn't paused.
   */
  public async fail(ctx: MutationOnlyCtx, workflowId: WorkflowId): Promise<void> {
    if (!('db' in ctx)) throw new Error("fail takes a mutation's ctx: it fails the run and ends its pause in one transaction.");
    const ended = await ctx.runMutation(this.migrationsComponent.runs.end, { workflowId, paused: true });
    const { generationNumber, reason, detail } = ended!;
    await ctx.runMutation(this.component.workflow.complete, {
      workflowId,
      generationNumber,
      runResult: { kind: 'failed', error: `Paused (${reason}): ${detail}` },
    });
  }

  /**
   * Upstream's `cancel`. A paused run's pause ends too, and its record says
   * it finished. From an action, those are two transactions.
   */
  public override async cancel(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<void> {
    await super.cancel(ctx, workflowId);
    await ctx.runMutation(this.migrationsComponent.runs.end, { workflowId });
  }

  /**
   * Upstream's `restart` of a finished run, with `from` in the run's history
   * as its last handler run left it, without migrations a newer release
   * added: a position (from 0), a step name or a step reference, which means
   * its last occurrence, as upstream's does. Steps from there on run again,
   * including stand-ins migrations inserted, and the steps before it replay
   * as they did. See the README's "How it works". Throws if the run is still
   * running (for a paused one, use `restartFrom`), if `from` is past the end
   * of the history or names no step, if the journal is too big to load
   * whole, or if a newer version of this package wrote the run's record.
   * From an action, the records are updated in transactions before the
   * restart.
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
      // Upstream deletes the child workflows of the entries it deletes, and theirs: their records go too.
      const children = entries.flatMap((entry) =>
        entry.stepNumber >= point.deleteFrom! && entry.step.kind === 'workflow' && entry.step.workflowId ? [entry.step.workflowId] : [],
      );
      await this.forget(ctx, children);
    }
    // Without a step, this clears a step a restart from an action stored but didn't get to.
    await ctx.runMutation(this.migrationsComponent.runs.restart, {
      workflowId,
      workflow: record?.workflow ?? workflow.name ?? '',
      ...(point.id === undefined ? {} : { from: point.id }),
    });
    await super.restart(ctx, workflowId, { ...startAsync, ...(point.deleteFrom === undefined ? {} : { from: point.deleteFrom }) });
  }

  /**
   * Deletes a finished workflow, its journal and its record, and the
   * records of the child workflows upstream deletes with it, and of theirs.
   * For a workflow that's already gone, it deletes the record. The run's own
   * record goes in the caller's transaction, from a mutation; the others in
   * scheduled batches (see the README's "Limits").
   */
  public override async cleanup(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    let finished: boolean;
    try {
      finished = (await ctx.runQuery(this.component.workflow.getStatus, { workflowId })).workflow.runResult !== undefined;
    } catch (error) {
      if (!message(error).includes(`Workflow not found: ${workflowId}`)) throw error;
      // Gone already, for example with its parent: only the records are left.
      await ctx.runMutation(this.migrationsComponent.runs.forget, { workflowIds: [workflowId] });
      return false;
    }
    // Before upstream deletes the journal, which names the children of a run from before adoption.
    if (finished) await this.forget(ctx, [workflowId]);
    return await super.cleanup(ctx, workflowId);
  }

  /** Deletes the records of these runs and of their descendants, through `runs.forget`, which can read upstream's journals. */
  private async forget(ctx: MutationCtx | ActionCtx, workflowIds: readonly string[]): Promise<void> {
    if (workflowIds.length === 0) return;
    const journal = await createFunctionHandle(this.component.journal.load);
    for (let i = 0; i < workflowIds.length; i += FORGET_BATCH) {
      await ctx.runMutation(this.migrationsComponent.runs.forget, { workflowIds: workflowIds.slice(i, i + FORGET_BATCH), journal });
    }
  }

  /**
   * Where `restart` restarts from: the id of the step, stored on the record,
   * and the step number from which upstream deletes the journal: that of the
   * first journal entry at or after the step, or of an entry still marked
   * running, as a canceled run's wait is, if it comes first, since the run
   * would wait on it forever otherwise. Throws if it can't restart from there.
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
    // The id stays on the record for the stand-ins from there on, which aren't in the journal.
    const id = position === undefined ? undefined : history.idAt(position);
    const stepNumbers = new Map(run.entries.map((entry) => [entry._id, entry.stepNumber]));
    const recorded = position === undefined ? undefined : history.recordedAt(position);
    const cuts = [
      ...run.entries.filter((entry) => entry.step.inProgress).map((entry) => entry.stepNumber),
      ...(recorded === undefined ? [] : [stepNumbers.get(recorded)!]),
    ];
    return { ...(id === undefined ? {} : { id }), ...(cuts.length === 0 ? {} : { deleteFrom: Math.min(...cuts) }) };
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
