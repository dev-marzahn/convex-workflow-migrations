// The replay helpers of /replay. They replay histories without Convex, with
// the workflow mutation's `prepareRun` and `replayHandler`. This module
// imports neither convex-test nor anything that uses import.meta.glob, so
// tests that use only these need no Vitest setup.
import { BaseChannel } from 'async-channel';
import type { FunctionReference, GenericDataModel, GenericMutationCtx, RegisteredMutation } from 'convex/server';
import { type JSONValue, jsonToConvex } from 'convex/values';

import type { History, HistoryStep, RecordedHistory, RecordedStep, StepKind } from './history.ts';
import { type Prepared, prepareRun } from './migrations.ts';
import { argsValid, REPLAY, ReplayError, replayHandler, type ReplayTarget, RULE } from './replay.ts';
import { setupEnvironment } from './vendor/workflow/environment.ts';
import type { WorkflowId } from './vendor/workflow/publicTypes.ts';
import { safeFunctionName } from './vendor/workflow/safeFunctionName.ts';
import { StepExecutor, type StepRequest } from './vendor/workflow/step.ts';
import type { RunResult, WorkflowComponent } from './vendor/workflow/types.ts';
import { createWorkflowCtx } from './vendor/workflow/workflowContext.ts';

type Outcome = { result?: unknown; error?: string; canceled?: true; status?: 'done' | 'running'; startedAt?: number };

/**
 * One step of a hand-built history. Without `result`, `error`, `canceled` or
 * `status: 'running'`, it succeeded with `null`. An event's `args` are
 * `{ eventId }` for an `awaitEvent({ id })`, and `{}` (the default) by name.
 */
export type StepSpec =
  | ({ step: FunctionReference<any, any>; args?: unknown; name?: string } & Outcome)
  | ({ workflow: FunctionReference<'mutation', 'internal'>; args?: unknown; name?: string } & Outcome)
  | ({ event: string; args?: unknown } & Outcome)
  | { sleep: string; status?: 'done' | 'running'; startedAt?: number };

/** Options of `history()`: the workflow's `args` (default `{}`), the migrations `applied` to the run, and its `workflowId` for messages. */
export type HistoryOptions = { args?: unknown; applied?: string[]; workflowId?: string };

/**
 * Builds a history by hand, as older code recorded it. Steps get ids `h0`,
 * `h1`, … and start times 0, 1, …, unless a spec gives `startedAt`. Pass
 * `applied` for a run started on a release that used this package. Without
 * it, it's a run without a record: with steps, every migration applies; with
 * none, its args pick (README, "Testing").
 */
export function history(steps: readonly StepSpec[], options: HistoryOptions = {}): RecordedHistory {
  return {
    ...(options.workflowId === undefined ? {} : { workflowId: options.workflowId }),
    args: options.args ?? {},
    steps: steps.map((spec, i) => specToStep(spec, i)),
    ...(options.applied === undefined ? {} : { applied: options.applied }),
  };
}

function specToStep(spec: StepSpec, i: number): RecordedStep {
  let name: string, kind: StepKind, args: unknown;
  if ('event' in spec) [name, kind, args] = [spec.event, 'event', spec.args ?? {}];
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

/** An exported history (`encoding: 'json'`) with its values decoded with `jsonToConvex`; any other as it is. */
function decoded(recorded: RecordedHistory): RecordedHistory {
  if (recorded.encoding !== 'json') return recorded;
  const value = (encoded: unknown) => (encoded === undefined ? undefined : jsonToConvex(encoded as JSONValue));
  const values = <T extends object>(item: T, keys: readonly string[]) =>
    Object.fromEntries(Object.entries(item).map(([key, field]) => [key, keys.includes(key) ? value(field) : field])) as T;
  return {
    ...recorded,
    args: value(recorded.args),
    steps: recorded.steps.map((step) => ({
      ...step,
      args: value(step.args),
      ...(step.runResult ? { runResult: values(step.runResult, ['returnValue']) } : {}),
    })),
    ...(recorded.overlay ? { overlay: recorded.overlay.map((op) => values(op, ['args', 'result'])) } : {}),
  };
}

/** As the workflow mutation prepares a run, but checking args without the database (ids only as strings), and `strict`. */
function prepare(replay: ReplayTarget, exported: RecordedHistory): Prepared {
  const recorded = decoded(exported);
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
 * doesn't: why the run would pause, by the same rules as at runtime, or that
 * the run would fail, because the handler throws, unless it's passing on a
 * failure among the newest recorded steps (throw rule 4), or because its
 * return value fails its `returns` validator. It starts no step: replay stops
 * where the history ends, or at a running step.
 */
async function replayHistory(replay: ReplayTarget, recorded: RecordedHistory, prepared: Prepared): Promise<string | undefined> {
  const workflowId = (recorded.workflowId ?? 'history') as WorkflowId;
  const channel = new BaseChannel<StepRequest>(replay.workpoolOptions?.maxParallelism ?? 10);
  const now = Math.max(0, ...recorded.steps.map((s) => s.startedAt));
  // Never used: starting a step stops the replay.
  const [ctx, component] = [undefined as unknown as GenericMutationCtx<GenericDataModel>, undefined as unknown as WorkflowComponent];
  const executor = new ReplayOnly(workflowId, 0, ctx, component, [], channel, now, replay.workpoolOptions, prepared.history);
  const restoreEnvironment = setupEnvironment(executor.getGenerationState.bind(executor), workflowId);
  try {
    const options = { step: createWorkflowCtx(workflowId, channel), console: { error: () => {} } };
    const result = await replayHandler(replay.definition, prepared, executor, options);
    if (result instanceof ReplayError) return `(${result.reason}): ${result.message}`;
    if (result.type === 'handlerDone' && result.runResult.kind === 'failed') {
      const error = result.runResult.error.split('\n')[0];
      if (result.invalidReturn) return `(returns): The handler's return value doesn't match its returns validator, which fails the run: ${error}`;
      if (!prepared.history.endsInFailure()) return `(fails): The handler threw replaying the history, which fails the run (${RULE[6]}): ${error}`;
    }
  } catch (error) {
    if (!(error instanceof Frontier)) throw error;
  } finally {
    restoreEnvironment();
  }
  return undefined;
}

/** Why an exported history can't be checked: the export cut it short at --max-steps, or its record and journal may not match. */
function incomplete(recorded: RecordedHistory): string | undefined {
  if (recorded.truncated)
    return `(truncated): The export stopped at ${recorded.steps.length} steps, so the rest can't be checked. Export it with a larger --max-steps.`;
  if (recorded.unstable) return "(unstable): The run's record changed every time the export read its journal, so the two may not match. Export it again.";
  return undefined;
}

/**
 * Replays each history, with the migrations of `workflow` (the mutation
 * `workflow.define` returned), against its current handler, as a handler run
 * would, and throws for those that don't replay, with the reason (for a
 * handler that throws, the throw rule that applies) and the migrated
 * history. An `updateResult` or `updateWorkflowArgs` that changes its own
 * output when run on it again fails too, and so does a handler that throws,
 * unless it's passing on a failure (throw rule 4; README, "Testing"), or
 * returns a value its `returns` validator rejects. A `truncated` or
 * `unstable` history fails, and so does an empty list.
 */
export async function expectReplays(workflow: Workflow, histories: readonly RecordedHistory[]): Promise<void> {
  const replay = target(workflow, 'expectReplays');
  // An empty export checks nothing, which would pass.
  if (histories.length === 0) throw new Error('expectReplays got no histories to check.');
  const failures: string[] = [];
  for (const [i, recorded] of histories.entries()) {
    const label = `history ${i}${recorded.workflowId ? ` (${recorded.workflowId})` : ''}`;
    const cut = incomplete(recorded);
    if (cut) {
      failures.push(`${label} ${cut}`);
      continue;
    }
    let prepared: Prepared;
    try {
      prepared = prepare(replay, recorded);
    } catch (error) {
      if (!(error instanceof ReplayError)) throw error;
      failures.push(`${label} (${error.reason}): ${error.message}`);
      continue;
    }
    const problem = await replayHistory(replay, recorded, prepared);
    if (problem) failures.push(`${label} ${problem}\n  migrated history: ${summary(prepared.history.steps)}`);
  }
  if (failures.length > 0) throw new Error(`${failures.length} of ${histories.length} histories don't replay on the current handler:\n${failures.join('\n')}`);
}

/** The history after the workflow's migrations, for testing a migration. Throws if they can't be applied, or the history is `truncated` or `unstable`. */
export function migrate(workflow: Workflow, recorded: RecordedHistory): History {
  const cut = incomplete(recorded);
  if (cut) throw new Error(cut);
  return prepare(target(workflow, 'migrate'), recorded).history;
}

export type { History, HistoryStep, RecordedHistory, RecordedStep } from './history.ts';
