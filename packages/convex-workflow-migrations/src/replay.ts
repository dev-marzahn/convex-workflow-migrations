// One handler run's replay of the handler against a run's history, and the
// rules for when it pauses the run instead of completing it (README, "Pausing
// and recovery"). The vendored workflow mutation and expectReplays() in /test
// both call `replayHandler`, so the two can't drift apart.
import { validate, ValidationError } from 'convex-helpers/validators';
import type { GenericDatabaseReader } from 'convex/server';
import { asObjectValidator, type PropertyValidators, type Validator } from 'convex/values';

import { type HistoryView, ReplayPause, returnedEarly, threwEarly } from './history.ts';
import { formatErrorWithStack } from './vendor/workflow/shared.ts';
import type { StepExecutor, WorkerResult } from './vendor/workflow/step.ts';
import type { RunResult } from './vendor/workflow/types.ts';
import type { WorkflowCtx } from './vendor/workflow/workflowContext.ts';

type ObjectValidator = PropertyValidators | Validator<any, 'required', any>;

/** The parts of a workflow definition that replay uses. */
export type ReplayDefinition = {
  args?: unknown;
  returns?: unknown;
  handler: (step: WorkflowCtx, args: any) => Promise<unknown>;
};

/** What replay knows about the run. */
export type Replay = {
  history: HistoryView;
  /** The workflow's args, as the migrations left them. */
  args: unknown;
  /** Whether the run has journal entries: it isn't new. */
  hasHistory: boolean;
  /** The migrations that edited the history in this handler run. */
  editedNow: readonly string[];
  /** For a history whose run is known to have failed: see `threwEarly`. */
  recordedOnly?: boolean;
};

export type ReplayOptions = {
  /** The handler's `step` argument, on the executor's channel. */
  step: WorkflowCtx;
  console: { error: (...args: unknown[]) => void };
  /** Validates ids in the args against the database, as upstream does. */
  db?: GenericDatabaseReader<any>;
};

/**
 * Runs the handler against `replay.history`, racing it against the executor
 * as upstream's workflow mutation does. Returns what upstream's race returns,
 * `handlerDone` or `executorBlocked`, or the `ReplayPause` the run should
 * pause with. Call it inside the replay's environment (`setupEnvironment`).
 */
export async function replayHandler(
  registered: ReplayDefinition,
  replay: Replay,
  executor: StepExecutor,
  options: ReplayOptions,
): Promise<WorkerResult | ReplayPause> {
  const { console } = options;
  const handlerWorker = async (): Promise<WorkerResult> => {
    let runResult: RunResult;
    let validated = false;
    try {
      if (registered.args) {
        validate(asObjectValidator(registered.args as ObjectValidator), replay.args, { throw: true, ...(options.db ? { db: options.db } : {}) });
      }
      validated = true;
      const returnValue = (await registered.handler(options.step, replay.args)) ?? null;
      // Returning before the end of the history is a mismatch.
      const early = returnedEarly(replay.history, executor.progress());
      if (early) throw early;
      runResult = { kind: 'success', returnValue };
      if (registered.returns) {
        try {
          validate(asObjectValidator(registered.returns as ObjectValidator), returnValue, { throw: true });
        } catch (error) {
          const message = error instanceof ValidationError ? error.message : formatErrorWithStack(error);
          console.error('Workflow handler returned invalid return value: ', message);
          runResult = { kind: 'failed', error: `Invalid return value: ${message}` };
        }
      }
    } catch (error) {
      const pause = threwEarly(replay.history, executor.progress(), error, {
        validated,
        hasHistory: replay.hasHistory,
        editedNow: replay.editedNow,
        ...(replay.recordedOnly === undefined ? {} : { recordedOnly: replay.recordedOnly }),
      });
      if (pause) throw pause;
      const message = formatErrorWithStack(error);
      console.error(message);
      runResult = { kind: 'failed', error: message };
    }
    return { type: 'handlerDone', runResult };
  };
  try {
    return await Promise.race([handlerWorker(), executor.run()]);
  } catch (error) {
    if (error instanceof ReplayPause) return error;
    throw error;
  }
}
