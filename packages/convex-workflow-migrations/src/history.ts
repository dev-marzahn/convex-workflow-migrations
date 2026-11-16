// A run's history as migrations and replay see it: the journal with the
// run's overlay applied. Migrations edit it through `History`; the vendored
// executor replays the handler against `HistoryView.replay()`.
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { convexToJson, type Infer, jsonToConvex, type Value } from 'convex/values';

import type { vOverlayOp, vStepKind } from './component/schema.ts';
import { safeFunctionName } from './vendor/workflow/safeFunctionName.ts';
import type { WorkflowReturnType } from './vendor/workflow/types.ts';

export type StepKind = Infer<typeof vStepKind>;
export type OverlayOp = Infer<typeof vOverlayOp>;
type InsertOp = Extract<OverlayOp, { op: 'insert' }>;

export type RunResult = { kind: 'success'; returnValue: unknown } | { kind: 'failed'; error: string } | { kind: 'canceled' };

/** A journal entry, as much of it as a history needs. `runResult` is missing while the step runs. */
export type RecordedStep = {
  id: string;
  name: string;
  kind: StepKind;
  args: unknown;
  runResult?: RunResult;
  startedAt: number;
};

/**
 * A run's recorded history: its journal and, if the run has a record in the
 * migrations component, the migrations applied to it and their edits. The CLI's
 * `histories` command exports these as JSON, and `history([...])` in `/test`
 * builds one. Without `applied`, every migration applies: a history from
 * code before the first migration.
 */
export type RecordedHistory = {
  workflowId?: string;
  /** The workflow's function name. */
  workflow?: string;
  /** The workflow's arguments. */
  args?: unknown;
  steps: RecordedStep[];
  applied?: string[];
  overlay?: OverlayOp[];
  /** The export stopped at its step limit: the run has more steps than these. */
  truncated?: boolean;
};

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
 * A kind of step: a function reference for `runQuery`, `runMutation` and
 * `runAction` calls (it also matches `runWorkflow` calls of that function),
 * `{ workflow }` for a `runWorkflow` call, `{ event }` for an `awaitEvent`
 * and `{ sleep }` for a `sleep`, by the name they were given.
 */
export type StepRef = AnyFunction | { workflow: WorkflowFunction } | { event: string } | { sleep: string };

/** A step in the history: a `StepRef` that matches exactly one, or one of `h.steps`. */
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
 * How to insert a finished stand-in: replay resolves the call with `result`
 * and runs nothing. `args`, if given, must match the call's. `name` matches a
 * call made with a custom `name` option.
 */
export type InsertOptions<R> = { result: StepResult<R>; args?: StepArgs<R>; name?: string };

/** A run's history, as the previous migration left it. See the README's "Writing migrations". */
export interface History {
  /** The steps in order. */
  readonly steps: readonly HistoryStep[];
  /** Whether some step is `step`. */
  has(step: StepRef): boolean;
  /** The result of the only step that is `step`, or `undefined` if there's none or it hasn't succeeded. Throws if several match. */
  result<R extends StepRef>(step: R): StepResult<R> | undefined;
  /** Inserts `step` after `anchor`. Does nothing if `anchor` isn't in the history. */
  insertAfter<R extends StepRef>(anchor: StepSelector, step: R, options: InsertOptions<R>): void;
  /** Inserts `step` before `anchor`. Does nothing if `anchor` isn't in the history. */
  insertBefore<R extends StepRef>(anchor: StepSelector, step: R, options: InsertOptions<R>): void;
  /** Drops a step the code no longer calls. */
  remove(step: StepSelector): void;
  /** The step now counts as a call to `to`, which must be the same kind of step. */
  rename(step: StepSelector, to: StepRef): void;
  /** The args the current code passes. For matching only: the step ran with its old args. */
  updateArgs<R extends StepRef>(step: R | HistoryStep, update: (args: any) => StepArgs<R>): void;
}

/** One step of the history the handler replays against. */
export type ReplayEntry = {
  /** Shaped like a journal entry's `step`, so the executor compares it unchanged. */
  step: { name: string; kind: StepKind; args: unknown; inProgress: boolean; runResult?: RunResult; startedAt: number };
  /** Its position in the history, for errors. */
  position: number;
  /** False for a stand-in inserted without args: only its name and kind are matched. */
  argsKnown: boolean;
};

type Node = {
  id: string;
  name: string;
  kind: StepKind;
  args: unknown;
  argsKnown: boolean;
  /** A journal entry. */
  recorded?: RecordedStep;
  /** A stand-in's result. */
  standIn?: { result: unknown };
};

const clone = <T>(value: T): T => (value === undefined ? value : (jsonToConvex(convexToJson(value as Value)) as T));
const json = (value: unknown) => JSON.stringify(convexToJson(value as Value));

function isHistoryStep(value: StepSelector): value is HistoryStep {
  return typeof value === 'object' && value !== null && 'id' in value && 'status' in value && typeof value.id === 'string';
}

function target(ref: StepRef): { name: string; kind: StepKind | 'function or workflow' } {
  if ('event' in ref) return { name: ref.event, kind: 'event' };
  if ('sleep' in ref) return { name: ref.sleep, kind: 'sleep' };
  if ('workflow' in ref) return { name: safeFunctionName(ref.workflow), kind: 'workflow' };
  return { name: safeFunctionName(ref), kind: 'function or workflow' };
}

function describe(step: StepSelector): string {
  if (isHistoryStep(step)) return `${step.name} (${step.id})`;
  const { name, kind } = target(step);
  return kind === 'function or workflow' ? name : `${kind} ${name}`;
}

/** The status, result and error of a recorded step. */
function outcome(runResult: RunResult | undefined) {
  if (!runResult) return { status: 'running' as const };
  if (runResult.kind === 'success') return { status: 'done' as const, result: runResult.returnValue };
  return { status: 'done' as const, error: runResult.kind === 'failed' ? runResult.error : 'canceled' };
}

export class HistoryView implements History {
  private nodes: Node[];
  private readonly ops: OverlayOp[] = [];
  private nextId = 1;

  /**
   * The journal with `overlay` applied in order. Operations whose step is
   * gone from the journal (`restart({ from })` deleted it) are dropped.
   */
  public constructor(journal: readonly RecordedStep[], overlay: readonly OverlayOp[] = []) {
    this.nodes = journal.map((step) => this.recordedNode(step));
    for (const op of overlay) {
      if ('id' in op) this.nextId = Math.max(this.nextId, Number(op.id.slice(1)) + 1 || 0);
      this.apply(clone(op));
    }
  }

  // ------------------------------------------------------------- reading ---

  public get steps(): readonly HistoryStep[] {
    return this.nodes.map((node) => this.toStep(node));
  }

  public has(step: StepRef): boolean {
    return this.nodes.some((node) => this.matches(node, step));
  }

  public result<R extends StepRef>(step: R): StepResult<R> | undefined {
    const node = this.find(step, 'result');
    return node && (this.toStep(node).result as StepResult<R> | undefined);
  }

  // ------------------------------------------------------------- editing ---

  public insertAfter<R extends StepRef>(anchor: StepSelector, step: R, options: InsertOptions<R>): void {
    this.insert('after', anchor, step, options);
  }

  public insertBefore<R extends StepRef>(anchor: StepSelector, step: R, options: InsertOptions<R>): void {
    this.insert('before', anchor, step, options);
  }

  public remove(step: StepSelector): void {
    const node = this.editable(step, 'remove');
    if (node) this.push({ op: 'remove', target: node.id });
  }

  public rename(step: StepSelector, to: StepRef): void {
    const node = this.editable(step, 'rename');
    if (!node) return;
    const { name, kind } = target(to);
    const same = kind === 'function or workflow' ? node.kind === 'function' || node.kind === 'workflow' : node.kind === kind;
    if (!same) throw new Error(`rename(${describe(step)}, ${describe(to)}): the step's kind (${node.kind}) must stay the same.`);
    this.push({ op: 'rewrite', target: node.id, name });
  }

  public updateArgs<R extends StepRef>(step: R | HistoryStep, update: (args: any) => StepArgs<R>): void {
    const node = this.editable(step, 'updateArgs');
    if (!node) return;
    const args = update(clone(node.args ?? {}));
    if (args === undefined || (args as unknown) instanceof Promise) throw new Error(`updateArgs(${describe(step)}): the update must return the new args.`);
    this.push({ op: 'rewrite', target: node.id, args: clone(args) });
  }

  /** Removes every step from `position` on, for `restartFrom`. */
  public truncate(position: number): void {
    for (const node of this.nodes.slice(position)) {
      if (node.recorded && !node.recorded.runResult) throw new Error(`Can't restart from step ${position}: ${node.name} (${node.id}) is still running.`);
      this.push({ op: 'remove', target: node.id });
    }
  }

  // ------------------------------------------------------------ for replay ---

  /** The operations to store: the overlay as loaded, minus dropped ones, plus this handler run's. */
  public overlay(): OverlayOp[] {
    return this.ops.map(clone);
  }

  /**
   * The steps for the executor to replay against. A stand-in sees the time of
   * the step before it; `now`, when this handler run started, if it's first
   * and the history has no recorded step.
   */
  public replay(now: number): ReplayEntry[] {
    let previous: number | undefined;
    const firstRecorded = this.nodes.find((node) => node.recorded)?.recorded?.startedAt ?? now;
    return this.nodes.map((node, position) => {
      const recorded = node.recorded;
      const startedAt = recorded ? recorded.startedAt : (previous ?? firstRecorded);
      previous = startedAt;
      const runResult = recorded ? recorded.runResult : { kind: 'success' as const, returnValue: node.standIn!.result };
      return {
        step: { name: node.name, kind: node.kind, args: node.args, inProgress: recorded ? !recorded.runResult : false, runResult, startedAt },
        position,
        argsKnown: node.argsKnown,
      };
    });
  }

  // ------------------------------------------------------------- private ---

  private insert<R extends StepRef>(where: 'after' | 'before', anchor: StepSelector, step: R, options: InsertOptions<R>): void {
    const action = where === 'after' ? 'insertAfter' : 'insertBefore';
    const at = this.find(anchor, action);
    if (!at) return;
    const { name: refName, kind: refKind } = target(step);
    const name = options.name ?? refName;
    const kind = refKind === 'function or workflow' ? 'function' : refKind;
    const id = `+${this.nextId++}`;
    if (!('result' in options)) throw new Error(`${action}(${describe(anchor)}, ${name}): pass { result } for the stand-in.`);
    const op: InsertOp = { op: 'insert', id, where, anchor: at.id, name, kind, result: clone(options.result ?? null) };
    if (options.args !== undefined) op.args = clone(options.args);
    this.push(op);
  }

  /** The step `selector` names, or undefined if none is in the history. Throws if a reference matches several. */
  private find(selector: StepSelector, action: string): Node | undefined {
    if (isHistoryStep(selector)) {
      const node = this.nodes.find((n) => n.id === selector.id);
      if (!node) throw new Error(`${action}(${describe(selector)}): that step isn't in the history any more.`);
      return node;
    }
    const matches = this.nodes.filter((node) => this.matches(node, selector));
    if (matches.length > 1) {
      throw new Error(`${action}(${describe(selector)}): ${matches.length} steps match. Pass the one you mean from h.steps.`);
    }
    return matches[0];
  }

  /** Like `find`, for edits a running step can't take: a result will still arrive into it. */
  private editable(selector: StepSelector, action: string): Node | undefined {
    const node = this.find(selector, action);
    if (node?.recorded && !node.recorded.runResult) {
      throw new Error(`${action}(${describe(selector)}): the step is still running, so it can't be removed, renamed or given other args.`);
    }
    return node;
  }

  private matches(node: Node, ref: StepRef): boolean {
    const { name, kind } = target(ref);
    if (node.name !== name) return false;
    return kind === 'function or workflow' ? node.kind === 'function' || node.kind === 'workflow' : node.kind === kind;
  }

  private push(op: OverlayOp): void {
    if (!this.apply(op)) throw new Error(`Assertion failed: ${op.op} of a step that isn't in the history`);
  }

  /** Applies one operation; false (and not kept) if its step isn't in the history. */
  private apply(op: OverlayOp): boolean {
    const index = this.nodes.findIndex((node) => node.id === (op.op === 'insert' ? op.anchor : op.target));
    if (index < 0) return false;
    switch (op.op) {
      case 'insert':
        this.nodes.splice(op.where === 'after' ? index + 1 : index, 0, {
          id: op.id,
          name: op.name,
          kind: op.kind,
          args: op.args ?? {},
          argsKnown: op.args !== undefined,
          standIn: { result: op.result },
        });
        break;
      case 'remove':
        this.nodes.splice(index, 1);
        break;
      case 'rewrite': {
        const node = this.nodes[index]!;
        if (op.name !== undefined) node.name = op.name;
        if (op.args !== undefined) {
          node.args = op.args;
          node.argsKnown = true;
        }
        break;
      }
    }
    this.ops.push(op);
    return true;
  }

  private recordedNode(step: RecordedStep): Node {
    return { id: step.id, name: step.name, kind: step.kind, args: step.args, argsKnown: true, recorded: step };
  }

  private toStep(node: Node): HistoryStep {
    const base = { id: node.id, name: node.name, kind: node.kind, args: node.args };
    if (node.recorded) return { ...base, ...outcome(node.recorded.runResult) };
    return { ...base, status: 'done', result: node.standIn!.result };
  }
}

/** Replay doesn't match the history: the code made a different call at `position`. The run pauses. */
export class ReplayMismatch extends Error {
  public constructor(
    public readonly position: number,
    /** The call the code made, and the step the history has there, as JSON. */
    public readonly expected: string,
    public readonly recorded: string,
  ) {
    super(`Journal entry mismatch at step ${position}: the code calls ${expected}, the history has ${recorded}`);
    this.name = 'ReplayMismatch';
  }
}

/** Whether two overlays store the same operations. */
export function sameOverlay(a: readonly OverlayOp[], b: readonly OverlayOp[]): boolean {
  return json(a) === json(b);
}
