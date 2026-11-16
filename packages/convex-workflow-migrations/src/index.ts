import { WorkflowManager as UpstreamWorkflowManager, type WorkflowComponent, type WorkflowDefinition, type WorkflowId } from '@convex-dev/workflow';
import type { WorkpoolOptions } from '@convex-dev/workpool';
import type { GenericActionCtx, GenericDataModel, GenericMutationCtx, GenericQueryCtx, RegisteredMutation } from 'convex/server';
import type { PropertyValidators, Validator } from 'convex/values';

import { checkMigrations, type Migration, type MigrationsComponent, type PauseInfo, type PauseReason, type WorkflowMigrations } from './migrations.ts';
import type { InferFromOptionalValidator, WorkflowHandler, WorkflowMutationResult } from './vendor/workflow/types.ts';
import { type WorkflowArgs, workflowMutation } from './vendor/workflow/workflowMutation.ts';

// Upstream's exports that don't replay a handler, unchanged. Left out on
// purpose: `defineWorkflow` (its workflows can't migrate; use
// `workflow.define`) and the standalone `cleanup` (it leaves the run's record
// behind; use `workflow.cleanup`). tests/exports.test.ts keeps this list
// complete.
export {
  cancel,
  createEvent,
  defineEvent,
  getStatus,
  list,
  listByName,
  listSteps,
  restart,
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
  /** For a mismatch: the position in the history, for `restartFrom`. */
  step?: number;
  /** When the run paused, how many attempts have paused it, and when the next one is. */
  at: number;
  attempts: number;
  nextAttemptAt: number;
};

export type WorkflowManagerOptions = {
  /** The migrations component, `components.workflowMigrations`. */
  migrationsComponent: MigrationsComponent;
  /**
   * Called once when a run pauses, in the transaction that pauses it. An
   * error it throws is logged; the run stays paused.
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
  public readonly migrationsComponent: MigrationsComponent;
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

  /** Paused runs, the next one due for a retry first. */
  public async paused(ctx: QueryCtx, opts?: { limit?: number }): Promise<PausedRun[]> {
    return (await ctx.runQuery(this.migrationsComponent.runs.list, { limit: opts?.limit })) as PausedRun[];
  }

  /**
   * Retries a paused run now, for example after deploying a fix. Returns
   * whether it got past its pause; if not, it stays paused with the new
   * reason. An error from the workflow mutation is thrown.
   */
  public async resume(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    return !(await ctx.runMutation(this.migrationsComponent.runs.retry, { workflowId, now: true }));
  }

  /**
   * Removes every step of a paused run's history from position `step` on
   * (the `step` that `paused` reports for a mismatch), and retries: those
   * steps run again. Throws, changing nothing, if the run would still pause.
   */
  public async restartFrom(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId, step: number): Promise<void> {
    if (!Number.isInteger(step) || step < 0) throw new Error(`restartFrom: step must be a position in the history, got ${step}.`);
    await this.expectPaused(ctx, workflowId, 'restartFrom');
    await ctx.runMutation(this.migrationsComponent.runs.retry, { workflowId, restartFrom: step });
  }

  /**
   * Completes a paused run as failed, with why it paused as the error.
   * `onComplete` runs. From an action, ending the pause and failing the run
   * are two transactions.
   */
  public async fail(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<void> {
    const paused = await this.expectPaused(ctx, workflowId, 'fail');
    await ctx.runMutation(this.migrationsComponent.runs.unpause, { workflowId });
    const { workflow } = await ctx.runQuery(this.component.workflow.getStatus, { workflowId });
    await ctx.runMutation(this.component.workflow.complete, {
      workflowId,
      generationNumber: workflow.generationNumber,
      runResult: { kind: 'failed', error: `Paused (${paused.reason}): ${paused.detail}` },
    });
  }

  /** Upstream's `cancel`. A paused run's pause ends too. */
  public override async cancel(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<void> {
    await super.cancel(ctx, workflowId);
    await ctx.runMutation(this.migrationsComponent.runs.unpause, { workflowId });
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

  private async expectPaused(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId, action: string) {
    const record = await ctx.runQuery(this.migrationsComponent.runs.load, { workflowId });
    if (!record?.paused) throw new Error(`${action}: workflow ${workflowId} isn't paused.`);
    return record.paused;
  }
}
