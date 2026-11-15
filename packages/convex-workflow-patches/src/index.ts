import { WorkflowManager as UpstreamWorkflowManager, type WorkflowComponent, type WorkflowDefinition, type WorkflowId } from '@convex-dev/workflow';
import type { WorkpoolOptions } from '@convex-dev/workpool';
import type { GenericActionCtx, GenericDataModel, GenericMutationCtx, RegisteredMutation, ReturnValueForOptionalValidator } from 'convex/server';
import type { ObjectType, PropertyValidators, Validator } from 'convex/values';

import type { PatchesComponent } from './patchState.ts';
import type { InferFromOptionalValidator, WorkflowHandler, WorkflowMutationResult } from './vendor/workflow/types.ts';
import type { WorkflowCtx } from './vendor/workflow/workflowContext.ts';
import { type WorkflowArgs, workflowMutation } from './vendor/workflow/workflowMutation.ts';

// Everything that doesn't replay a handler comes from upstream unchanged:
// start, status, cancel, restart, sendEvent, list, the validators and types.
export * from '@convex-dev/workflow';
export type { PatchesComponent } from './patchState.ts';
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
 * export const workflow = new WorkflowManager(components.workflow, {
 *   patches: components.workflowPatches,
 * });
 * ```
 */
export class WorkflowManager extends UpstreamWorkflowManager {
  public readonly patches: PatchesComponent;

  public constructor(component: WorkflowComponent, options: { patches: PatchesComponent; workpoolOptions?: WorkpoolOptions }) {
    super(component, options.workpoolOptions ? { workpoolOptions: options.workpoolOptions } : undefined);
    this.patches = options.patches;
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
    const build = (handler: WorkflowHandler<ArgsValidator, ReturnsValidator>) =>
      workflowMutation(this.component, this.patches, { ...workflow, handler }, this.options?.workpoolOptions);
    return workflow.handler ? build(workflow.handler) : { handler: build };
  }

  /** Deletes a finished workflow, its journal and its patch markers. */
  public override async cleanup(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    const removed = await super.cleanup(ctx, workflowId);
    if (removed) await ctx.runMutation(this.patches.markers.cleanup, { workflowId });
    return removed;
  }
}
