import {
  type CallbackOptions,
  start as startWorkflow,
  WorkflowManager as UpstreamWorkflowManager,
  type WorkflowComponent,
  type WorkflowDefinition,
  type WorkflowId,
} from '@convex-dev/workflow';
import type { WorkpoolOptions } from '@convex-dev/workpool';
import type {
  FunctionArgs,
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredMutation,
} from 'convex/server';
import type { Infer, PropertyValidators, Validator } from 'convex/values';

import type { vPausedRun } from './component/schema.ts';
import { checkMigrations, type Migration, type MigrationsComponent, type PauseInfo, type WorkflowMigrations } from './migrations.ts';
import { REPLAY, type ReplayTarget } from './replay.ts';
import type { InferFromOptionalValidator, WorkflowHandler, WorkflowMutationResult } from './vendor/workflow/types.ts';
import { type WorkflowArgs, workflowMutation } from './vendor/workflow/workflowMutation.ts';

// Upstream's exports that don't replay a handler, unchanged. Left out on
// purpose, because they bypass the migrations or the run's record:
// `defineWorkflow` (use `workflow.define`), and the standalone `restart` and
// `cleanup` (use the manager's). tests/exports.test.ts keeps this list
// complete.
export { cancel, createEvent, defineEvent, getStatus, list, listByName, listSteps, sendEvent, start } from '@convex-dev/workflow';
export { vEventId, vResultValidator, vWorkflowId, vWorkflowStep } from '@convex-dev/workflow';
export type { CallbackOptions, EventId, RunOptions, RunResult, StepDefaults, WorkflowComponent, WorkflowDefinition } from '@convex-dev/workflow';
export type { WorkflowId, WorkflowMutationResult, WorkflowStatus, WorkflowStep } from '@convex-dev/workflow';
export { migration } from './migrations.ts';
export type { Migration, MigrationsComponent, PauseInfo } from './migrations.ts';
export type { ReplayReason as PauseReason } from './replay.ts';
export type { History, HistoryStep, InsertOptions, StepArgs, StepRef, StepResult, StepSelector } from './history.ts';
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
 * name, why it paused (`reason`, `detail`, and `step`, as in `PauseInfo`),
 * when it first paused (`at`, in ms), how many attempts it has had, when the
 * next retry is (`nextAttemptAt`, in ms), and `lastError`, why the last attempt didn't complete, if it
 * didn't.
 */
export type PausedRun = Omit<Infer<typeof vPausedRun>, 'workflowId'> & { workflowId: WorkflowId };

export type WorkflowManagerOptions = {
  /** The migrations component, `components.workflowMigrations`. */
  migrationsComponent: MigrationsComponent;
  /**
   * Called when a run pauses instead of failing, in the transaction that
   * pauses it, and again when a retry or `resume` pauses it for another
   * reason, at another step or with another detail. `ctx` is the workflow
   * mutation's: cast it to your app's `MutationCtx` to use your tables. Its
   * writes commit with the pause, even those made before an error it throws,
   * which is logged while the run stays paused: make them in a
   * `ctx.runMutation` to commit all or none. Required, since nothing else
   * reports a paused run: pass `null` to opt out.
   */
  onPause: ((ctx: GenericMutationCtx<GenericDataModel>, info: PauseInfo) => void | Promise<void>) | null;
  workpoolOptions?: WorkpoolOptions;
};

/**
 * `@convex-dev/workflow`'s `WorkflowManager`, for workflows with migrations.
 * A run that can't replay on the current code pauses, and is retried.
 *
 * ```ts
 * export const workflow = new WorkflowManager(components.workflow, {
 *   migrationsComponent: components.workflowMigrations,
 *   onPause: (ctx, info) => console.error(`Workflow ${info.workflowId} paused (${info.reason}): ${info.detail}`),
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
    this.onPause = options.onPause ?? undefined;
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
    const setup: WorkflowMigrations = { component: this.migrationsComponent, list: checkMigrations(migrations), args: definition.args, onPause: this.onPause };
    const build = (fn: WorkflowHandler<ArgsValidator, ReturnsValidator>) => {
      const registered = { ...definition, handler: fn };
      const mutation = workflowMutation(this.component, setup, registered, this.options?.workpoolOptions);
      // For the /replay helpers, which replay a history without Convex.
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
   * Upstream's `start`, always through the workflow mutation, with
   * `startAsync` too: it writes the run's record, with the migrations this
   * code lists, in the transaction that creates the run.
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
   * Upstream's `restart` of a finished run. Without `from`, the run replays
   * its whole history, with its migrations. With `from`, it throws for a run
   * whose migrations edited its history: `from` counts upstream's journal,
   * which isn't that history. Not supported yet.
   */
  public override async restart(
    ctx: MutationCtx | ActionCtx,
    workflowId: WorkflowId,
    options?: { from?: number | string | FunctionReference<any, any>; startAsync?: boolean },
  ): Promise<void> {
    if (options?.from !== undefined) {
      const record = await ctx.runQuery(this.migrationsComponent.runs.load, { workflowId });
      if (record && record.overlay.length > 0) {
        throw new Error(
          `restart: workflow ${workflowId}'s migrations edited its history, and restart({ from }) on such a run isn't supported yet. ` +
            'Restart it without from, which replays its whole history.',
        );
      }
    }
    await super.restart(ctx, workflowId, options);
  }

  /**
   * A page of paused runs (of one workflow, by its function name as Convex
   * names it, like `pipeline:run`: a wrong name returns an empty page), the
   * one that paused first first. Works from a query. `numItems` defaults to
   * 100. Pass `continueCursor` as `cursor` for the next page, until `isDone`.
   */
  public async paused(
    ctx: QueryCtx,
    opts: { workflow?: string; cursor?: string | null; numItems?: number } = {},
  ): Promise<{ page: PausedRun[]; isDone: boolean; continueCursor: string }> {
    const paginationOpts = { numItems: opts.numItems ?? 100, cursor: opts.cursor ?? null };
    const result = await ctx.runQuery(this.migrationsComponent.runs.list, {
      paginationOpts,
      ...(opts.workflow === undefined ? {} : { workflow: opts.workflow }),
    });
    return { ...result, page: result.page.map((run) => ({ ...run, workflowId: run.workflowId as WorkflowId })) };
  }

  /**
   * Retries a paused run now, in one transaction, for example after
   * deploying a fix, without counting an attempt or moving the next retry.
   * Returns true only if the run replayed past its pause. Otherwise false:
   * either it paused again, or its pause ended without a replay, because the
   * run finished (canceled bypassing the manager: upstream's standalone
   * `cancel`, or a parent's cancel), it's at another generation, or it's
   * gone. Throws if the run isn't paused, and so does an error from the
   * workflow mutation.
   */
  public async resume(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    return await ctx.runMutation(this.migrationsComponent.runs.resume, { workflowId });
  }

  /**
   * Completes a paused run as failed, with `reason` as the error, or else
   * `Paused (<reason>): <detail>`, and ends the pause, in the caller's transaction: so it takes a
   * mutation's ctx. `onComplete` runs. A paused run that upstream's component
   * already finished keeps its result: only its pause ends. Throws if the run
   * isn't paused.
   */
  public async fail(
    ctx: Pick<GenericMutationCtx<GenericDataModel>, 'runQuery' | 'runMutation' | 'db'>,
    workflowId: WorkflowId,
    reason?: string,
  ): Promise<void> {
    if (!('db' in ctx)) throw new Error("fail takes a mutation's ctx: it fails the run and ends its pause in one transaction.");
    const ended = await ctx.runMutation(this.migrationsComponent.runs.end, { workflowId });
    if (!ended) throw new Error(`fail: workflow ${workflowId} isn't paused.`);
    const { workflow } = await ctx.runQuery(this.component.workflow.getStatus, { workflowId });
    if (workflow.runResult) return;
    const error = reason ?? `Paused (${ended.reason}): ${ended.detail}`;
    await ctx.runMutation(this.component.workflow.complete, { workflowId, generationNumber: ended.generationNumber, runResult: { kind: 'failed', error } });
  }

  /** Upstream's `cancel`, which also ends the run's pause. From an action, those are two transactions. */
  public override async cancel(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<void> {
    await super.cancel(ctx, workflowId);
    await ctx.runMutation(this.migrationsComponent.runs.end, { workflowId });
  }

  /** Upstream's `cleanup`, which also deletes the run's record and pause. Child workflows' records stay (README, "Limits"). */
  public override async cleanup(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    const removed = await super.cleanup(ctx, workflowId);
    if (removed) await ctx.runMutation(this.migrationsComponent.runs.cleanup, { workflowId });
    return removed;
  }
}
