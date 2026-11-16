// How expectReplays() and migrate() from /test replay a history: they call the
// workflow mutation in convex-test with a workflow id from `openReplay`, and
// the mutation hands this request to `replayRequest` instead of loading a run.
// Nothing is loaded, saved or started. Empty, and so inert, outside those
// helpers.
//
// Kept on a global symbol rather than in module state: a test runner can load
// two copies of this package (e.g. its build for the test helper and its
// sources for the app), and both must see the same requests.
import type { WorkpoolOptions } from '@convex-dev/workpool';
import { BaseChannel } from 'async-channel';
import type { GenericDataModel, GenericMutationCtx } from 'convex/server';

import { type HistoryView, type PauseReason, type RecordedHistory, ReplayPause } from './history.ts';
import { editedNow, prepareHistory, type WorkflowMigrations } from './migrations.ts';
import { type ReplayDefinition, replayHandler } from './replay.ts';
import { setupEnvironment } from './vendor/workflow/environment.ts';
import type { WorkflowId } from './vendor/workflow/publicTypes.ts';
import { StepExecutor, type StepRequest } from './vendor/workflow/step.ts';
import type { WorkflowComponent } from './vendor/workflow/types.ts';
import { createWorkflowCtx } from './vendor/workflow/workflowContext.ts';

/** How replaying a history against the current handler went. */
export type ReplayOutcome =
  | { ok: true; history: HistoryView }
  | { ok: false; reason: PauseReason | 'truncated'; detail: string; position?: number; history: HistoryView };

type Request = { history: RecordedHistory; replay: boolean; outcome?: ReplayOutcome };

const PREFIX = 'convex-workflow-migrations-replay:';
const key = Symbol.for('@dev-marzahn/convex-workflow-migrations/replay');
const state = ((globalThis as { [key]?: { next: number; requests: Map<string, Request> } })[key] ??= { next: 0, requests: new Map() });

/**
 * Registers a history to replay (or, with `replay: false`, only migrate). Call
 * the workflow mutation with `{ workflowId, generationNumber: 0 }`, then `take()`.
 */
export function openReplay(history: RecordedHistory, replay: boolean): { workflowId: string; take: () => ReplayOutcome } {
  const workflowId = `${PREFIX}${state.next++}`;
  const request: Request = { history, replay };
  state.requests.set(workflowId, request);
  return {
    workflowId,
    take: () => {
      state.requests.delete(workflowId);
      if (!request.outcome) throw new Error(`The workflow mutation didn't replay ${workflowId}. Is the workflow defined with this package's WorkflowManager?`);
      return request.outcome;
    },
  };
}

/**
 * For the workflow mutation: if it was called with a workflow id that
 * `openReplay` registered, replays that history instead of a handler run, and
 * returns true.
 */
export async function replayRequest(
  ctx: GenericMutationCtx<GenericDataModel>,
  args: { workflowId?: unknown },
  migrations: WorkflowMigrations,
  registered: ReplayDefinition,
  workpoolOptions?: WorkpoolOptions,
): Promise<boolean> {
  const { workflowId } = args;
  const request = typeof workflowId === 'string' && workflowId.startsWith(PREFIX) ? state.requests.get(workflowId) : undefined;
  if (!request) return false;
  request.outcome = await replay(ctx, migrations, registered, request, workpoolOptions);
  return true;
}

/** Thrown where the executor would start a step: replay got as far as the history goes. */
class Frontier extends Error {}

class ReplayOnly extends StepExecutor {
  public override async startSteps(): Promise<never> {
    throw new Frontier();
  }
}

/**
 * Replays the history as the workflow mutation would, with the same
 * `replayHandler`. The differences: the args are checked without the
 * database, so ids are checked only as strings; a handler run that would fail
 * the run passes unless the history says the run succeeded; and for a run
 * that failed, only a throw before its last recorded step fails, since its
 * own failure came after it.
 */
async function replay(
  ctx: GenericMutationCtx<GenericDataModel>,
  migrations: WorkflowMigrations,
  registered: ReplayDefinition,
  request: Request,
  workpoolOptions?: WorkpoolOptions,
): Promise<ReplayOutcome> {
  const { history: recorded } = request;
  const prepared = prepareHistory(recorded.steps, { applied: recorded.applied ?? [], overlay: recorded.overlay ?? [] }, migrations.list, recorded.args ?? {});
  const { history } = prepared;
  const failed = (pause: ReplayPause): ReplayOutcome => ({
    ok: false,
    reason: pause.reason,
    detail: pause.detail,
    ...(pause.position === undefined ? {} : { position: pause.position }),
    history,
  });
  if (prepared.blocked) return failed(prepared.blocked);
  if (!request.replay) return { ok: true, history };
  if (recorded.truncated) {
    const detail = `The history is truncated: the export stopped at ${recorded.steps.length} steps, so the rest of the run can't be checked. Export it with a larger --max-steps.`;
    return { ok: false, reason: 'truncated', detail, history };
  }

  const workflowId = (recorded.workflowId ?? 'history') as WorkflowId;
  const channel = new BaseChannel<StepRequest>(workpoolOptions?.maxParallelism ?? 10);
  const step = createWorkflowCtx(workflowId, channel);
  const now = Math.max(0, ...recorded.steps.map((s) => s.startedAt));
  // Never used: starting a step stops the replay.
  const component = undefined as unknown as WorkflowComponent;
  const executor = new ReplayOnly(workflowId, 0, ctx, component, [], channel, now, workpoolOptions, history);
  const restoreEnvironment = setupEnvironment(executor.getGenerationState.bind(executor), workflowId);
  let result: Awaited<ReturnType<typeof replayHandler>>;
  try {
    result = await replayHandler(
      registered,
      {
        history,
        args: history.workflowArgs,
        hasHistory: recorded.steps.length > 0,
        editedNow: editedNow(prepared),
        // The run failed: a throw after its recorded steps is the one it failed with.
        recordedOnly: recorded.outcome === 'failed' || recorded.outcome === 'canceled',
      },
      executor,
      { step, console: { error: () => {} } },
    );
  } catch (error) {
    if (error instanceof Frontier) return { ok: true, history };
    throw error;
  } finally {
    restoreEnvironment();
  }
  if (result instanceof ReplayPause) return failed(result);
  if (result.type === 'handlerDone' && result.runResult.kind === 'failed' && recorded.outcome === 'success') {
    const error = result.runResult.error.split('\n')[0];
    return failed(new ReplayPause('threw', `The run succeeded, but the handler now fails after replaying its history: ${error}`));
  }
  return { ok: true, history };
}
