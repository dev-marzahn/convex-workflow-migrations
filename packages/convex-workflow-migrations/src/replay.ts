// One handler run's replay of the handler against a run's history: upstream's
// handler and executor workers, with the workflow args as the migrations left
// them, and the rules for when the run pauses instead of completing
// (`returnedEarly` and `threwEarly`; README, "Pausing and recovery"). The
// vendored workflow mutation and the /replay helpers both call
// `replayHandler`, so the two can't drift apart.
import type { WorkpoolOptions } from '@convex-dev/workpool';
import { validate, ValidationError } from 'convex-helpers/validators';
import type { GenericDatabaseReader } from 'convex/server';
import { asObjectValidator, convexToJson, type Infer, type PropertyValidators, type Validator, type Value } from 'convex/values';

import { capDetail, type vPauseReason } from './component/schema.ts';
import type { HistoryView, StepKind } from './history.ts';
import type { Migration, Prepared } from './migrations.ts';
import { formatErrorWithStack } from './vendor/workflow/shared.ts';
import type { StepExecutor, WorkerResult } from './vendor/workflow/step.ts';
import type { RunResult } from './vendor/workflow/types.ts';
import type { WorkflowCtx } from './vendor/workflow/workflowContext.ts';

/** Why a run can't replay on the current code, so it pauses. */
export type ReplayReason = Infer<typeof vPauseReason>;

/**
 * The run can't replay on the current code: it pauses. `position` is where in
 * the history, if somewhere. The pause cuts the message (`loadRecord`).
 */
export class ReplayError extends Error {
  public constructor(
    public readonly reason: ReplayReason,
    message: string,
    public readonly position?: number,
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

const MISMATCH = (position: number) => `Journal entry mismatch at step ${position} of the run's history, as its migrations leave it`;

/** The code made a different call at `position` of the history than the step there. Each is cut to `DETAIL_LIMIT`. */
export class ReplayMismatch extends ReplayError {
  public constructor(position: number, call: string, step: string) {
    super('mismatch', `${MISMATCH(position)}: the code calls ${capDetail(call)}, the history has ${capDetail(step)}`, position);
  }
}

/**
 * What the vendored executor compares a call with: a step of the history, or
 * a journal entry the handler run just started, which has no position.
 * `argsKnown` is false for a stand-in inserted without args.
 */
export type ReplayStep = {
  step: { name: string; kind?: StepKind; args: any; inProgress: boolean; runResult?: RunResult };
  argsKnown?: boolean;
  position?: number;
};

/** One step of the history, shaped like a journal entry so the executor compares it unchanged. */
export type ReplayEntry = ReplayStep & { step: { kind: StepKind; startedAt: number }; position: number; argsKnown: boolean };

/** The parts of a workflow definition that replay uses. */
export type ReplayDefinition = { args?: unknown; returns?: unknown; handler: (step: WorkflowCtx, args: any) => Promise<unknown> };

/**
 * What the /replay helpers need to replay a history without Convex, which
 * `WorkflowManager.define` attaches to the workflow mutation. A global
 * symbol, so a test that loads both the build and the sources finds it.
 */
export type ReplayTarget = { definition: ReplayDefinition; migrations: readonly Migration[]; workpoolOptions?: WorkpoolOptions };
export const REPLAY = Symbol.for('@dev-marzahn/convex-workflow-migrations/replay');

type ObjectValidator = PropertyValidators | Validator<any, 'required', any>;
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Whether `args` pass the workflow's `args` validator, if it has one. With
 * `db`, ids are checked against it, as upstream checks them. With `throws`,
 * it throws why they don't pass instead of returning false.
 */
export function argsValid(definition: { args?: unknown }, args: unknown, db?: GenericDatabaseReader<any>, throws = false): boolean {
  return !definition.args || validate(asObjectValidator(definition.args as ObjectValidator), args, { throw: throws, ...(db ? { db } : {}) });
}

/** Where replay got to (the executor's `progress()`): the first step of the history the handler hasn't called, and whether a step past the history started. */
export type ReplayProgress = { next?: { position: number }; started: boolean };

/** A handler that returned before calling every step of its history: a mismatch, with no call to show. */
export function returnedEarly(history: HistoryView, { next }: ReplayProgress): ReplayError | undefined {
  if (!next) return undefined;
  const { args, kind, name } = history.steps[next.position]!;
  const step = capDetail(JSON.stringify(convexToJson({ args, kind, name } as Value)));
  return new ReplayError('mismatch', `${MISMATCH(next.position)}: the code returned before it, the history has ${step}`, next.position);
}

/** The throw rules a pause's `detail` and `expectReplays` name, by their numbers in the README's "Pausing and recovery". */
export const RULE = {
  2: "rule 2: a recorded step is left that the handler hasn't replayed",
  3: 'rule 3: the last step the handler got is a stand-in, or has a result a migration changed',
  5: 'rule 5: migrations edited the history in this handler run',
  6: 'rule 6: no earlier rule applies',
} as const;

/**
 * Whether a handler that threw pauses the run instead of failing it, by the
 * throw rules in the README's "Pausing and recovery", in their order. A
 * pause's message names its rule (`RULE`). With `recordedOnly`, for the
 * history of a run that failed or was canceled after its last step, only
 * rules 1 and 2 apply.
 */
export function threwEarly(
  history: HistoryView,
  progress: ReplayProgress,
  error: unknown,
  edited: readonly string[],
  recordedOnly = false,
): ReplayError | undefined {
  if (error instanceof ReplayError) return error;
  if (progress.started) return undefined; // rule 1
  const next = progress.next?.position ?? history.length;
  if (history.recordedFrom(next)) return new ReplayError('threw', `The handler threw before step ${next} of its history (${RULE[2]}): ${message(error)}`, next);
  if (recordedOnly) return undefined;
  if (next > 0 && history.fromMigration(next - 1)) {
    return new ReplayError('threw', `The handler threw after step ${next - 1} of its history (${RULE[3]}): ${message(error)}`, next - 1);
  }
  if (history.endsInFailure()) return undefined; // rule 4
  if (edited.length > 0) {
    const ids = edited.map((id) => `"${id}"`).join(', ');
    return new ReplayError('threw', `The handler threw after migrations ${ids} changed its history (${RULE[5]}): ${message(error)}`);
  }
  return undefined; // rule 6
}

/** What upstream's race returns; `invalidReturn` marks a failure from the `returns` validator, not a throw. */
export type ReplayResult = WorkerResult & { invalidReturn?: true };

/**
 * Runs the handler on the history's args, racing it against the executor as
 * upstream's workflow mutation does. Returns what upstream's race returns, or
 * the `ReplayError` the run pauses with, after halting the executor so that
 * it starts no step. Call it inside the replay's environment
 * (`setupEnvironment`).
 */
export async function replayHandler(
  registered: ReplayDefinition,
  { history, edited, recordedOnly }: Pick<Prepared, 'history' | 'edited'> & { recordedOnly?: boolean },
  executor: StepExecutor,
  options: { step: WorkflowCtx; console: { error: (...args: unknown[]) => void }; db?: GenericDatabaseReader<any> },
): Promise<ReplayResult | ReplayError> {
  const { console } = options;
  const args = history.workflowArgs as unknown;
  const handlerWorker = async (): Promise<ReplayResult> => {
    try {
      argsValid(registered, args, options.db, true);
    } catch (error) {
      throw new ReplayError('args', `The workflow's args, as its migrations leave them, don't match its args validator: ${message(error)}`);
    }
    let runResult: RunResult;
    try {
      const returnValue = (await registered.handler(options.step, args)) ?? null;
      const early = returnedEarly(history, executor.progress());
      if (early) throw early;
      runResult = { kind: 'success', returnValue };
      if (registered.returns) {
        try {
          validate(asObjectValidator(registered.returns as ObjectValidator), returnValue, { throw: true });
        } catch (error) {
          const message = error instanceof ValidationError ? error.message : formatErrorWithStack(error);
          console.error('Workflow handler returned invalid return value: ', message);
          return { type: 'handlerDone', runResult: { kind: 'failed', error: `Invalid return value: ${message}` }, invalidReturn: true };
        }
      }
    } catch (error) {
      const pause = threwEarly(history, executor.progress(), error, edited, recordedOnly);
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
    if (!(error instanceof ReplayError)) throw error;
    executor.halted = true;
    return error;
  }
}
