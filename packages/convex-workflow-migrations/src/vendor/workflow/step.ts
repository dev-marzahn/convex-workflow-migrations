import type { RetryBehavior, WorkpoolOptions } from "@convex-dev/workpool";
import { BaseChannel } from "async-channel";
import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionReference_future,
  type FunctionType,
  type FunctionVisibility,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { convexToJson, getConvexSize, type Value } from "convex/values";
// PATCHES: vendored from @convex-dev/workflow 0.4.10 src/client/step.ts.
// Changes are marked "PATCHES:". See VENDORED.md.
import type {
  IdsToStrings,
  JournalEntry,
  RunResult,
  Step,
  TransactionLimits,
  WorkflowComponent,
} from "./types.js";
import { MAX_JOURNAL_SIZE, formatErrorWithStack } from "./shared.js";
import type { EventId, SchedulerOptions } from "./publicTypes.js";
import { pick } from "convex-helpers";
import type { HistoryView } from "../../history.js";
import {
  type ReplayEntry,
  ReplayMismatch,
  type ReplayStep,
} from "../../replay.js";

export type WorkerResult =
  | { type: "handlerDone"; runResult: RunResult }
  | { type: "executorBlocked" };

export type StepRequest = {
  name: string;
  target:
    | {
        kind: "function";
        functionType: FunctionType;
        function:
          | FunctionReference<FunctionType, FunctionVisibility>
          | FunctionReference_future<FunctionType, FunctionVisibility>;
        args: Record<string, unknown>;
      }
    | {
        kind: "event";
        args: { eventId?: EventId };
      }
    | {
        kind: "workflow";
        function: FunctionReference<"mutation", "internal">;
        args: Record<string, unknown>;
      }
    | {
        kind: "sleep";
        args: Record<string, never>;
      };
  retry: RetryBehavior | boolean | undefined;
  inline: boolean;
  unstableArgs: boolean;
  transactionLimits: TransactionLimits | undefined;
  schedulerOptions: SchedulerOptions;

  resolve: (result: RunResult) => void;
};

export class StepExecutor {
  private journalEntrySize: number;
  // PATCHES: replay matches calls against the run's history, the journal
  // with its migrations' edits, instead of the raw journal.
  private journalEntries: ReplayEntry[];
  // PATCHES: whether this handler run started a step past the history.
  private started = false;
  // PATCHES: set by `replayHandler` when the handler run pauses: no step
  // starts after that, though the handler may still make calls.
  halted = false;

  constructor(
    private workflowId: string,
    private generationNumber: number,
    private ctx: GenericMutationCtx<GenericDataModel>,
    private component: WorkflowComponent,
    journalEntries: Array<JournalEntry>,
    private receiver: BaseChannel<StepRequest>,
    private now: number,
    private workpoolOptions: WorkpoolOptions | undefined,
    // PATCHES:
    history: HistoryView,
  ) {
    this.journalEntrySize = journalEntries.reduce(
      (size, entry) => size + getConvexSize(entry),
      0,
    );

    if (this.journalEntrySize > MAX_JOURNAL_SIZE) {
      // This should never happen, but we'll throw an error just in case.
      throw new Error(journalSizeError(this.journalEntrySize, this.workflowId));
    }
    // PATCHES:
    this.journalEntries = history.replay(now);
  }
  async run(): Promise<WorkerResult> {
    while (true) {
      const message = await this.receiver.get();
      // In the future we can correlate the calls to entries by handle, args,
      // etc. instead of just ordering. As is, the fn order can't change.
      const entry = this.journalEntries.shift();
      // PATCHES: a running step blocks replay. The workflow mutation doesn't
      // replay while a step runs, so only a history given to expectReplays()
      // has one here.
      if (entry?.step.inProgress) {
        this.completeMessage(message, entry, true);
        return { type: "executorBlocked" };
      }
      if (entry) {
        this.completeMessage(message, entry);
        continue;
      }
      const messages = [message];
      const size = this.receiver.bufferSize;
      for (let i = 0; i < size; i++) {
        const message = await this.receiver.get();
        messages.push(message);
      }
      // PATCHES: a paused handler run starts no step. Nothing reads this
      // result any more, and the calls stay unresolved.
      if (this.halted) {
        return { type: "executorBlocked" };
      }
      this.started = true;
      const entries = await this.startSteps(messages);
      if (entries.every((entry) => entry.step.runResult)) {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          this.completeMessage(messages[i], entry);
        }
        continue;
      }
      return {
        type: "executorBlocked",
      };
    }
  }

  getGenerationState() {
    if (this.journalEntries.length <= this.receiver.bufferSize) {
      return { now: this.now, latest: true };
    }
    return {
      // We use the next entry's startedAt, since we're in code just before that
      // step is invoked. We use the bufferSize, since multiple steps may be
      // currently enqueued in one generation, but the code after it has already
      // started executing.
      now: this.journalEntries[this.receiver.bufferSize].step.startedAt,
      latest: false,
    };
  }

  // PATCHES: how far replay got, for a handler that threw or returned: the
  // first history step it hasn't called (calls the executor hasn't taken yet
  // count as called), and whether it started, or is about to start, a step
  // past the history.
  progress(): { next?: ReplayEntry; started: boolean } {
    const queued = this.receiver.bufferSize;
    return {
      next: this.journalEntries[queued],
      started: this.started || queued > this.journalEntries.length,
    };
  }

  // PATCHES: takes a step of the history. With checkOnly, for a running
  // step, it compares the call and resolves nothing.
  completeMessage(message: StepRequest, entry: ReplayStep, checkOnly = false) {
    if (entry.step.inProgress && !checkOnly) {
      throw new Error(
        `Assertion failed: not blocked but have in-progress journal entry`,
      );
    }
    // PATCHES: a stand-in inserted without args matches on name and kind.
    const compareArgs = !message.unstableArgs && entry.argsKnown !== false;
    const stepFields = pick(
      entry.step,
      compareArgs ? ["name", "kind", "args"] : ["name", "kind"],
    );
    const messageFields = !compareArgs
      ? { name: message.name, kind: message.target.kind }
      : {
          name: message.name,
          kind: message.target.kind,
          args: message.target.args as Value,
        };
    const stepJson = JSON.stringify(convexToJson(stepFields));
    const messageJson = JSON.stringify(convexToJson(messageFields));
    if (stepJson !== messageJson) {
      // PATCHES: a mismatch with the history pauses the run.
      if (entry.position !== undefined) {
        throw new ReplayMismatch(entry.position, messageJson, stepJson);
      }
      throw new Error(
        `Journal entry mismatch:\n\n${stepJson}\n\n!==\n\n${messageJson}`,
      );
    }
    if (checkOnly) return;
    if (entry.step.runResult === undefined) {
      throw new Error(
        `Assertion failed: no outcome for completed function call`,
      );
    }
    message.resolve(entry.step.runResult);
  }

  async startSteps(messages: StepRequest[]): Promise<JournalEntry[]> {
    const steps = await Promise.all(
      messages.map(async (message) => {
        const args = message.target.args ?? {};
        const target = message.target;

        let runResult: RunResult | undefined;
        if (message.inline) {
          if (target.kind !== "function" || target.functionType === "action") {
            throw new Error(
              "Inline execution is only supported for queries and mutations.",
            );
          }
          try {
            const result =
              target.functionType === "query"
                ? // cast until transactionLimits is shipped / peer dep
                  await (this.ctx.runQuery as any)(
                    target.function as FunctionReference<
                      typeof target.functionType
                    >,
                    target.args,
                    { transactionLimits: message.transactionLimits },
                  )
                : // cast until transactionLimits is shipped / peer dep
                  await (this.ctx.runMutation as any)(
                    target.function as FunctionReference<
                      typeof target.functionType
                    >,
                    target.args,
                    { transactionLimits: message.transactionLimits },
                  );
            runResult = { kind: "success", returnValue: result ?? null };
          } catch (error: unknown) {
            runResult = { kind: "failed", error: formatErrorWithStack(error) };
          }
        }

        const commonFields = {
          inProgress: !runResult,
          name: message.name,
          args,
          argsSize: getConvexSize(args as Value),
          runResult,
          startedAt: this.now,
          completedAt: runResult ? this.now : undefined,
        } satisfies Omit<Step, "kind">;
        let step: IdsToStrings<Step>;
        switch (target.kind) {
          case "function":
            step = {
              kind: "function" as const,
              functionType: target.functionType,
              handle: await createFunctionHandle(target.function),
              ...commonFields,
            };
            break;
          case "workflow":
            step = {
              kind: "workflow" as const,
              handle: await createFunctionHandle(target.function),
              ...commonFields,
            };
            break;
          case "event":
            step = {
              kind: "event" as const,
              eventId: target.args.eventId,
              ...commonFields,
              args: target.args,
            };
            break;
          case "sleep":
            step = {
              kind: "sleep" as const,
              ...commonFields,
            };
            break;
          default:
            throw new Error(`Unknown step kind: ${(target as any).kind}`);
        }
        return {
          retry: message.retry,
          schedulerOptions: message.schedulerOptions,
          step,
        };
      }),
    );
    const entries = (await this.ctx.runMutation(
      this.component.journal.startSteps,
      {
        workflowId: this.workflowId,
        generationNumber: this.generationNumber,
        steps,
        workpoolOptions: this.workpoolOptions,
      },
    )) as JournalEntry[];
    for (const entry of entries) {
      this.journalEntrySize += getConvexSize(entry);
      if (this.journalEntrySize > MAX_JOURNAL_SIZE) {
        throw new Error(
          journalSizeError(this.journalEntrySize, this.workflowId) +
            ` The failing step was ${entry.step.name} (${entry._id})`,
        );
      }
    }
    return entries;
  }
}

function journalSizeError(size: number, workflowId: string): string {
  const lines = [
    `Workflow ${workflowId} journal size limit exceeded (${size} bytes > ${MAX_JOURNAL_SIZE} bytes).`,
    "Consider breaking up the workflow into multiple runs, using smaller step \
    arguments or return values, or using fewer steps.",
  ];
  return lines.join("\n");
}
