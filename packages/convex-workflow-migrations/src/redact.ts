// Scrubbing an exported history: the `histories` CLI's --redact.
import type { RecordedHistory, RecordedStep, StepKind } from './history.ts';
import type { RunResult } from './vendor/workflow/types.ts';

/** What a `--redact` module's default export gets and returns: a step, or a run's args with `kind: 'run'`. */
export type Redactable = { kind: StepKind | 'run'; name: string; args: unknown; result?: unknown; error?: string };
export type Redact = (value: Redactable) => Redactable | Promise<Redactable>;

async function redactStep(redact: Redact, step: RecordedStep): Promise<RecordedStep> {
  const { runResult } = step;
  const input: Redactable = { kind: step.kind, name: step.name, args: step.args };
  if (runResult?.kind === 'success') input.result = runResult.returnValue;
  if (runResult?.kind === 'failed') input.error = runResult.error;
  const out = await redact(input);
  let scrubbed: RunResult | undefined = runResult;
  if (runResult?.kind === 'success') scrubbed = { kind: 'success', returnValue: out.result ?? null };
  if (runResult?.kind === 'failed') scrubbed = { kind: 'failed', error: out.error ?? '' };
  const { runResult: _, ...rest } = step;
  return { ...rest, args: out.args, ...(scrubbed ? { runResult: scrubbed } : {}) };
}

/**
 * A copy of `history` with each step's args, result and error and the run's
 * args passed through `redact`. A step's args must come out as the current
 * handler passes them for the scrubbed workflow args, or replay won't match.
 */
export async function redactHistory(history: RecordedHistory, redact: Redact): Promise<RecordedHistory> {
  const steps = await Promise.all(history.steps.map((step) => redactStep(redact, step)));
  const { args } = await redact({ kind: 'run', name: history.workflow ?? '', args: history.args ?? {} });
  return { ...history, args, steps };
}
