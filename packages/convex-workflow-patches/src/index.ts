import { WorkflowManager as UpstreamWorkflowManager, type WorkflowComponent, type WorkflowDefinition, type WorkflowId } from '@convex-dev/workflow';
import type { WorkpoolOptions } from '@convex-dev/workpool';
import type { GenericActionCtx, GenericDataModel, GenericMutationCtx, RegisteredMutation, ReturnValueForOptionalValidator } from 'convex/server';
import type { ObjectType, PropertyValidators, Validator } from 'convex/values';

import type { DeclaredPatches, PatchesComponent } from './patchState.ts';
import type { InferFromOptionalValidator, WorkflowHandler, WorkflowMutationResult } from './vendor/workflow/types.ts';
import type { WorkflowCtx } from './vendor/workflow/workflowContext.ts';
import { type WorkflowArgs, workflowMutation } from './vendor/workflow/workflowMutation.ts';

// Upstream's exports that don't replay a handler, unchanged. Left out on
// purpose: `defineWorkflow` (its workflows can't patch; use `workflow.define`)
// and the standalone `cleanup` (it leaves patch records behind; use
// `workflow.cleanup`). tests/exports.test.ts keeps this list complete.
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
export type { DeclaredPatches, PatchesComponent } from './patchState.ts';
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

/**
 * `@convex-dev/workflow`'s `WorkflowManager`, with `step.patched()` and
 * `step.deprecatePatch()` in every workflow it defines.
 *
 * ```ts
 * import declared from './patches';
 *
 * export const workflow = new WorkflowManager(components.workflow, {
 *   patches: components.workflowPatches,
 *   declared,
 * });
 * ```
 */
export class WorkflowManager extends UpstreamWorkflowManager {
  public readonly patches: PatchesComponent;
  public readonly declared: DeclaredPatches;

  public constructor(component: WorkflowComponent, options: { patches: PatchesComponent; declared: DeclaredPatches; workpoolOptions?: WorkpoolOptions }) {
    super(component, options.workpoolOptions ? { workpoolOptions: options.workpoolOptions } : undefined);
    this.patches = options.patches;
    this.declared = options.declared;
  }

  public override define<ArgsValidator extends PropertyValidators, ReturnsValidator extends Validator<unknown, 'required', string> | void>(
    workflow: WorkflowDefinition<ArgsValidator, ReturnsValidator> & { handler: WorkflowHandler<ArgsValidator, ReturnsValidator> },
  ): WorkflowMutation<ArgsValidator, ReturnsValidator>;
  public override define<ArgsValidator extends PropertyValidators, ReturnsValidator extends Validator<unknown, 'required', string> | void>(
    workflow: WorkflowDefinition<ArgsValidator, ReturnsValidator>,
  ): {
    handler(
      fn: (step: WorkflowCtx, args: ObjectType<ArgsValidator>) => Promise<ReturnValueForOptionalValidator<ReturnsValidator>>,
    ): WorkflowMutation<ArgsValidator, ReturnsValidator>;
  };
  public override define<ArgsValidator extends PropertyValidators, ReturnsValidator extends Validator<unknown, 'required', string> | void>(
    workflow: WorkflowDefinition<ArgsValidator, ReturnsValidator> & { handler?: WorkflowHandler<ArgsValidator, ReturnsValidator> },
  ): unknown {
    const patches = { component: this.patches, declared: this.declared };
    const build = (handler: WorkflowHandler<ArgsValidator, ReturnsValidator>) =>
      workflowMutation(this.component, patches, { ...workflow, handler }, this.options?.workpoolOptions);
    return workflow.handler ? build(workflow.handler) : { handler: build };
  }

  /** Deletes a finished workflow, its journal and its patch records. */
  public override async cleanup(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    const removed = await super.cleanup(ctx, workflowId);
    if (removed) await ctx.runMutation(this.patches.runs.cleanup, { workflowId });
    return removed;
  }
}
