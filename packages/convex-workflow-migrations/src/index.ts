import { WorkflowManager as UpstreamWorkflowManager, type WorkflowComponent, type WorkflowDefinition, type WorkflowId } from '@convex-dev/workflow';
import type { WorkpoolOptions } from '@convex-dev/workpool';
import type { GenericActionCtx, GenericDataModel, GenericMutationCtx, GenericQueryCtx, RegisteredMutation } from 'convex/server';
import type { PropertyValidators, Validator } from 'convex/values';

import { FORMAT } from './component/schema.ts';
import { HistoryView, type OverlayOp, type StepRef } from './history.ts';
import {
  checkMigrations,
  type Migration,
  type MigrationsComponent,
  type PauseInfo,
  type PauseReason,
  recordedStep,
  type WorkflowMigrations,
} from './migrations.ts';
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

/** A paused run, as `WorkflowManager.paused` lists it. */
export type PausedRun = {
  workflowId: WorkflowId;
  /** The workflow's function name. */
  workflow: string;
  reason: PauseReason;
  /** For a mismatch: the position, and the call the code made and the step the history has there. */
  detail: string;
  /** For a mismatch or a throw: the position in the history (from 0), for `restartFrom`. */
  step?: number;
  /** When the run first paused, how many attempts have paused it since, and when the next one is. */
  at: number;
  attempts: number;
  nextAttemptAt: number;
};

/** A page of paused runs. Pass `continueCursor` as `cursor` for the next one, until `isDone`. */
export type PausedPage = { page: PausedRun[]; isDone: boolean; continueCursor: string };

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
   * `pipeline:run`), the next one due for a retry first. `numItems` defaults
   * to 100.
   */
  public async paused(ctx: QueryCtx, opts?: { workflow?: string; cursor?: string | null; numItems?: number }): Promise<PausedPage> {
    const paginationOpts = { numItems: opts?.numItems ?? 100, cursor: opts?.cursor ?? null };
    return (await ctx.runQuery(this.migrationsComponent.runs.list, {
      paginationOpts,
      ...(opts?.workflow === undefined ? {} : { workflow: opts.workflow }),
    })) as PausedPage;
  }

  /**
   * Retries a paused run now, for example after deploying a fix. Returns
   * whether it got past its pause; if not, it stays paused with the new
   * reason. Throws if the run isn't paused, and an error from the workflow
   * mutation is thrown too.
   */
  public async resume(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    await this.expectPaused(ctx, workflowId, 'resume');
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
   * Throws, changing nothing, if the run isn't paused or would still pause.
   */
  public async restartFrom(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId, step: number): Promise<void> {
    if (!Number.isInteger(step) || step < 0) throw new Error(`restartFrom: step must be a position in the history, got ${step}.`);
    await this.expectPaused(ctx, workflowId, 'restartFrom');
    await ctx.runMutation(this.migrationsComponent.runs.retry, { workflowId, restartFrom: step });
  }

  /**
   * Completes a paused run as failed, with why it paused as the error, then
   * ends the pause. `onComplete` runs. Throws if the run isn't paused. From
   * an action, those are two transactions; if the second doesn't happen, the
   * run's next retry ends the pause.
   */
  public async fail(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<void> {
    const paused = await this.expectPaused(ctx, workflowId, 'fail');
    const { workflow } = await ctx.runQuery(this.component.workflow.getStatus, { workflowId });
    await ctx.runMutation(this.component.workflow.complete, {
      workflowId,
      generationNumber: workflow.generationNumber,
      runResult: { kind: 'failed', error: `Paused (${paused.reason}): ${paused.detail}` },
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
   * as its last handler run left it: a position (from 0), a step name or a
   * step reference, which means its last occurrence, as upstream's does.
   * Steps from there on run again, including steps migrations inserted, and
   * the steps before it replay as they did. Like `restartFrom`, it stores the
   * step on the run's record, and the restarted run's first handler run
   * applies any pending migrations, then removes the history from that step
   * on. Upstream's journal keeps every entry. Throws if the run is still
   * running; for a paused one, use `restartFrom`. From an action, the record
   * is updated in a transaction before the restart.
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
    const from = options?.from === undefined ? undefined : this.restartStep(workflowId, options.from, { journalEntries, ok, args: workflow.args }, record);
    // Without `from`, this clears a step a restart from an action stored but didn't get to.
    if (record || from !== undefined) {
      await ctx.runMutation(this.migrationsComponent.runs.restart, {
        workflowId,
        workflow: record?.workflow ?? workflow.name ?? '',
        ...(from === undefined ? {} : { from }),
      });
    }
    await super.restart(ctx, workflowId, startAsync);
  }

  /**
   * Deletes a finished workflow, its journal and its record. From a mutation,
   * all in its transaction; from an action, the record goes in a second one.
   */
  public override async cleanup(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    const removed = await super.cleanup(ctx, workflowId);
    if (removed) await ctx.runMutation(this.migrationsComponent.runs.cleanup, { workflowId });
    return removed;
  }

  /** The id of the step `restart` restarts from, or undefined past the end of the history. Throws if it can't restart from there. */
  private restartStep(
    workflowId: WorkflowId,
    from: number | string | StepRef,
    run: { journalEntries: unknown[]; ok: boolean; args: unknown },
    record: { overlay: OverlayOp[]; format: number } | null,
  ): string | undefined {
    if (!run.ok) throw new Error(`restart: workflow ${workflowId}'s journal is too big to load whole, so its history can't be read.`);
    if (record && record.format > FORMAT) {
      throw new Error(`restart: workflow ${workflowId}'s record has format ${record.format}, from a newer version of this package; this one reads ${FORMAT}.`);
    }
    const history = new HistoryView((run.journalEntries as JournalEntry[]).map(recordedStep), record?.overlay ?? [], run.args);
    let position: number;
    if (typeof from === 'number') {
      if (!Number.isInteger(from) || from < 0) throw new Error(`restart: from must be a position in the history, got ${from}.`);
      position = from;
    } else {
      position = history.lastPosition(from);
      if (position < 0)
        throw new Error(`restart: workflow ${workflowId}'s history has no step ${typeof from === 'string' ? `"${from}"` : 'that matches from'}.`);
    }
    const id = history.idAt(position);
    // Throws now, rather than in the restarted run, if a step from there on is still running.
    history.truncate(position);
    return id;
  }

  private async expectPaused(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId, action: string) {
    const record = await ctx.runQuery(this.migrationsComponent.runs.load, { workflowId });
    if (!record?.paused) throw new Error(`${action}: workflow ${workflowId} isn't paused.`);
    return record.paused;
  }
}
