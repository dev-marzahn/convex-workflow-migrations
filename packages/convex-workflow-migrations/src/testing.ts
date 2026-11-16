// How expectReplays() and migrate() from /test replay a history: with the
// same `prepareRun` and `replayHandler` as the workflow mutation, on the
// workflow `WorkflowManager.define` attached to it (`REPLAY`), without
// Convex. Nothing is loaded, saved or started.
import { BaseChannel } from 'async-channel';
import type { GenericDataModel, GenericMutationCtx } from 'convex/server';

import { type HistoryView, type PauseReason, type RecordedHistory, ReplayPause } from './history.ts';
import { editedNow, type Prepared, prepareRun } from './migrations.ts';
import { argsValid, replayHandler, type ReplayTarget } from './replay.ts';
import { setupEnvironment } from './vendor/workflow/environment.ts';
import type { WorkflowId } from './vendor/workflow/publicTypes.ts';
import { StepExecutor, type StepRequest } from './vendor/workflow/step.ts';
import type { WorkflowComponent } from './vendor/workflow/types.ts';
import { createWorkflowCtx } from './vendor/workflow/workflowContext.ts';

/** How replaying a history against the current handler went, and the migrations applied to it, with how many edits each made. */
export type ReplayOutcome =
  | { ok: true; history: HistoryView; ran: Prepared['ran'] }
  | { ok: false; reason: PauseReason | 'truncated' | 'unstable'; detail: string; position?: number; history: HistoryView };

/** Thrown where the executor would start a step: replay got as far as the history goes. */
class Frontier extends Error {}

class ReplayOnly extends StepExecutor {
  public override async startSteps(): Promise<never> {
    throw new Frontier();
  }
}

/**
 * Replays the history as the workflow mutation would, with the same
 * `replayHandler`, or, with `replay: false`, only migrates it. The
 * differences: the args are checked without the database, so ids are
 * checked only as strings; a handler run that would fail the run passes
 * unless the history says the run succeeded; and for a run that failed,
 * only a throw before its last recorded step fails, since its own failure
 * came after it.
 */
export async function replayHistory(target: ReplayTarget, recorded: RecordedHistory, replay: boolean): Promise<ReplayOutcome> {
  const stored = { applied: recorded.applied, overlay: recorded.overlay ?? [], ...(recorded.restart === undefined ? {} : { restart: recorded.restart }) };
  // Without `applied`, as the workflow mutation treats a run whose record doesn't say.
  const prepared = prepareRun(recorded.steps, stored, target.migrations, recorded.args ?? {}, (args) => argsValid(target.definition, args));
  const { history, ran } = prepared;
  const failed = (pause: ReplayPause): ReplayOutcome => ({
    ok: false,
    reason: pause.reason,
    detail: pause.detail,
    ...(pause.position === undefined ? {} : { position: pause.position }),
    history,
  });
  if (prepared.blocked) return failed(prepared.blocked);
  if (recorded.truncated) {
    const detail = `The history is truncated: the export stopped at ${recorded.steps.length} steps, so the rest of the run can't be checked. Export it with a larger --max-steps.`;
    return { ok: false, reason: 'truncated', detail, history };
  }
  if (recorded.unstable) {
    const detail = "The history is unstable: the run's record changed every time the export read its journal, so the two may not match. Export it again.";
    return { ok: false, reason: 'unstable', detail, history };
  }
  if (!replay) return { ok: true, history, ran };

  const workflowId = (recorded.workflowId ?? 'history') as WorkflowId;
  const { workpoolOptions } = target;
  const channel = new BaseChannel<StepRequest>(workpoolOptions?.maxParallelism ?? 10);
  const step = createWorkflowCtx(workflowId, channel);
  const now = Math.max(0, ...recorded.steps.map((s) => s.startedAt));
  // Never used: starting a step stops the replay, and nothing else reads them.
  const ctx = undefined as unknown as GenericMutationCtx<GenericDataModel>;
  const component = undefined as unknown as WorkflowComponent;
  const executor = new ReplayOnly(workflowId, 0, ctx, component, [], channel, now, workpoolOptions, history);
  const restoreEnvironment = setupEnvironment(executor.getGenerationState.bind(executor), workflowId);
  let result: Awaited<ReturnType<typeof replayHandler>>;
  try {
    result = await replayHandler(
      target.definition,
      {
        history,
        args: history.workflowArgs,
        editedNow: editedNow(prepared),
        // The run failed: a throw after its recorded steps is the one it failed with.
        recordedOnly: recorded.outcome === 'failed' || recorded.outcome === 'canceled',
      },
      executor,
      { step, console: { error: () => {} } },
    );
  } catch (error) {
    if (error instanceof Frontier) return { ok: true, history, ran };
    throw error;
  } finally {
    restoreEnvironment();
  }
  if (result instanceof ReplayPause) return failed(result);
  if (result.type === 'handlerDone' && result.runResult.kind === 'failed' && recorded.outcome === 'success') {
    const error = result.runResult.error.split('\n')[0];
    return failed(new ReplayPause('threw', `The run succeeded, but the handler now fails after replaying its history: ${error}`));
  }
  return { ok: true, history, ran };
}
