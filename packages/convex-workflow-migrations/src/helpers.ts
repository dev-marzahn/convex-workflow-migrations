// The replay helpers, served at @dev-marzahn/convex-workflow-migrations/replay
// and re-exported from /test. They replay histories without Convex, so this
// module imports neither convex-test nor anything that uses import.meta.glob:
// tests that use only these need no Vitest configuration
// (tests/exports.test.ts checks that).
import type { FunctionReference, RegisteredMutation } from 'convex/server';

import type { History, HistoryStep, RecordedHistory, RecordedStep, StepKind } from './history.ts';
import type { Prepared } from './migrations.ts';
import { REPLAY, type ReplayTarget } from './replay.ts';
import { replayHistory } from './testing.ts';
import { safeFunctionName } from './vendor/workflow/safeFunctionName.ts';
import type { RunResult } from './vendor/workflow/types.ts';

type Outcome = { result?: unknown; error?: string; canceled?: true; status?: 'done' | 'running'; startedAt?: number };

/**
 * One step of a hand-built history. A step without `result`, `error`,
 * `canceled` or `status: 'running'` succeeded with `null`. `startedAt`
 * defaults to the step's position; give steps one handler run started
 * together the same one.
 */
export type StepSpec =
  | ({ step: FunctionReference<any, any>; args?: unknown; name?: string } & Outcome)
  | ({ workflow: FunctionReference<'mutation', 'internal'>; args?: unknown; name?: string } & Outcome)
  | ({ event: string } & Outcome)
  | { sleep: string; status?: 'done' | 'running'; startedAt?: number };

/** Options of `history()`: the workflow's `args` (default `{}`), the migrations `applied` to the run, its `workflowId` for messages, and its `outcome` if it finished. */
export type HistoryOptions = { args?: unknown; applied?: string[]; workflowId?: string; outcome?: RunResult['kind'] };

/**
 * Builds a history by hand, as older code recorded it:
 *
 * ```ts
 * history([{ step: internal.pipeline.grab, args: { grabId }, result: null }, { event: 'downloadDone', status: 'running' }], { args: { grabId } });
 * ```
 *
 * Steps get ids `h0`, `h1`, … and start times 0, 1, …. Without `applied`,
 * it's a run without a record: with steps, a run from before the first
 * migration, so every migration applies; with none, its args pick, as for a
 * queued child workflow (README, "Testing").
 */
export function history(steps: readonly StepSpec[], options: HistoryOptions = {}): RecordedHistory {
  return {
    ...(options.workflowId === undefined ? {} : { workflowId: options.workflowId }),
    args: options.args ?? {},
    steps: steps.map((spec, i) => recordedStep(spec, i)),
    ...(options.applied === undefined ? {} : { applied: options.applied }),
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
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
  if (outcome.status !== 'running') {
    if (outcome.canceled) runResult = { kind: 'canceled' };
    else runResult = outcome.error !== undefined ? { kind: 'failed', error: outcome.error } : { kind: 'success', returnValue: outcome.result ?? null };
  }
  return { id: `h${i}`, name, kind, args, ...(runResult ? { runResult } : {}), startedAt: outcome.startedAt ?? i };
}

function summary(steps: readonly HistoryStep[]): string {
  return steps.map((step, i) => `${i}: ${step.name}${step.status === 'done' ? '' : ` (${step.status})`}`).join(', ') || 'no steps';
}

/** A workflow mutation that `WorkflowManager.define` returned. */
type Workflow = RegisteredMutation<'internal', any, any>;

function target(workflow: Workflow, helper: string): ReplayTarget {
  const found = (workflow as unknown as { [REPLAY]?: ReplayTarget } | undefined)?.[REPLAY];
  if (!found)
    throw new Error(`${helper} takes a workflow that this package's WorkflowManager defined: the mutation workflow.define returned, not a function reference.`);
  return found;
}

/** The migrations each history `migrate()` returned had applied, with how many edits each made, for `expectEdits`. */
const migrated = new WeakMap<History, Prepared['ran']>();

/**
 * Replays each history, with the workflow's migrations, against its current
 * handler, by the rules a handler run follows (README, "Pausing and
 * recovery"): a mismatch, an early return, a throw that would pause the
 * run, args that don't validate and a migration that throws all fail, and so
 * does an `updateResult` that changes its own output when run on it again.
 * Runs no steps, and needs no Convex backend: replay stops where the history
 * ends or at a running step. A handler run that would fail the run passes,
 * unless the history's `outcome` says the run succeeded. A `truncated` or
 * `unstable` history fails. Throws if a history doesn't replay, with the
 * history, the position, and the call the code made and the step the history
 * has there.
 *
 * ```ts
 * import { run } from './pipeline';
 * await expectReplays(run, histories);
 * ```
 */
export async function expectReplays(workflow: Workflow, histories: readonly RecordedHistory[]): Promise<void> {
  const replay = target(workflow, 'expectReplays');
  const failures: string[] = [];
  for (const [i, recorded] of histories.entries()) {
    const outcome = await replayHistory(replay, recorded, true);
    if (outcome.ok) continue;
    const label = `history ${i}${recorded.workflowId ? ` (${recorded.workflowId})` : ''}`;
    failures.push(`${label} (${outcome.reason}): ${outcome.detail}\n  migrated history: ${summary(outcome.history.steps)}`);
  }
  if (failures.length > 0) {
    const name = histories.find((h) => h.workflow !== undefined)?.workflow;
    throw new Error(`${failures.length} of ${histories.length} histories don't replay on ${name ?? 'the current handler'}:\n${failures.join('\n')}`);
  }
}

/**
 * The history after the workflow's migrations, for testing a migration.
 * Throws if they can't be applied (an `updateResult` that changes its own
 * output when run on it again included), or the history is `truncated` or
 * `unstable`.
 */
export async function migrate(workflow: Workflow, recorded: RecordedHistory): Promise<History> {
  const outcome = await replayHistory(target(workflow, 'migrate'), recorded, false);
  if (!outcome.ok) throw new Error(outcome.detail);
  migrated.set(outcome.history, outcome.ran);
  return outcome.history;
}

/**
 * Throws unless the migrations that `migrate()` applied each changed the
 * history, or, with `ids`, unless those ones ran and did. Catches a migration
 * that names a step by a name the history doesn't have, which does nothing.
 * Without `ids`, it also throws when no migration ran, because the history
 * has them all applied:
 *
 * ```ts
 * await expectEdits(migrate(run, release2Done), ['prepare-becomes-transcode']);
 * ```
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
