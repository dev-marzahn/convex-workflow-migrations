import {
  type CallbackOptions,
  start as startWorkflow,
  WorkflowManager as UpstreamWorkflowManager,
  type WorkflowComponent,
  type WorkflowDefinition,
  type WorkflowId,
} from '@convex-dev/workflow';
import type { WorkpoolOptions } from '@convex-dev/workpool';
import type { FunctionArgs, FunctionReference, GenericActionCtx, GenericDataModel, GenericMutationCtx, RegisteredMutation } from 'convex/server';
import type { PropertyValidators, Validator } from 'convex/values';

import { checkMigrations, type Migration, type MigrationsComponent, type WorkflowMigrations } from './migrations.ts';
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
export type { Migration, MigrationsComponent } from './migrations.ts';
export type { History, HistoryStep, InsertOptions, StepArgs, StepRef, StepResult, StepSelector } from './history.ts';
export type { WorkflowHandler } from './vendor/workflow/types.ts';
export type { WorkflowCtx } from './vendor/workflow/workflowContext.ts';
export type { WorkflowArgs } from './vendor/workflow/workflowMutation.ts';

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

export type WorkflowManagerOptions = {
  /** The migrations component, `components.workflowMigrations`. */
  migrationsComponent: MigrationsComponent;
  workpoolOptions?: WorkpoolOptions;
};

/**
 * `@convex-dev/workflow`'s `WorkflowManager`, for workflows with migrations.
 *
 * ```ts
 * export const workflow = new WorkflowManager(components.workflow, {
 *   migrationsComponent: components.workflowMigrations,
 * });
 * ```
 */
export class WorkflowManager extends UpstreamWorkflowManager {
  private readonly migrationsComponent: MigrationsComponent;

  public constructor(component: WorkflowComponent, options: WorkflowManagerOptions) {
    super(component, options.workpoolOptions ? { workpoolOptions: options.workpoolOptions } : undefined);
    this.migrationsComponent = options.migrationsComponent;
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
    const setup: WorkflowMigrations = { component: this.migrationsComponent, list: checkMigrations(migrations), args: definition.args };
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

  /** Upstream's `cleanup`, which also deletes the run's record. Child workflows' records stay (README, "Limits"). */
  public override async cleanup(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    const removed = await super.cleanup(ctx, workflowId);
    if (removed) await ctx.runMutation(this.migrationsComponent.runs.cleanup, { workflowId });
    return removed;
  }
}
