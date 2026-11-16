// The replay helpers of /replay, re-exported from /test. They replay histories
// without Convex, with the workflow mutation's `prepareRun` and
// `replayHandler`. This module imports neither convex-test nor anything that
// uses import.meta.glob, so tests that use only these need no Vitest setup.
import { BaseChannel } from 'async-channel';
import type { FunctionReference, GenericDataModel, GenericMutationCtx, RegisteredMutation } from 'convex/server';

import type { History, HistoryStep, HistoryView, RecordedHistory, RecordedStep, StepKind } from './history.ts';
import { type Prepared, prepareRun } from './migrations.ts';
import { argsValid, REPLAY, ReplayError, replayHandler, type ReplayTarget } from './replay.ts';
import { setupEnvironment } from './vendor/workflow/environment.ts';
import type { WorkflowId } from './vendor/workflow/publicTypes.ts';
import { safeFunctionName } from './vendor/workflow/safeFunctionName.ts';
import { StepExecutor, type StepRequest } from './vendor/workflow/step.ts';
import type { RunResult, WorkflowComponent } from './vendor/workflow/types.ts';
import { createWorkflowCtx } from './vendor/workflow/workflowContext.ts';

type Outcome = { result?: unknown; error?: string; canceled?: true; status?: 'done' | 'running'; startedAt?: number };

/** One step of a hand-built history. Without `result`, `error`, `canceled` or `status: 'running'`, it succeeded with `null`. */
export type StepSpec =
  | ({ step: FunctionReference<any, any>; args?: unknown; name?: string } & Outcome)
  | ({ workflow: FunctionReference<'mutation', 'internal'>; args?: unknown; name?: string } & Outcome)
  | ({ event: string } & Outcome)
  | { sleep: string; status?: 'done' | 'running'; startedAt?: number };

/** Options of `history()`: the workflow's `args` (default `{}`), the migrations `applied` to the run, and its `workflowId` for messages. */
export type HistoryOptions = { args?: unknown; applied?: string[]; workflowId?: string };

/**
 * Builds a history by hand, as older code recorded it. Steps get ids `h0`,
 * `h1`, … and start times 0, 1, …. Without `applied`, it's a run without a
 * record: with steps, from before the first migration; with none, its args
 * pick (README, "Testing").
 */
export function history(steps: readonly StepSpec[], options: HistoryOptions = {}): RecordedHistory {
  return {
    ...(options.workflowId === undefined ? {} : { workflowId: options.workflowId }),
    args: options.args ?? {},
    steps: steps.map((spec, i) => recordedStep(spec, i)),
    ...(options.applied === undefined ? {} : { applied: options.applied }),
  };
}

function recordedStep(spec: StepSpec, i: number): RecordedStep {
  let name: string, kind: StepKind, args: unknown;
  if ('event' in spec) [name, kind, args] = [spec.event, 'event', {}];
  else if ('sleep' in spec) [name, kind, args] = [spec.sleep, 'sleep', {}];
  else if ('workflow' in spec) [name, kind, args] = [spec.name ?? safeFunctionName(spec.workflow), 'workflow', spec.args ?? {}];
  else [name, kind, args] = [spec.name ?? safeFunctionName(spec.step), 'function', spec.args ?? {}];
  const outcome = spec as Outcome;
  let runResult: RunResult | undefined;
  if (outcome.canceled) runResult = { kind: 'canceled' };
  else if (outcome.error !== undefined) runResult = { kind: 'failed', error: outcome.error };
  else if (outcome.status !== 'running') runResult = { kind: 'success', returnValue: outcome.result ?? null };
  return { id: `h${i}`, name, kind, args, ...(runResult ? { runResult } : {}), startedAt: outcome.startedAt ?? i };
}

const summary = (steps: readonly HistoryStep[]) =>
  steps.map((step, i) => `${i}: ${step.name}${step.status === 'done' ? '' : ` (${step.status})`}`).join(', ') || 'no steps';

/** A workflow mutation that `WorkflowManager.define` returned. */
type Workflow = RegisteredMutation<'internal', any, any>;

function target(workflow: Workflow, helper: string): ReplayTarget {
  const found = (workflow as unknown as { [REPLAY]?: ReplayTarget } | undefined)?.[REPLAY];
  if (!found)
    throw new Error(`${helper} takes a workflow that this package's WorkflowManager defined: the mutation workflow.define returned, not a function reference.`);
  return found;
}

/** As the workflow mutation prepares a run, but checking args without the database (ids only as strings), and `strict`. */
function prepare(replay: ReplayTarget, recorded: RecordedHistory): Prepared {
  const stored = { applied: recorded.applied, overlay: recorded.overlay ?? [] };
  const valid = (args: unknown) => argsValid(replay.definition, args);
  return prepareRun(recorded.steps, stored, replay.migrations, recorded.args ?? {}, valid, { strict: true });
}

/** Thrown where the executor would start a step: replay got as far as the history goes. */
class Frontier extends Error {}

class ReplayOnly extends StepExecutor {
  public override async startSteps(): Promise<never> {
    throw new Frontier();
  }
}

/**
 * Replays the migrated history, and returns why it doesn't replay, if it
 * doesn't. It starts no step: replay stops where the history ends, or at a
 * running step. A handler that throws fails it, unless the history's last
 * step failed or was canceled, which the handler may be passing on.
 */
async function replayHistory(replay: ReplayTarget, recorded: RecordedHistory, history: HistoryView): Promise<string | undefined> {
  const workflowId = (recorded.workflowId ?? 'history') as WorkflowId;
  const channel = new BaseChannel<StepRequest>(replay.workpoolOptions?.maxParallelism ?? 10);
  const now = Math.max(0, ...recorded.steps.map((s) => s.startedAt));
  // Never used: starting a step stops the replay.
  const [ctx, component] = [undefined as unknown as GenericMutationCtx<GenericDataModel>, undefined as unknown as WorkflowComponent];
  const executor = new ReplayOnly(workflowId, 0, ctx, component, [], channel, now, replay.workpoolOptions, history);
  const restoreEnvironment = setupEnvironment(executor.getGenerationState.bind(executor), workflowId);
  try {
    const options = { step: createWorkflowCtx(workflowId, channel), console: { error: () => {} } };
    const result = await replayHandler(replay.definition, history.workflowArgs, executor, options);
    if (result.type === 'handlerDone' && result.runResult.kind === 'failed' && history.steps.at(-1)?.error === undefined) {
      return `(threw): The handler threw replaying the history: ${result.runResult.error.split('\n')[0]}`;
    }
  } catch (error) {
    if (error instanceof ReplayError) return `(${error.reason}): ${error.message}`;
    if (!(error instanceof Frontier)) throw error;
  } finally {
    restoreEnvironment();
  }
  return undefined;
}

/**
 * Replays each history, with the migrations of `workflow` (the mutation
 * `workflow.define` returned), against its current handler, as a handler run
 * would, and throws for those that don't replay, with the reason and the
 * migrated history. An `updateResult` that changes its own output when run
 * on it again fails too, and so does a handler that throws (README, "Testing").
 */
export async function expectReplays(workflow: Workflow, histories: readonly RecordedHistory[]): Promise<void> {
  const replay = target(workflow, 'expectReplays');
  const failures: string[] = [];
  for (const [i, recorded] of histories.entries()) {
    const label = `history ${i}${recorded.workflowId ? ` (${recorded.workflowId})` : ''}`;
    let prepared: Prepared;
    try {
      prepared = prepare(replay, recorded);
    } catch (error) {
      if (!(error instanceof ReplayError)) throw error;
      failures.push(`${label} (${error.reason}): ${error.message}`);
      continue;
    }
    const problem = await replayHistory(replay, recorded, prepared.history);
    if (problem) failures.push(`${label} ${problem}\n  migrated history: ${summary(prepared.history.steps)}`);
  }
  if (failures.length > 0) throw new Error(`${failures.length} of ${histories.length} histories don't replay on the current handler:\n${failures.join('\n')}`);
}

/** The migrations each history `migrate()` returned had applied, with how many edits each made, for `expectEdits`. */
const migrated = new WeakMap<History, Prepared['ran']>();

/** The history after the workflow's migrations, for testing a migration. Throws if they can't be applied. */
export async function migrate(workflow: Workflow, recorded: RecordedHistory): Promise<History> {
  const { history, ran } = prepare(target(workflow, 'migrate'), recorded);
  migrated.set(history, ran);
  return history;
}

/**
 * Throws unless the migrations that `migrate()` applied each changed the
 * history, or, with `ids`, unless those ones ran and did: a migration that
 * names a step the history doesn't have does nothing. Without `ids`, it also
 * throws when no migration ran.
 */
export async function expectEdits(history: History | Promise<History>, ids?: readonly string[]): Promise<void> {
  const resolved = await history;
  const ran = migrated.get(resolved);
  if (!ran) throw new Error('expectEdits takes the history migrate() returns.');
  const edits = new Map(ran.map((m) => [m.id, m.edits]));
  const problems = (ids ?? [...edits.keys()]).flatMap((id) => {
    const count = edits.get(id);
    if (count === undefined) return [`"${id}" didn't run: it isn't in the workflow's list, or the history has it applied already`];
    return count === 0 ? [`"${id}" changed nothing: the steps it names aren't in the history by those names`] : [];
  });
  if (ids === undefined && edits.size === 0) problems.push('no migration ran: the history has them all applied');
  if (problems.length > 0) throw new Error(`Migrations didn't edit the history: ${problems.join('; ')}.\n  migrated history: ${summary(resolved.steps)}`);
}

export type { History, HistoryStep, RecordedHistory, RecordedStep } from './history.ts';
