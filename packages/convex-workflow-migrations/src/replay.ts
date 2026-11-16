// One handler run's replay of the handler against a run's history, and the
// rules for when it pauses the run instead of completing it (README, "Pausing
// and recovery"): `returnedEarly` and `threwEarly`. The vendored workflow
// mutation and expectReplays() in /test both call `replayHandler`, so the two
// can't drift apart.
import type { WorkpoolOptions } from '@convex-dev/workpool';
import { validate, ValidationError } from 'convex-helpers/validators';
import type { GenericDatabaseReader } from 'convex/server';
import { asObjectValidator, convexToJson, type PropertyValidators, type Validator, type Value } from 'convex/values';

import { type HistoryView, ReplayPause } from './history.ts';
import type { Migration } from './migrations.ts';
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

/**
 * What `expectReplays()` and `migrate()` in /test need to replay a history
 * without Convex: `WorkflowManager.define` attaches it to the workflow
 * mutation under `REPLAY`. A global symbol, so a test that loads two copies
 * of this package (its build and its sources) still finds it.
 */
export type ReplayTarget = { definition: ReplayDefinition; migrations: readonly Migration[]; workpoolOptions?: WorkpoolOptions };
export const REPLAY = Symbol.for('@dev-marzahn/convex-workflow-migrations/replay');

/** What replay knows about the run. */
export type Replay = {
  history: HistoryView;
  /** The workflow's args, as the migrations left them. */
  args: unknown;
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether `args` pass the workflow's `args` validator, if it has one. With `db`, ids are checked against it, as upstream's handler run checks them. */
export function argsValid(definition: { args?: unknown }, args: unknown, db?: GenericDatabaseReader<any>): boolean {
  if (!definition.args) return true;
  return validate(asObjectValidator(definition.args as ObjectValidator), args, db ? { db } : {});
}

/** Where replay got to when the handler threw or returned: the first history step it hasn't called, and whether it started a step past the history. */
export type ReplayProgress = { next?: { position: number }; started: boolean };

/**
 * Whether a handler that returned should pause the run instead of
 * completing it: it returned before calling every step of its history.
 * There's no call to show, only the step the history has there.
 */
export function returnedEarly(history: HistoryView, progress: ReplayProgress): ReplayPause | undefined {
  const next = progress.next;
  if (!next) return undefined;
  const step = history.steps[next.position]!;
  const recorded = JSON.stringify(convexToJson({ args: step.args, kind: step.kind, name: step.name } as Value));
  return new ReplayPause(
    'mismatch',
    `Journal entry mismatch at step ${next.position}: the code returned before it, the history has ${recorded}`,
    next.position,
  );
}

/**
 * What `threwEarly` knows about the handler run: whether the args validated,
 * which migrations edited its history in this handler run, and whether only
 * an unreplayed recorded step counts (for a history whose run is known to
 * have failed).
 */
export type ThrowContext = { validated: boolean; editedNow: readonly string[]; recordedOnly?: boolean };

/**
 * Whether a handler that threw should pause the run instead of failing it,
 * by the rules in the README's "Pausing and recovery", in their order. Args
 * that don't validate pause the run: the workflow mutation refuses args that
 * don't validate when it creates a run, so they're from older code.
 * Otherwise, the run:
 *
 * 1. fails if the handler run started a step past the history, since that
 *    step's writes commit;
 * 2. pauses if a recorded step is left that the handler hasn't replayed;
 * 3. pauses if the last step it got is a stand-in, or has a result a
 *    migration changed;
 * 4. fails if the newest recorded steps (the journal entries started in the
 *    last handler run that started steps) include one still in the history
 *    that failed or was canceled and that no migration rewrote: the handler
 *    is passing that failure on;
 * 5. pauses if migrations edited its history in this handler run;
 * 6. fails otherwise.
 *
 * With `recordedOnly` (a history whose run is known to have failed), only
 * rules 1 and 2 apply.
 */
export function threwEarly(history: HistoryView, progress: ReplayProgress, error: unknown, context: ThrowContext): ReplayPause | undefined {
  if (error instanceof ReplayPause) return error;
  if (!context.validated) return new ReplayPause('args', `The workflow's args don't match its args validator: ${message(error)}`);
  if (progress.started) return undefined;
  const next = progress.next?.position ?? history.length;
  if (history.recordedFrom(next)) {
    return new ReplayPause('threw', `The handler threw before step ${next} of its history: ${message(error)}`, next);
  }
  if (context.recordedOnly) return undefined;
  if (next > 0 && history.fromMigration(next - 1)) {
    return new ReplayPause(
      'threw',
      `The handler threw after step ${next - 1} of its history, which a migration inserted or changed: ${message(error)}`,
      next - 1,
    );
  }
  if (history.endsInFailure()) return undefined;
  if (context.editedNow.length > 0) {
    const ids = context.editedNow.map((id) => `"${id}"`).join(', ');
    return new ReplayPause('threw', `The handler threw after migrations ${ids} changed its history: ${message(error)}`);
  }
  return undefined;
}

/**
 * Runs the handler against `replay.history`, racing it against the executor
 * as upstream's workflow mutation does. Returns what upstream's race returns,
 * `handlerDone` or `executorBlocked`, or the `ReplayPause` the run should
 * pause with, after halting the executor, so it starts no step. Call it
 * inside the replay's environment (`setupEnvironment`).
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
        editedNow: replay.editedNow,
        ...(replay.recordedOnly === undefined ? {} : { recordedOnly: replay.recordedOnly }),
      });
      if (pause) {
        // Before anything else runs: another branch of the handler, as in a Promise.all, may still call a step.
        executor.halted = true;
        throw pause;
      }
      const message = formatErrorWithStack(error);
      console.error(message);
      runResult = { kind: 'failed', error: message };
    }
    return { type: 'handlerDone', runResult };
  };
  try {
    return await Promise.race([handlerWorker(), executor.run()]);
  } catch (error) {
    if (error instanceof ReplayPause) {
      executor.halted = true;
      return error;
    }
    throw error;
  }
}
