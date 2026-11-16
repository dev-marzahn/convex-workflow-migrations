import { type WorkpoolOptions } from "@convex-dev/workpool";
import { BaseChannel } from "async-channel";
import { assert } from "convex-helpers";
import { validate, ValidationError } from "convex-helpers/validators";
import {
  createFunctionHandle,
  internalMutationGeneric,
  makeFunctionReference,
  type FunctionHandle,
  type RegisteredMutation,
} from "convex/server";
import {
  asObjectValidator,
  v,
  type ObjectType,
  type PropertyValidators,
  type Validator,
} from "convex/values";
// PATCHES: vendored from @convex-dev/workflow 0.4.10 src/client/workflowMutation.ts.
// Changes are marked "PATCHES:". See VENDORED.md.
import { createLogger } from "./logging.js";
import { formatErrorWithStack } from "./shared.js";
import { vWorkflowId, type OnCompleteArgs, type WorkflowId } from "./publicTypes.js";
import { setupEnvironment } from "./environment.js";
import type { WorkflowDefinition } from "@convex-dev/workflow";
import { StepExecutor, type StepRequest, type WorkerResult } from "./step.js";
import {
  type InferFromOptionalValidator,
  type JournalEntry,
  type RunResult,
  type WorkflowComponent,
  type WorkflowHandler,
  type WorkflowMutationResult,
} from "./types.js";
import { createWorkflowCtx } from "./workflowContext.js";
import { ReplayPause } from "../../history.js";
import {
  loadJournal,
  recordStart,
  RunRecord,
  type WorkflowMigrations,
} from "../../migrations.js";
import { replayHandler } from "../../replay.js";

export type WorkflowArgs<V extends PropertyValidators, Context = unknown> = {
  /**
   * The arguments to pass to the Workflow handler.
   */
  args: ObjectType<V>;
  /**
   * Whether to enqueue the Workflow for asynchronous execution only.
   * By default it will start evaluating the handler's first step in the
   * current transaction.
   */
  startAsync?: boolean;
} & (
  | {
      /**
       * A function handle (created with createFunctionHandle) that will be
       * called when the Workflow completes.
       */
      onComplete: FunctionHandle<"mutation", OnCompleteArgs<Context>>;
      /**
       * Context forwarded to the `onComplete` mutation.
       */
      context: Context;
    }
  | {
      onComplete?: undefined;
      context?: undefined;
    }
);

const vWorkflowArgs = v.union(
  v.object({
    workflowId: vWorkflowId,
    generationNumber: v.number(),
  }),
  v.object({
    args: v.any(),
    startAsync: v.optional(v.boolean()),
    onComplete: v.optional(v.string()),
    context: v.optional(v.any()),
  }),
);

const vRunResult = (
  returns: Validator<any, "required", any> | PropertyValidators | undefined,
) =>
  v.union(
    v.object({
      kind: v.literal("success"),
      returnValue: returns ? asObjectValidator(returns) : v.any(),
    }),
    v.object({
      kind: v.literal("failed"),
      error: v.string(),
    }),
    v.object({ kind: v.literal("canceled") }),
  );

const vWorkflowReturns = (
  returns: Validator<any, "required", any> | PropertyValidators | undefined,
) =>
  v.union(
    vWorkflowId,
    v.object({
      kind: v.literal("complete"),
      runResult: vRunResult(returns),
    }),
  );

// This function is defined in the calling component but then gets passed by
// function handle to the workflow component for execution. This function runs
// one "poll" of the workflow, replaying its execution from the journal until
// it blocks next.
export function workflowMutation<
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends Validator<any, "required", any> | void,
>(
  component: WorkflowComponent,
  // PATCHES: the migrations component, and this workflow's migrations.
  migrations: WorkflowMigrations,
  registered: WorkflowDefinition<ArgsValidator, ReturnsValidator> & {
    handler: WorkflowHandler<ArgsValidator, ReturnsValidator>;
  },
  defaultWorkpoolOptions?: WorkpoolOptions,
): RegisteredMutation<
  "internal",
  WorkflowArgs<ArgsValidator>,
  WorkflowMutationResult<InferFromOptionalValidator<ReturnsValidator>>
> {
  const workpoolOptions = {
    ...defaultWorkpoolOptions,
    ...registered.workpoolOptions,
  };
  return internalMutationGeneric({
    args: v.object({
      // Declared on the mutation itself, so that anything deriving types from the
      // validators (static codegen, function specs) sees the real shape.
      //
      // The two shapes are merged into one all-optional object rather than kept as a
      // union b/c Convex args must be an object.
      // The handler re-checks against the real union below, for better errors.
      ...vWorkflowArgs.members[0].partial().fields,
      ...vWorkflowArgs.members[1].partial().fields,
      args: v.optional(asObjectValidator(registered.args ?? v.any())),
      // Never an actual input, exists solely to provide a better error message when
      // the workflow is called directly with args instead of nesting in { args }.
      docs: v.optional(
        v.literal(
          "To call a workflow directly, nest its arguments: { args: { ...yourWorkflowArgs } }",
        ),
      ),
    }),
    returns: vWorkflowReturns(registered.returns ?? undefined),
    handler: async (
      ctx,
      args,
    ): Promise<
      WorkflowMutationResult<InferFromOptionalValidator<ReturnsValidator>>
    > => {
      if (!validate(vWorkflowArgs, args)) {
        if (!("workflowId" in args) && !("args" in args)) {
          const console = createLogger(workpoolOptions?.logLevel);
          console.error(
            `Invalid arguments for workflow: When calling it directly, use '{ args: { ...your workflow args } }'`,
          );
        }
        assert(validate(vWorkflowArgs, args, { throw: true }));
      }
      let workflowId: WorkflowId, generationNumber: number;

      // Direct call { args: {...}, onComplete?, context?, startAsync? }
      if ("args" in args) {
        const metadata = await ctx.meta.getFunctionMetadata();
        const fn = makeFunctionReference(metadata.name);
        const onComplete =
          typeof args.onComplete === "string"
            ? { fnHandle: args.onComplete, context: args.context }
            : undefined;
        workflowId = (await ctx.runMutation(component.workflow.create, {
          workflowName: metadata.name,
          workflowHandle: await createFunctionHandle(fn),
          workflowArgs: args.args,
          maxParallelism: workpoolOptions.maxParallelism,
          onComplete,
          startAsync: args.startAsync ?? undefined,
          createOnly: !args.startAsync, // either start async or run inline here
        })) as WorkflowId;
        // PATCHES: every run starts with a record, written with the run.
        await recordStart(ctx, migrations, workflowId, metadata.name);
        if (args.startAsync) {
          return workflowId;
        }
        generationNumber = 0;
      } else {
        workflowId = args.workflowId;
        generationNumber = args.generationNumber;
      }

      // PATCHES: a run whose workflow is gone, like a paused child its
      // parent's cleanup deleted, loses its record (src/migrations.ts).
      const loaded = await loadJournal(ctx, component, migrations, workflowId);
      if (!loaded) return workflowId;
      const { workflow, logLevel, journalEntries, ok } = loaded;
      const inProgress = journalEntries.filter(({ step }) => step.inProgress);
      const console = createLogger(logLevel);
      if (!ok) {
        console.error(`Failed to load journal for ${workflowId}`);
        await ctx.runMutation(component.workflow.complete, {
          workflowId,
          generationNumber,
          runResult: { kind: "failed", error: "Failed to load journal" },
        });
        return workflowId;
      }
      if (workflow.generationNumber !== generationNumber) {
        console.error(
          `Invalid generation number: ${generationNumber} running workflow ${workflow.name} (${workflowId})`,
        );
        return workflowId;
      }
      // PATCHES: any result, not only success, so a retry left over from a
      // paused run that `fail` completed returns, and the pause ends.
      if (workflow.runResult) {
        console.log(`Workflow ${workflowId} completed, returning.`);
        return workflowId;
      }
      if (inProgress.length > 0) {
        console.log(
          `Workflow ${workflowId} blocked by ` +
            inProgress
              .map((entry) => `${entry.step.name} (${entry._id})`)
              .join(", "),
        );
        return workflowId;
      }
      for (const journalEntry of journalEntries) {
        assert(
          !journalEntry.step.inProgress,
          `Assertion failed: not blocked but have in-progress journal entry`,
        );
      }
      // PATCHES: apply the run's pending migrations, in memory. A run they
      // can't be applied to pauses, and returns so the workpool doesn't fail.
      const run = await RunRecord.load(ctx, migrations, workflow, journalEntries);
      if (run.blocked) {
        await run.pause(ctx, generationNumber, run.blocked, console);
        return workflowId;
      }
      const channel = new BaseChannel<StepRequest>(
        workpoolOptions.maxParallelism ?? 10,
      );
      const step = createWorkflowCtx(workflowId, channel);
      const executor = new StepExecutor(
        workflowId,
        generationNumber,
        ctx,
        component,
        journalEntries as JournalEntry[],
        channel,
        Date.now(),
        workpoolOptions,
        // PATCHES:
        run.history,
        (messages, entries) => run.recordChildren(ctx, messages, entries),
      );
      const restoreEnvironment = setupEnvironment(
        executor.getGenerationState.bind(executor),
        workflowId,
      );
      // PATCHES:
      let paused: ReplayPause | undefined;
      try {
        // PATCHES: upstream's handler and executor workers, in replayHandler
        // (src/replay.ts), which returns a pause by the README's rules
        // ("Pausing and recovery"). A pause commits nothing of the run.
        const options = { step, console, db: ctx.db };
        const result = await replayHandler(registered, run, executor, options);
        if (result instanceof ReplayPause) {
          paused = result;
          return workflowId;
        }
        // PATCHES: save what this handler run applied, and whether it
        // completed the run, in its transaction.
        await run.save(ctx, result.type === "handlerDone");
        switch (result.type) {
          case "handlerDone": {
            await ctx.runMutation(component.workflow.complete, {
              workflowId,
              generationNumber,
              runResult: result.runResult,
            });
            if (!("args" in args)) {
              return { kind: "complete", runResult: result.runResult };
            }
            break;
          }
          case "executorBlocked": {
            // Nothing to do, we already started steps in the StepExecutor.
            break;
          }
        }
      } finally {
        restoreEnvironment();
        // PATCHES: outside the replay's deterministic Date and console. The
        // environment can only be restored once.
        if (paused) {
          await run.pause(ctx, generationNumber, paused, console);
        }
      }
      return workflowId;
    },
  }) as RegisteredMutation<
    "internal",
    WorkflowArgs<ArgsValidator>,
    WorkflowMutationResult<InferFromOptionalValidator<ReturnsValidator>>
  >;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE createLogger";
