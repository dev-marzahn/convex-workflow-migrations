// A run's history as migrations and replay see it: the journal with the
// run's overlay applied. Migrations edit it through `History`; the vendored
// executor replays the handler against `HistoryView.replay()`.
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { convexToJson, type Infer, jsonToConvex, type Value } from 'convex/values';

import type { vOverlayOp, vStepKind } from './component/schema.ts';
import { type ReplayEntry, ReplayError } from './replay.ts';
import { safeFunctionName } from './vendor/workflow/safeFunctionName.ts';
import type { RunResult, WorkflowReturnType } from './vendor/workflow/types.ts';

export type StepKind = Infer<typeof vStepKind>;
export type OverlayOp = Infer<typeof vOverlayOp>;

/** A journal entry, as much of it as a history needs. `runResult` is missing while the step runs. */
export type RecordedStep = { id: string; name: string; kind: StepKind; args: unknown; runResult?: RunResult; startedAt: number };

/**
 * A run's recorded history: its journal and, if its record says, the
 * migrations applied to it and their edits. `history()` in `/replay` builds
 * one. Without `applied`, it's a run without a record (README, "Testing").
 */
export type RecordedHistory = { workflowId?: string; args?: unknown; steps: RecordedStep[]; applied?: string[]; overlay?: OverlayOp[] };

/** A step of a history, as a migration reads it. */
export type HistoryStep = {
  /** The journal entry's id, or the id of a step a migration inserted. */
  readonly id: string;
  readonly name: string;
  readonly kind: StepKind;
  readonly args: any;
  readonly status: 'done' | 'running';
  /** What the step returned, if it succeeded; for a stand-in, the result it was given. */
  readonly result?: unknown;
  /** Why it didn't succeed, if it failed or was canceled. */
  readonly error?: string;
};

type AnyFunction = FunctionReference<any, any>;
type WorkflowFunction = FunctionReference<'mutation', 'internal'>;

/**
 * A kind of step: a function reference (which also matches `runWorkflow`
 * calls of it; inserted, it's a function call), `{ workflow }`, `{ event }`
 * for an `awaitEvent`, or `{ sleep }`, by the name they were given.
 */
export type StepRef = AnyFunction | { workflow: WorkflowFunction } | { event: string } | { sleep: string };

/** A `StepRef`, which matches at most one step (several throw, none makes the edit do nothing), or one of `h.steps`. */
export type StepSelector = StepRef | HistoryStep;

/** The value a call to `R` resolves to. */
export type StepResult<R> = R extends { workflow: infer W extends WorkflowFunction }
  ? WorkflowReturnType<W>
  : R extends AnyFunction
    ? Awaited<FunctionReturnType<R>>
    : unknown;

/** The args a call to `R` passes. */
export type StepArgs<R> = R extends { workflow: infer W extends WorkflowFunction }
  ? FunctionArgs<W>['args']
  : R extends AnyFunction
    ? FunctionArgs<R>
    : Record<string, never>;

/**
 * A finished stand-in: replay resolves the call with `result` and runs
 * nothing. `args`, if given, must match the call's; `name` matches a call made
 * with a custom `name` option. Without `atEnd: true`, an insert where neither
 * a journal entry nor another stand-in follows does nothing.
 */
export type InsertOptions<R> = { result: StepResult<R>; args?: StepArgs<R>; name?: string; atEnd?: boolean };

/** A run's history, as the previous migration left it. See the README's "Writing migrations". */
export interface History {
  /** The steps in order. Positions count from 0. */
  readonly steps: readonly HistoryStep[];
  /** The workflow's arguments. */
  readonly workflowArgs: any;
  /** Whether some step is `step`. */
  has(step: StepRef): boolean;
  /** The result of the only step that is `step`, or `undefined` if there's none or it hasn't succeeded. */
  result<R extends StepRef>(step: R): StepResult<R> | undefined;
  /** Inserts a stand-in for `step` after `anchor`. */
  insertAfter<R extends StepRef>(anchor: StepSelector, step: R, options: InsertOptions<R>): void;
  /** Inserts a stand-in for `step` before `anchor`. */
  insertBefore<R extends StepRef>(anchor: StepSelector, step: R, options: InsertOptions<R>): void;
  /** Drops a step the code no longer calls. */
  remove(step: StepSelector): void;
  /** The step now counts as a call to `to`, which must be of its kind (throws otherwise); `name` for a call made with a custom `name` option. */
  rename(step: StepSelector, to: StepRef, options?: { name?: string }): void;
  /** The args the current code passes. For matching only: the step ran with its old args. */
  updateArgs<R extends StepRef>(step: R | HistoryStep, update: (args: any) => StepArgs<R>): void;
  /** The result replay gives the call, for a step whose return value changed shape. Throws for a failed or canceled step; leaves a running one as it is. */
  updateResult<R extends StepRef>(step: R | HistoryStep, update: (result: any) => StepResult<R>): void;
  /** The workflow's arguments as the current `args` validator expects them. Replay passes these; the run keeps its own. */
  updateWorkflowArgs(update: (args: any) => unknown): void;
}

type Node = {
  id: string;
  name: string;
  kind: StepKind;
  args: unknown;
  argsKnown: boolean;
  /** A journal entry; a stand-in has none. */
  recorded?: RecordedStep;
  /** A stand-in's result, or a recorded step's as `updateResult` changed it. */
  result?: { value: unknown };
};

const REWRITTEN = ['name', 'args', 'result'] as const;
const clone = <T>(value: T): T => (value === undefined ? value : (jsonToConvex(convexToJson(value as Value)) as T));
export const json = (value: unknown) => JSON.stringify(convexToJson(value as Value));

const isHistoryStep = (value: StepSelector): value is HistoryStep =>
  typeof value === 'object' && 'id' in value && 'status' in value && typeof value.id === 'string';

function target(ref: StepRef): { name: string; kind: StepKind | 'function or workflow' } {
  if ('event' in ref) return { name: ref.event, kind: 'event' };
  if ('sleep' in ref) return { name: ref.sleep, kind: 'sleep' };
  if ('workflow' in ref) return { name: safeFunctionName(ref.workflow), kind: 'workflow' };
  return { name: safeFunctionName(ref), kind: 'function or workflow' };
}

const sameKind = (kind: StepKind, wanted: StepKind | 'function or workflow') =>
  wanted === 'function or workflow' ? kind === 'function' || kind === 'workflow' : kind === wanted;

function describe(step: StepSelector): string {
  if (isHistoryStep(step)) return `${step.name} (${step.id})`;
  const { name, kind } = target(step);
  return kind === 'function or workflow' ? name : `${kind} ${name}`;
}

export class HistoryView implements History {
  private nodes: Node[];
  private ops: OverlayOp[] = [];
  private args: unknown;
  private nextId = 1;
  /** How many edits migrations made to this view, after it loaded its overlay. */
  public edits = 0;

  /**
   * The journal with `overlay` applied in order, and `args` as the run
   * recorded them. Throws a `ReplayError` if an operation's step isn't in the
   * journal. With `strict`, for the /replay helpers, each `updateResult` and
   * `updateWorkflowArgs` runs again on its own output and throws if that
   * changes it.
   */
  public constructor(
    private readonly journal: readonly RecordedStep[],
    overlay: readonly OverlayOp[] = [],
    args: unknown = {},
    private readonly options: { strict?: boolean } = {},
  ) {
    this.nodes = journal.map((step) => ({ id: step.id, name: step.name, kind: step.kind, args: step.args, argsKnown: true, recorded: step }));
    this.args = clone(args);
    for (const op of overlay) {
      if (op.op === 'insert') this.nextId = Math.max(this.nextId, Number(op.id.slice(1)) + 1 || 0);
      this.apply(clone(op));
    }
    this.edits = 0;
  }

  public get steps(): readonly HistoryStep[] {
    return this.nodes.map((node) => this.toStep(node));
  }

  public get workflowArgs(): any {
    return clone(this.args);
  }

  public has(step: StepRef): boolean {
    return this.nodes.some((node) => this.matches(node, step));
  }

  public result<R extends StepRef>(step: R): StepResult<R> | undefined {
    const node = this.find(step, 'result');
    return node && (this.toStep(node).result as StepResult<R> | undefined);
  }

  public insertAfter<R extends StepRef>(anchor: StepSelector, step: R, options: InsertOptions<R>): void {
    this.insert('after', anchor, step, options);
  }

  public insertBefore<R extends StepRef>(anchor: StepSelector, step: R, options: InsertOptions<R>): void {
    this.insert('before', anchor, step, options);
  }

  public remove(step: StepSelector): void {
    const node = this.find(step, 'remove');
    if (node) this.apply({ op: 'remove', target: node.id });
  }

  public rename(step: StepSelector, to: StepRef, options: { name?: string } = {}): void {
    const node = this.find(step, 'rename');
    if (!node) return;
    const { name, kind } = target(to);
    if (!sameKind(node.kind, kind)) throw new Error(`rename(${describe(step)}, ${describe(to)}): the step's kind (${node.kind}) must stay the same.`);
    this.apply({ op: 'rewrite', target: node.id, name: options.name ?? name });
  }

  public updateArgs<R extends StepRef>(step: R | HistoryStep, update: (args: any) => StepArgs<R>): void {
    const node = this.find(step, 'updateArgs');
    if (!node) return;
    const args = update(clone(node.args ?? {}));
    if (args === undefined || (args as unknown) instanceof Promise) throw new Error(`updateArgs(${describe(step)}): the update must return the new args.`);
    if (!node.argsKnown || json(args) !== json(node.args)) this.apply({ op: 'rewrite', target: node.id, args: clone(args) });
  }

  public updateResult<R extends StepRef>(step: R | HistoryStep, update: (result: any) => StepResult<R>): void {
    const node = this.find(step, 'updateResult');
    if (!node) return;
    const current = this.toStep(node);
    // A running step's result is still to come, from the code that runs then. At runtime, migrations see finished steps only.
    if (current.status === 'running') return;
    if (current.error !== undefined) throw new Error(`updateResult(${describe(step)}): the step didn't succeed, so it has no result to change.`);
    const result = update(current.result);
    if (result === undefined || (result as unknown) instanceof Promise)
      throw new Error(`updateResult(${describe(step)}): the update must return the new result.`);
    this.rerun(`updateResult(${describe(step)})`, update, result);
    if (json(result) !== json(current.result)) this.apply({ op: 'rewrite', target: node.id, result: clone(result) });
  }

  public updateWorkflowArgs(update: (args: any) => unknown): void {
    const args = update(this.workflowArgs);
    if (args === undefined || args instanceof Promise) throw new Error('updateWorkflowArgs: the update must return the new args.');
    this.rerun('updateWorkflowArgs', update, args);
    if (json(args) !== json(this.args)) this.apply({ op: 'workflowArgs', args: clone(args) });
  }

  /** With `strict`, throws if `update`, run again on its own `output`, changes it. */
  private rerun(action: string, update: (value: any) => unknown, output: unknown): void {
    const again = this.options.strict && json(update(clone(output)));
    if (!again || again === json(output)) return;
    throw new Error(
      `${action}: run again on its own output, the update changed it (${json(output)} became ${again}). ` +
        "It may be in the new shape already, as a step can finish on the new code: leave such a value as it is, for example r => ('size' in r ? r : { ...r, size: null }).",
    );
  }

  /** The operations to store: the overlay as loaded, plus this handler run's, without the ones later ones superseded. */
  public overlay(): OverlayOp[] {
    return this.ops.map(clone);
  }

  // For the throw rules in src/replay.ts (README, "Pausing and recovery").

  /** How many steps the history has. */
  public get length(): number {
    return this.nodes.length;
  }

  /** Whether the step at `position` or a later one is a journal entry. */
  public recordedFrom(position: number): boolean {
    return this.nodes.slice(position).some((node) => node.recorded);
  }

  /** Whether the step at `position` is a stand-in, or has a result a migration changed. */
  public fromMigration(position: number): boolean {
    return this.nodes[position]?.result !== undefined;
  }

  /**
   * Whether the newest recorded steps (the journal entries with its latest
   * start time: those the last handler run that started steps started)
   * include one still in the history that failed or was canceled. Read from
   * the journal, before migrations: if one removed those steps, the failure
   * that's last now is an older one. A migration that renamed such a step or
   * gave it new args doesn't change that it failed, and `updateResult` throws
   * on it, so its failure is what replay gives the handler.
   */
  public endsInFailure(): boolean {
    const newest = Math.max(...this.journal.map((step) => step.startedAt));
    return this.nodes.some(({ recorded }) => recorded?.startedAt === newest && recorded.runResult !== undefined && recorded.runResult.kind !== 'success');
  }

  /**
   * The steps for the executor to replay against. A stand-in sees the time of
   * the step before it; one before every recorded step, the first one's time,
   * or `now` if the history has none.
   */
  public replay(now: number): ReplayEntry[] {
    let previous = this.nodes.find((node) => node.recorded)?.recorded?.startedAt ?? now;
    return this.nodes.map((node, position) => {
      const recorded = node.recorded;
      const startedAt = recorded ? recorded.startedAt : previous;
      previous = startedAt;
      const runResult: RunResult | undefined = node.result ? { kind: 'success', returnValue: node.result.value } : recorded!.runResult;
      return {
        step: { name: node.name, kind: node.kind, args: node.args, inProgress: recorded ? !recorded.runResult : false, runResult, startedAt },
        position,
        argsKnown: node.argsKnown,
      };
    });
  }

  private insert<R extends StepRef>(where: 'after' | 'before', anchor: StepSelector, step: R, options: InsertOptions<R>): void {
    const action = where === 'after' ? 'insertAfter' : 'insertBefore';
    const at = this.find(anchor, action);
    if (!at) return;
    const { name: refName, kind: refKind } = target(step);
    const name = options.name ?? refName;
    if (!('result' in options)) throw new Error(`${action}(${describe(anchor)}, ${name}): pass { result } for the stand-in.`);
    // No journal entry or stand-in follows: the run hasn't got past this point, so it makes the call for real.
    const index = this.nodes.indexOf(at);
    if (options.atEnd !== true && index + (where === 'after' ? 1 : 0) >= this.nodes.length) return;
    const kind = refKind === 'function or workflow' ? 'function' : refKind;
    const op: OverlayOp = { op: 'insert', id: `+${this.nextId++}`, where, anchor: at.id, name, kind, result: clone(options.result ?? null) };
    if (options.args !== undefined) op.args = clone(options.args);
    this.apply(op);
  }

  /** The step `selector` names, or undefined if none is in the history. Throws if a reference matches several, or a step from `h.steps` was removed. */
  private find(selector: StepSelector, action: string): Node | undefined {
    if (isHistoryStep(selector)) {
      const node = this.nodes.find((n) => n.id === selector.id);
      if (!node) throw new Error(`${action}(${describe(selector)}): that step isn't in the history any more.`);
      return node;
    }
    const matches = this.nodes.filter((node) => this.matches(node, selector));
    if (matches.length > 1) throw new Error(`${action}(${describe(selector)}): ${matches.length} steps match. Pass the one you mean from h.steps.`);
    return matches[0];
  }

  private matches(node: Node, ref: StepRef): boolean {
    const { name, kind } = target(ref);
    return node.name === name && sameKind(node.kind, kind);
  }

  /** Applies one operation and keeps it, in place of the earlier ones it supersedes. Only a stored one can name a step the history lacks. */
  private apply(op: OverlayOp): void {
    if (op.op === 'workflowArgs') {
      this.args = op.args;
      this.ops = this.ops.filter((kept) => kept.op !== 'workflowArgs');
    } else {
      const id = op.op === 'insert' ? op.anchor : op.target;
      const index = this.nodes.findIndex((node) => node.id === id);
      if (index < 0) throw new ReplayError('record', `The run's record edits journal entry ${id}, which was deleted outside the WorkflowManager.`);
      const node = this.nodes[index]!;
      if (op.op === 'insert') {
        const standIn = { id: op.id, name: op.name, kind: op.kind, args: op.args ?? {}, argsKnown: op.args !== undefined, result: { value: op.result } };
        this.nodes.splice(op.where === 'after' ? index + 1 : index, 0, standIn);
      } else if (op.op === 'remove') {
        this.nodes.splice(index, 1);
      } else {
        if (op.name !== undefined) node.name = op.name;
        if (op.args !== undefined) [node.args, node.argsKnown] = [op.args, true];
        if (op.result !== undefined) node.result = { value: op.result };
        // An earlier rewrite of the same field of the step is superseded.
        const fields = REWRITTEN.filter((field) => op[field] !== undefined);
        for (const kept of this.ops) if (kept.op === 'rewrite' && kept.target === op.target) for (const field of fields) delete kept[field];
        this.ops = this.ops.filter((kept) => kept.op !== 'rewrite' || REWRITTEN.some((field) => kept[field] !== undefined));
      }
    }
    this.ops.push(op);
    this.edits++;
  }

  /** A copy of the step, so that changing what a migration reads doesn't change the history. */
  private toStep(node: Node): HistoryStep {
    const base = { id: node.id, name: node.name, kind: node.kind, args: clone(node.args) };
    if (node.result) return { ...base, status: 'done', result: clone(node.result.value) };
    const runResult = node.recorded!.runResult;
    if (!runResult) return { ...base, status: 'running' };
    if (runResult.kind === 'success') return { ...base, status: 'done', result: clone(runResult.returnValue) };
    return { ...base, status: 'done', error: runResult.kind === 'failed' ? runResult.error : 'canceled' };
  }
}
