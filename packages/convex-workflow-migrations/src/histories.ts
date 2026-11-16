// What the `histories` CLI reads from a deployment, through a `convex run`
// per query: which runs to export, and each run's history. Kept apart from
// src/cli.ts, which runs on import, so tests can drive it with a fake query.
import { FORMAT } from './component/schema.ts';
import type { OverlayOp, RecordedHistory, RecordedStep, StepKind } from './history.ts';
import type { RunResult } from './vendor/workflow/types.ts';

/** Runs a query of a component and returns its result. */
export type Query = <T>(component: string, path: string, args: object) => T;

type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
export type PublicWorkflow = { workflowId: string; name?: string; args: unknown; runResult?: RunResult };
type WorkflowStep = { stepId: string; name: string; kind: StepKind; args: unknown; runResult?: RunResult; startedAt: number };
type RunRecord = { applied: string[]; overlay: OverlayOp[]; restart?: string; format: number } | null;

/**
 * The runs of workflow `name` to export: every running one and the `recent`
 * newest finished ones, among the newest `maxRuns`. `more` is whether the
 * workflow has more runs than that, and `oldest` the oldest it looked at.
 * It asks for one run more than `maxRuns`, so exactly `maxRuns` isn't more.
 */
export function collectRuns(
  query: Query,
  component: string,
  name: string,
  { maxRuns, recent }: { maxRuns: number; recent: number },
): { runs: PublicWorkflow[]; scanned: number; more: boolean; oldest?: string } {
  const seen: PublicWorkflow[] = [];
  let done = false;
  let cursor: string | null = null;
  // Upstream has no index by status, so this pages through the runs newest first.
  while (seen.length <= maxRuns) {
    const numItems = Math.min(100, maxRuns + 1 - seen.length);
    const result: Page<PublicWorkflow> = query(component, 'workflow:listByName', { name, order: 'desc', paginationOpts: { numItems, cursor } });
    seen.push(...result.page);
    if (result.isDone) {
      done = true;
      break;
    }
    cursor = result.continueCursor;
  }
  const scanned = seen.slice(0, maxRuns);
  const runs: PublicWorkflow[] = [];
  let finished = 0;
  for (const run of scanned) {
    if (run.runResult === undefined) runs.push(run);
    else if (finished < recent) {
      finished++;
      runs.push(run);
    }
  }
  const oldest = scanned.at(-1)?.workflowId;
  return { runs, scanned: scanned.length, more: !done || seen.length > maxRuns, ...(oldest === undefined ? {} : { oldest }) };
}

/**
 * A run's history: its first `maxSteps` journal entries, marked `truncated`
 * if it has more, and, if it has a record, the migrations applied to it, its
 * overlay and a pending `restart`. Throws for a record from a newer version.
 */
export function runHistory(
  query: Query,
  components: { workflow: string; migrations?: string },
  name: string,
  run: PublicWorkflow,
  maxSteps: number,
): RecordedHistory {
  // One more than maxSteps, so a run with exactly maxSteps isn't truncated.
  const steps: Page<WorkflowStep> = query(components.workflow, 'workflow:listSteps', {
    workflowId: run.workflowId,
    order: 'asc',
    paginationOpts: { numItems: maxSteps + 1, cursor: null },
  });
  const record: RunRecord = components.migrations === undefined ? null : query(components.migrations, 'runs:load', { workflowId: run.workflowId });
  if (record && record.format > FORMAT) {
    throw new Error(
      `Run ${run.workflowId}'s record has format ${record.format}, from a newer version of @dev-marzahn/convex-workflow-migrations than this one, which reads format ${FORMAT}. Install the version the deployment runs.`,
    );
  }
  return {
    workflowId: run.workflowId,
    workflow: name,
    args: run.args,
    steps: steps.page.slice(0, maxSteps).map((step): RecordedStep => ({
      id: step.stepId,
      name: step.name,
      kind: step.kind,
      args: step.args,
      ...(step.runResult ? { runResult: step.runResult } : {}),
      startedAt: step.startedAt,
    })),
    ...(record ? { applied: record.applied, overlay: record.overlay } : {}),
    ...(record?.restart === undefined ? {} : { restart: record.restart }),
    ...(run.runResult ? { outcome: run.runResult.kind } : {}),
    ...(steps.page.length > maxSteps || !steps.isDone ? { truncated: true } : {}),
  };
}
