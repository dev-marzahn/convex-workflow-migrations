// PATCHES: vendored from @convex-dev/workflow 0.4.10 src/client/types.ts.
// Changes are marked "PATCHES:". See VENDORED.md.
import type {
  FunctionReference,
  FunctionReturnType,
  ReturnValueForOptionalValidator,
} from "convex/server";
import type {
  GenericId,
  Infer,
  ObjectType,
  PropertyValidators,
  Validator,
  Value,
} from "convex/values";
// PATCHES: the component API comes from the installed upstream package, so a
// change to its shape is a type error here.
import type { WorkflowComponent as ComponentApi } from "@convex-dev/workflow";
import type { WorkflowId } from "./publicTypes.js";
import type { WorkflowCtx } from "./workflowContext.js";

export type WorkflowComponent = ComponentApi;

// PATCHES: upstream imports these from its component schema, which it doesn't
// export. Derived from the component API instead.
export type JournalEntry = FunctionReturnType<
  WorkflowComponent["journal"]["load"]
>["journalEntries"][number];
export type Step = JournalEntry["step"];

// PATCHES: upstream defines this in client/index.ts, with its own WorkflowCtx.
export type WorkflowHandler<
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends Validator<any, "required", any> | void,
> = (
  step: WorkflowCtx,
  args: ObjectType<ArgsValidator>,
) => Promise<ReturnValueForOptionalValidator<ReturnsValidator>>;

/**
 * The value a workflow handler resolves to, according to its `returns`
 * validator. Defaults to `unknown` if the workflow has no `returns` validator.
 */
export type InferFromOptionalValidator<ReturnsValidator> = [
  ReturnsValidator,
] extends [Validator<any, any, any>]
  ? Infer<ReturnsValidator>
  : unknown;

export type RunResult<Returns = unknown> =
  | { kind: "success"; returnValue: Returns }
  | { kind: "failed"; error: string }
  | { kind: "canceled" };

/**
 * The value returned by the workflow mutation.
 *
 * Direct calls return the workflow ID. Internal polls return `complete` when
 * the handler finishes, carrying its validated result for the workflow driver.
 */
export type WorkflowMutationResult<Returns = unknown> =
  | WorkflowId
  | { kind: "complete"; runResult: RunResult<Returns> };

type ReturnValueFromWorkflowMutation<Result> = Result extends {
  kind: "complete";
  runResult: infer CompletionResult;
}
  ? CompletionResult extends {
      kind: "success";
      returnValue: infer Returns;
    }
    ? Returns
    : never
  : never;

/**
 * Recover a workflow's return type from its function reference.
 *
 * The internal poll's `complete` result carries the handler's validated return
 * value. Other branches of the mutation's return union are ignored.
 */
export type WorkflowReturnType<
  Workflow extends FunctionReference<"mutation", any, any>,
> = ReturnValueFromWorkflowMutation<FunctionReturnType<Workflow>>;

export type IdsToStrings<T> =
  T extends GenericId<string>
    ? string
    : T extends (infer U)[]
      ? IdsToStrings<U>[]
      : T extends Record<string, Value | undefined>
        ? { [K in keyof T]: IdsToStrings<T[K]> }
        : T;

/**
 * Per-transaction resource limits for an inline query or mutation.
 *
 * When passed to an inline `runQuery`/`runMutation` step, these caps are
 * enforced on that step's transaction; exceeding any of them throws an error
 * (which is catchable in the workflow handler, like any other step failure).
 *
 * **Requires Convex >= 1.41.** On older versions this option is ignored / not
 * supported by the running backend. Only applies to `inline` steps.
 */
export interface TransactionLimits {
  bytesRead?: number;
  bytesWritten?: number;
  databaseQueries?: number;
  documentsRead?: number;
  documentsWritten?: number;
  functionsScheduled?: number;
  scheduledFunctionArgsBytes?: number;
}
