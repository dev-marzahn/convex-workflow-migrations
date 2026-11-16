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

import { type HistoryView, type RecordedHistory, ReplayMismatch } from './history.ts';
import { prepareHistory, type WorkflowPatches } from './migrations.ts';
import { setupEnvironment } from './vendor/workflow/environment.ts';
import type { WorkflowId } from './vendor/workflow/publicTypes.ts';
import { StepExecutor, type StepRequest } from './vendor/workflow/step.ts';
import type { WorkflowComponent } from './vendor/workflow/types.ts';
import { createWorkflowCtx } from './vendor/workflow/workflowContext.ts';

/** How replaying a history against the current handler went. */
export type ReplayOutcome =
  | { ok: true; history: HistoryView }
  | { ok: false; reason: 'mismatch' | 'migration' | 'migrations' | 'threw'; detail: string; position?: number; history: HistoryView };

type Request = { history: RecordedHistory; replay: boolean; outcome?: ReplayOutcome };
type Handler = (step: ReturnType<typeof createWorkflowCtx>, args: any) => Promise<unknown>;

const PREFIX = 'convex-workflow-patches-replay:';
const key = Symbol.for('@dev-marzahn/convex-workflow-patches/replay');
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

/** The replay to run instead of the handler run, if `workflowId` is one `openReplay` registered. */
export function replayRequest(
  workflowId: string,
):
  | ((
      ctx: GenericMutationCtx<GenericDataModel>,
      patches: WorkflowPatches,
      registered: { handler: Handler },
      workpoolOptions?: WorkpoolOptions,
    ) => Promise<void>)
  | undefined {
  const request = workflowId.startsWith(PREFIX) ? state.requests.get(workflowId) : undefined;
  if (!request) return undefined;
  return async (ctx, patches, registered, workpoolOptions) => {
    request.outcome = await replay(ctx, patches, registered.handler, request, workpoolOptions);
  };
}

/** Thrown where the executor would start a step: replay got as far as the history goes. */
class Frontier extends Error {}

class ReplayOnly extends StepExecutor {
  public override async startSteps(): Promise<never> {
    throw new Frontier();
  }
}

async function replay(
  ctx: GenericMutationCtx<GenericDataModel>,
  patches: WorkflowPatches,
  handler: Handler,
  request: Request,
  workpoolOptions?: WorkpoolOptions,
): Promise<ReplayOutcome> {
  const { history: recorded } = request;
  const prepared = prepareHistory(recorded.steps, { applied: recorded.applied ?? [], overlay: recorded.overlay ?? [] }, patches.migrations);
  const { history } = prepared;
  if (prepared.blocked) return { ok: false, ...prepared.blocked, history };
  if (!request.replay) return { ok: true, history };

  const workflowId = (recorded.workflowId ?? 'history') as WorkflowId;
  const channel = new BaseChannel<StepRequest>(workpoolOptions?.maxParallelism ?? 10);
  const step = createWorkflowCtx(workflowId, channel);
  const now = Math.max(0, ...recorded.steps.map((s) => s.startedAt));
  // Never used: starting a step stops the replay.
  const component = undefined as unknown as WorkflowComponent;
  const executor = new ReplayOnly(workflowId, 0, ctx, component, [], channel, now, workpoolOptions, history);
  const restoreEnvironment = setupEnvironment(executor.getGenerationState.bind(executor), workflowId);
  try {
    // The handler's error, if it throws; replay that matched to its end otherwise.
    const handlerWorker = async (): Promise<{ threw?: string }> => {
      try {
        await handler(step, recorded.args ?? {});
        return {};
      } catch (error) {
        return { threw: error instanceof Error ? error.message : JSON.stringify(error) };
      }
    };
    const result = await Promise.race([handlerWorker(), executor.run()]);
    if ('threw' in result && result.threw !== undefined) return { ok: false, reason: 'threw', detail: `The handler threw: ${result.threw}`, history };
    return { ok: true, history };
  } catch (error) {
    if (error instanceof Frontier) return { ok: true, history };
    if (error instanceof ReplayMismatch) return { ok: false, reason: 'mismatch', detail: error.message, position: error.position, history };
    throw error;
  } finally {
    restoreEnvironment();
  }
}
