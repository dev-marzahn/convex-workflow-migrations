// Scrubbing an exported history: the `histories` CLI's --redact.
import type { OverlayOp, RecordedHistory, RecordedStep, StepKind } from './history.ts';
import type { RunResult } from './vendor/workflow/types.ts';

/**
 * What a `--redact` module's default export gets and returns: a step, or a
 * run's args with `kind: 'run'`. Steps come from the journal and from the
 * overlay: a stand-in, with its args (`{}` if it has none) and result, and a
 * step's rewritten args or result, by the name the current code calls it.
 */
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
 * The overlay's operations with their data passed through `redact`: a
 * stand-in's args and result, a rewrite's args and result, and the migrated
 * workflow args. A rewrite is passed as its step, with the name, kind and
 * args the operations before it left it.
 */
async function redactOverlay(redact: Redact, history: RecordedHistory, overlay: readonly OverlayOp[]): Promise<OverlayOp[]> {
  const steps = new Map(history.steps.map((step) => [step.id, { name: step.name, kind: step.kind, args: step.args }]));
  const out: OverlayOp[] = [];
  for (const op of overlay) {
    if (op.op === 'insert') {
      steps.set(op.id, { name: op.name, kind: op.kind, args: op.args ?? {} });
      const scrubbed = await redact({ kind: op.kind, name: op.name, args: op.args ?? {}, result: op.result });
      out.push({ ...op, ...(op.args === undefined ? {} : { args: scrubbed.args }), result: scrubbed.result ?? null });
    } else if (op.op === 'rewrite') {
      const before = steps.get(op.target) ?? { name: '', kind: 'function' as const, args: {} };
      const step = { ...before, ...(op.name === undefined ? {} : { name: op.name }), ...(op.args === undefined ? {} : { args: op.args }) };
      steps.set(op.target, step);
      const hasResult = 'result' in op;
      if (op.args === undefined && !hasResult) {
        out.push(op);
        continue;
      }
      const scrubbed = await redact({ ...step, ...(hasResult ? { result: op.result } : {}) });
      out.push({ ...op, ...(op.args === undefined ? {} : { args: scrubbed.args }), ...(hasResult ? { result: scrubbed.result ?? null } : {}) });
    } else if (op.op === 'workflowArgs') {
      const { args } = await redact({ kind: 'run', name: history.workflow ?? '', args: op.args });
      out.push({ ...op, args });
    } else {
      out.push(op);
    }
  }
  return out;
}

/**
 * A copy of `history` with each step's args, result and error, the run's
 * args, and the data in its overlay passed through `redact`. A step's args
 * must come out as the current handler passes them for the scrubbed
 * workflow args, or replay won't match.
 */
export async function redactHistory(history: RecordedHistory, redact: Redact): Promise<RecordedHistory> {
  const steps = await Promise.all(history.steps.map((step) => redactStep(redact, step)));
  const { args } = await redact({ kind: 'run', name: history.workflow ?? '', args: history.args ?? {} });
  const overlay = history.overlay === undefined ? undefined : await redactOverlay(redact, history, history.overlay);
  return { ...history, args, steps, ...(overlay === undefined ? {} : { overlay }) };
}
