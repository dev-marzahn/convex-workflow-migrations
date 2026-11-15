import {
  WorkflowManager as UpstreamWorkflowManager,
  vWorkflowId,
  type WorkflowComponent,
  type WorkflowDefinition,
  type WorkflowId,
} from '@convex-dev/workflow';
import type { WorkpoolOptions } from '@convex-dev/workpool';
import type {
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  PaginationOptions,
  PaginationResult,
  RegisteredMutation,
  ReturnValueForOptionalValidator,
} from 'convex/server';
import { internalQueryGeneric } from 'convex/server';
import { type ObjectType, type PropertyValidators, v, type Validator } from 'convex/values';

import type { PatchesComponent } from './patchState.ts';
import { safeFunctionName } from './vendor/workflow/safeFunctionName.ts';
import type { InferFromOptionalValidator, WorkflowHandler, WorkflowMutationResult } from './vendor/workflow/types.ts';
import type { WorkflowCtx } from './vendor/workflow/workflowContext.ts';
import { type WorkflowArgs, workflowMutation } from './vendor/workflow/workflowMutation.ts';

// Everything that doesn't replay a handler comes from upstream unchanged:
// start, status, cancel, restart, sendEvent, list, the validators and types.
export * from '@convex-dev/workflow';
export type { PatchesComponent } from './patchState.ts';
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

  /**
   * One page of the running workflows that have no marker for `patchId`: the
   * runs that may still need the code path without the patch. Deploying code
   * that removes that path while this returns runs fails them.
   *
   * A run that hasn't reached the patch point yet has no marker either, so it
   * is listed too until it gets there. Pages follow `listByName`; a page can be
   * empty while `isDone` is false.
   */
  public async runsWithoutPatch(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    workflow: FunctionReference<'mutation', 'internal'> | string,
    patchId: string,
    paginationOpts: PaginationOptions,
  ): Promise<PaginationResult<WorkflowId>> {
    const name = typeof workflow === 'string' ? workflow : safeFunctionName(workflow);
    const { page, isDone, continueCursor } = await this.listByName(ctx, name, { order: 'asc', paginationOpts });
    const running = page.filter((run) => run.runResult === undefined).map((run) => run.workflowId);
    const marked = new Set(await ctx.runQuery(this.patches.markers.withPatch, { patchId, workflowIds: running }));
    return { page: running.filter((id) => !marked.has(id)), isDone, continueCursor };
  }

  /**
   * An internal query over `runsWithoutPatch`, for `convex-workflow-patches
   * drain` to call. Export it from `convex/patches.ts` as `drain`:
   *
   * ```ts
   * export const drain = workflow.drainQuery();
   * ```
   */
  public drainQuery() {
    return internalQueryGeneric({
      args: { workflow: v.string(), patchId: v.string(), cursor: v.union(v.string(), v.null()) },
      returns: v.object({ page: v.array(vWorkflowId), isDone: v.boolean(), continueCursor: v.string() }),
      handler: async (ctx, { workflow, patchId, cursor }) => {
        const { page, isDone, continueCursor } = await this.runsWithoutPatch(ctx, workflow, patchId, { cursor, numItems: 100 });
        return { page, isDone, continueCursor };
      },
    });
  }

  /** Deletes a finished workflow, its journal and its patch markers. */
  public override async cleanup(ctx: MutationCtx | ActionCtx, workflowId: WorkflowId): Promise<boolean> {
    const removed = await super.cleanup(ctx, workflowId);
    if (removed) await ctx.runMutation(this.patches.markers.cleanup, { workflowId });
    return removed;
  }
}
