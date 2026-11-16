/// <reference types="vite/client" />
import workflowTest from '@convex-dev/workflow/test';
import type { TestConvex } from 'convex-test';
import type { FunctionReference, GenericSchema, SchemaDefinition } from 'convex/server';

import schema from './component/schema.ts';
import type { History, HistoryStep, RecordedHistory, RecordedStep, RunResult, StepKind } from './history.ts';
import { openReplay, type ReplayOutcome } from './testing.ts';
import { safeFunctionName } from './vendor/workflow/safeFunctionName.ts';

// Matches the sources when run from src/ and the build when run from dist/.
const modules = import.meta.glob(['./component/**/*.{ts,js}', '!./component/**/*.d.ts']);

/**
 * Registers `@convex-dev/workflow` (with its workpool) and the migrations
 * component with a convex-test instance, under the names `convex.config.ts`
 * gives them.
 */
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  names: { workflow?: string; migrations?: string } = {},
): void {
  workflowTest.register(t, names.workflow ?? 'workflow');
  t.registerComponent(names.migrations ?? 'workflowMigrations', schema, modules);
}

type Outcome = { result?: unknown; error?: string; status?: 'done' | 'running' };

/** One step of a hand-built history. A step without `result`, `error` or `status: 'running'` succeeded with `null`. */
export type StepSpec =
  | ({ step: FunctionReference<any, any>; args?: unknown; name?: string } & Outcome)
  | ({ workflow: FunctionReference<'mutation', 'internal'>; args?: unknown; name?: string } & Outcome)
  | ({ event: string } & Outcome)
  | { sleep: string; status?: 'done' | 'running' };

/**
 * Builds a history by hand, as older code recorded it:
 *
 * ```ts
 * history([{ step: internal.pipeline.grab, args: { grabId }, result: null }, { event: 'downloadDone', status: 'running' }], { args: { grabId } });
 * ```
 *
 * `args` are the workflow's arguments. Without `applied`, every migration
 * applies to it, as to a run from before the first one.
 */
export function history(steps: readonly StepSpec[], options: { args?: unknown; applied?: string[]; workflowId?: string } = {}): RecordedHistory {
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
  if (outcome.status !== 'running') {
    runResult = outcome.error !== undefined ? { kind: 'failed', error: outcome.error } : { kind: 'success', returnValue: outcome.result ?? null };
  }
  return { id: `h${i}`, name, kind, args, ...(runResult ? { runResult } : {}), startedAt: i };
}

function summary(steps: readonly HistoryStep[]): string {
  return steps.map((step, i) => `${i}: ${step.name}${step.status === 'done' ? '' : ` (${step.status})`}`).join(', ') || 'no steps';
}

async function run(
  t: TestConvex<any>,
  workflow: FunctionReference<'mutation', 'internal'>,
  recorded: RecordedHistory,
  replay: boolean,
): Promise<ReplayOutcome> {
  const request = openReplay(recorded, replay);
  await t.mutation(workflow, { workflowId: request.workflowId, generationNumber: 0 } as never);
  return request.take();
}

/**
 * Replays each history, with the workflow's migrations, against its current
 * handler, in convex-test. Runs no steps: replay stops where the history
 * ends or at a running step.
 * Throws if a history doesn't replay, with the history, the position, and the
 * call the code made and the step the history has there.
 */
export async function expectReplays(
  t: TestConvex<any>,
  workflow: FunctionReference<'mutation', 'internal'>,
  histories: readonly RecordedHistory[],
): Promise<void> {
  const failures: string[] = [];
  for (const [i, recorded] of histories.entries()) {
    const outcome = await run(t, workflow, recorded, true);
    if (outcome.ok) continue;
    const label = `history ${i}${recorded.workflowId ? ` (${recorded.workflowId})` : ''}`;
    failures.push(`${label}: ${outcome.detail}\n  migrated history: ${summary(outcome.history.steps)}`);
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${histories.length} histories don't replay on ${safeFunctionName(workflow)}:\n${failures.join('\n')}`);
  }
}

/** The history after the workflow's migrations, for testing a migration. Throws if they can't be applied. */
export async function migrate(t: TestConvex<any>, workflow: FunctionReference<'mutation', 'internal'>, recorded: RecordedHistory): Promise<History> {
  const outcome = await run(t, workflow, recorded, false);
  if (!outcome.ok) throw new Error(outcome.detail);
  return outcome.history;
}

export type { History, HistoryStep, RecordedHistory, RecordedStep } from './history.ts';

export default { register, schema, modules };
