// One handler run's replay of the handler against a run's history: upstream's
// handler and executor workers, with the workflow args as the migrations left
// them. The vendored workflow mutation and the /replay helpers both call
// `replayHandler`, so the two can't drift apart. A run that can't replay
// fails, as upstream's does on a journal mismatch; `ReplayError` says why.
import type { WorkpoolOptions } from '@convex-dev/workpool';
import { validate, ValidationError } from 'convex-helpers/validators';
import type { GenericDatabaseReader } from 'convex/server';
import { asObjectValidator, type PropertyValidators, type Validator } from 'convex/values';

import type { StepKind } from './history.ts';
import type { Migration, Prepared } from './migrations.ts';
import { formatErrorWithStack } from './vendor/workflow/shared.ts';
import type { StepExecutor, WorkerResult } from './vendor/workflow/step.ts';
import type { RunResult } from './vendor/workflow/types.ts';
import type { WorkflowCtx } from './vendor/workflow/workflowContext.ts';

/** Why a run can't replay on the current code. */
export type ReplayReason = 'mismatch' | 'args' | 'migration' | 'migrations' | 'record';

/** The run can't replay on the current code: the workflow mutation throws it, and upstream fails the run with its message. */
export class ReplayError extends Error {
  public constructor(
    public readonly reason: ReplayReason,
    message: string,
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

/** The code made a different call at `position` of the history than the step there. */
export class ReplayMismatch extends ReplayError {
  public constructor(position: number, call: string, step: string) {
    super(
      'mismatch',
      `Journal entry mismatch at step ${position} of the run's history, as its migrations leave it: the code calls ${call}, the history has ${step}`,
    );
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

/**
 * Runs the handler on the history's args, racing it against the executor as
 * upstream's workflow mutation does, and returns what upstream's race returns.
 * Throws a `ReplayError` for args that don't pass the `args` validator, for a
 * handler that throws after migrations applied now (`ran`), unless the
 * history's last step failed, and the executor's `ReplayMismatch`. Call it
 * inside the replay's environment (`setupEnvironment`).
 */
export async function replayHandler(
  registered: ReplayDefinition,
  { history, ran }: Pick<Prepared, 'history' | 'ran'>,
  executor: StepExecutor,
  options: { step: WorkflowCtx; console: { error: (...args: unknown[]) => void }; db?: GenericDatabaseReader<any> },
): Promise<WorkerResult> {
  const { console } = options;
  const args = history.workflowArgs as unknown;
  const handlerWorker = async (): Promise<WorkerResult> => {
    try {
      argsValid(registered, args, options.db, true);
    } catch (error) {
      throw new ReplayError('args', `The workflow's args, as its migrations leave them, don't match its args validator: ${message(error)}`);
    }
    let runResult: RunResult;
    try {
      const returnValue = (await registered.handler(options.step, args)) ?? null;
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
      const message = formatErrorWithStack(error);
      console.error(message);
      // Likely a wrong migration: the run fails without saving it as applied, so restart applies the fixed one.
      if (ran.length > 0 && history.steps.at(-1)?.error === undefined) {
        const ids = ran.map((id) => `"${id}"`).join(', ');
        throw new ReplayError('migration', `The handler threw replaying the history as migrations ${ids} leave it: ${message.split('\n')[0]}`);
      }
      runResult = { kind: 'failed', error: message };
    }
    return { type: 'handlerDone', runResult };
  };
  return await Promise.race([handlerWorker(), executor.run()]);
}
