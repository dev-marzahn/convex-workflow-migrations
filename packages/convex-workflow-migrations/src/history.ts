// A run's history as migrations and replay see it: the journal with the
// run's overlay applied. Migrations edit it through `History`; the vendored
// executor replays the handler against `HistoryView.replay()`.
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { convexToJson, getConvexSize, type Infer, jsonToConvex, type Value } from 'convex/values';

import { capDetail, type vOverlayOp, type vPauseReason, type vStepKind } from './component/schema.ts';
import { safeFunctionName } from './vendor/workflow/safeFunctionName.ts';
import type { RunResult, WorkflowReturnType } from './vendor/workflow/types.ts';

export type StepKind = Infer<typeof vStepKind>;
export type OverlayOp = Infer<typeof vOverlayOp>;
type InsertOp = Extract<OverlayOp, { op: 'insert' }>;

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
 * migrations component, the migrations applied to it and their edits. The
 * CLI's `histories` command exports these as JSON, and `history([...])` in
 * `/test` builds one. Without `applied`, every migration applies: a history
 * from code before the first migration.
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
  /** The step a `restart` stored, if the restarted run hasn't replayed yet: its next handler run removes the history from there on. */
  restart?: string;
  /** How the run ended, if it has. */
  outcome?: RunResult['kind'];
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
 * `runAction` calls, `{ workflow }` for a `runWorkflow` call, `{ event }` for
 * an `awaitEvent` and `{ sleep }` for a `sleep`, by the name they were given.
 * Selecting a step, a function reference also matches `runWorkflow` calls of
 * that function; inserting one, it makes a function call: insert a child
 * workflow with `{ workflow }`.
 */
export type StepRef = AnyFunction | { workflow: WorkflowFunction } | { event: string } | { sleep: string };

/**
 * A step in the history: a `StepRef`, which matches at most one step (several
 * matches throw, none makes the edit do nothing), or one of `h.steps`, which
 * throws if an earlier edit removed it.
 */
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
 * call made with a custom `name` option. Without `atEnd`, an insert where no
 * journal entry follows does nothing, so the run makes the call for real;
 * with `atEnd: true`, the stand-in goes in there too.
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
  /** The result of the only step that is `step`, or `undefined` if there's none or it hasn't succeeded. Throws if several match. */
  result<R extends StepRef>(step: R): StepResult<R> | undefined;
  /** Inserts `step` after `anchor`. Does nothing if `anchor` isn't in the history, or, without `atEnd`, if no journal entry follows it. */
  insertAfter<R extends StepRef>(anchor: StepSelector, step: R, options: InsertOptions<R>): void;
  /** Inserts `step` before `anchor`. Does nothing if `anchor` isn't in the history, or, without `atEnd`, if no journal entry follows the stand-in. */
  insertBefore<R extends StepRef>(anchor: StepSelector, step: R, options: InsertOptions<R>): void;
  /** Drops a step the code no longer calls. */
  remove(step: StepSelector): void;
  /** The step now counts as a call to `to`, which must be the same kind of step. */
  rename(step: StepSelector, to: StepRef): void;
  /** The args the current code passes. For matching only: the step ran with its old args. */
  updateArgs<R extends StepRef>(step: R | HistoryStep, update: (args: any) => StepArgs<R>): void;
  /** The result replay gives the call instead of the recorded one, for a step whose return value changed shape. The step must have succeeded. */
  updateResult<R extends StepRef>(step: R | HistoryStep, update: (result: any) => StepResult<R>): void;
  /** The workflow's arguments as the current code's `args` validator expects them. The run keeps its recorded args; replay passes these. */
  updateWorkflowArgs(update: (args: any) => unknown): void;
}

/**
 * What the vendored executor compares a call with: a step of the history, or
 * a journal entry the handler run just started. Only history steps have a
 * position, so only they throw `ReplayMismatch`.
 */
export type ReplayStep = {
  step: { name: string; kind?: StepKind; args: any; inProgress: boolean; runResult?: RunResult };
  argsKnown?: boolean;
  position?: number;
  standIn?: boolean;
};

/** One step of the history the handler replays against. */
export type ReplayEntry = ReplayStep & {
  /** Shaped like a journal entry's `step`, so the executor compares it unchanged. */
  step: { name: string; kind: StepKind; args: unknown; inProgress: boolean; runResult?: RunResult; startedAt: number };
  /** Its position in the history, for errors. */
  position: number;
  /** False for a stand-in inserted without args: only its name and kind are matched. */
  argsKnown: boolean;
  /** A stand-in: a migration inserted it. */
  standIn: boolean;
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
  /** A recorded step's result, as `updateResult` changed it. */
  result?: { value: unknown };
  /** A migration renamed it, or gave it other args or another result. */
  rewritten?: boolean;
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
  private ops: OverlayOp[] = [];
  /** Journal entry id → its position in the journal. */
  private readonly order: ReadonlyMap<string, number>;
  private args: unknown;
  private nextId = 1;
  /** Stand-ins of the stored overlay whose anchor is gone from the journal. */
  private readonly dropped = new Set<string>();
  /** How many edits migrations have made to this view. */
  private edits = 0;

  /**
   * The journal with `overlay` applied in order, for a run started with
   * `args`. Operations whose step is gone from the journal (a restart deleted
   * it) are dropped.
   */
  public constructor(
    private readonly journal: readonly RecordedStep[],
    overlay: readonly OverlayOp[] = [],
    args: unknown = {},
  ) {
    this.order = new Map(journal.map((step, i) => [step.id, i]));
    this.nodes = journal.map((step) => ({ id: step.id, name: step.name, kind: step.kind, args: step.args, argsKnown: true, recorded: step }));
    this.args = clone(args);
    for (const op of overlay) {
      if ('id' in op) this.nextId = Math.max(this.nextId, Number(op.id.slice(1)) + 1 || 0);
      if (!this.apply(clone(op)) && op.op === 'insert') this.dropped.add(op.id);
    }
  }

  // ------------------------------------------------------------- reading ---

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

  public updateResult<R extends StepRef>(step: R | HistoryStep, update: (result: any) => StepResult<R>): void {
    const node = this.editable(step, 'updateResult');
    if (!node) return;
    const current = this.toStep(node);
    if (current.error !== undefined) throw new Error(`updateResult(${describe(step)}): the step didn't succeed, so it has no result to change.`);
    const result = update(clone(current.result));
    if (result === undefined || (result as unknown) instanceof Promise)
      throw new Error(`updateResult(${describe(step)}): the update must return the new result.`);
    this.push({ op: 'rewrite', target: node.id, result: clone(result) });
  }

  public updateWorkflowArgs(update: (args: any) => unknown): void {
    const args = update(this.workflowArgs);
    if (args === undefined || args instanceof Promise) throw new Error('updateWorkflowArgs: the update must return the new args.');
    // Only the latest one counts, so it replaces any earlier one.
    for (const op of this.ops.filter((op) => op.op === 'workflowArgs')) this.dropOp(op);
    this.push({ op: 'workflowArgs', args: clone(args) });
  }

  // --------------------------------------------------- for the manager ---

  /**
   * For `restartFrom` and `restart`: removes every step from `position` on.
   * The journal entries go in one operation, which leaves entries recorded
   * later alone; upstream's journal keeps them all.
   */
  public truncate(position: number): void {
    const rest = this.nodes.slice(position);
    for (const node of rest) {
      if (node.recorded && !node.recorded.runResult) throw new Error(`Can't restart from step ${position}: ${node.name} (${node.id}) is still running.`);
    }
    const first = rest.find((node) => node.recorded);
    const last = [...this.order.keys()].at(-1);
    if (first && last !== undefined) this.push({ op: 'truncate', from: first.id, through: last }, false);
    for (const node of rest) if (!node.recorded) this.push({ op: 'remove', target: node.id }, false);
  }

  /** The position of the last step named `name` or matching `ref`, for `restart({ from })`; -1 if there's none. */
  public lastPosition(step: string | StepRef): number {
    return this.nodes.findLastIndex((node) => (typeof step === 'string' ? node.name === step : this.matches(node, step)));
  }

  // ---------------------------------------------- for migrations and replay ---

  /** Runs a migration's `migrate` on this view. Returns how many edits it made. */
  public migrateAs(migrate: () => void): number {
    const before = this.edits;
    migrate();
    return this.edits - before;
  }

  /** The operations to store: the overlay as loaded, minus dropped ones, plus this handler run's. */
  public overlay(): OverlayOp[] {
    return this.ops.map(clone);
  }

  /** The stored size of the overlay, in bytes. */
  public size(): number {
    return this.ops.reduce((bytes, op) => bytes + getConvexSize(op as Value), 0);
  }

  /** Whether the step at `position` is a stand-in or has a result a migration changed: the handler got it from a migration, not from the run. */
  public fromMigration(position: number): boolean {
    const node = this.nodes[position];
    return node !== undefined && (node.standIn !== undefined || node.result !== undefined);
  }

  /** The id of the first journal entry at `position` or after it, if there's one. */
  public recordedAt(position: number): string | undefined {
    return this.nodes.slice(position).find((node) => node.recorded)?.id;
  }

  /** Whether the step at `position` or a later one is a journal entry. */
  public recordedFrom(position: number): boolean {
    return this.nodes.slice(position).some((node) => node.recorded);
  }

  /**
   * Whether the handler, having got every recorded step of the history, got
   * a failure to pass on: among the newest recorded steps, the journal
   * entries started together in the last handler run that started steps,
   * one is still in the history, failed or was canceled, and no migration
   * renamed it or gave it other args or another result. The newest steps are
   * read from the journal, before migrations: if a migration removed them,
   * the failure the handler got is an older one, which the old code caught.
   */
  public endsInFailure(): boolean {
    if (this.journal.length === 0) return false;
    const newest = this.journal.reduce((max, step) => Math.max(max, step.startedAt), -Infinity);
    return this.nodes.some(
      (node) => node.recorded?.startedAt === newest && node.recorded.runResult !== undefined && node.recorded.runResult.kind !== 'success' && !node.rewritten,
    );
  }

  /**
   * Whether the step with id `id` is gone because upstream deleted it from
   * the journal (as its `restart({ from })` does), rather than because a
   * migration removed it: a journal entry that isn't in the journal any
   * more, or a stand-in dropped with the step it was anchored to.
   */
  public deleted(id: string): boolean {
    return id.startsWith('+') ? this.dropped.has(id) : !this.order.has(id);
  }

  /** The position of the step with id `id`, or -1 if the history doesn't have it. */
  public position(id: string): number {
    return this.nodes.findIndex((node) => node.id === id);
  }

  /** The id of the step at `position`, or undefined past the end. */
  public idAt(position: number): string | undefined {
    return this.nodes[position]?.id;
  }

  /** How many steps the history has. */
  public get length(): number {
    return this.nodes.length;
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
      let runResult: RunResult | undefined;
      if (node.standIn) runResult = { kind: 'success', returnValue: node.standIn.result };
      else if (node.result) runResult = { kind: 'success', returnValue: node.result.value };
      else runResult = recorded!.runResult;
      return {
        step: { name: node.name, kind: node.kind, args: node.args, inProgress: recorded ? !recorded.runResult : false, runResult, startedAt },
        position,
        argsKnown: node.argsKnown,
        standIn: node.standIn !== undefined,
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
    if (!('result' in options)) throw new Error(`${action}(${describe(anchor)}, ${name}): pass { result } for the stand-in.`);
    // Nothing recorded after it: the run hasn't got past this point, so it makes the call for real.
    const index = this.nodes.indexOf(at);
    if (options.atEnd !== true && !this.recordedFrom(where === 'after' ? index + 1 : index)) return;
    const id = `+${this.nextId++}`;
    const op: InsertOp = { op: 'insert', id, where, anchor: at.id, name, kind, result: clone(options.result ?? null) };
    if (options.args !== undefined) op.args = clone(options.args);
    this.push(op);
  }

  /** The step `selector` names, or undefined if none is in the history. Throws if a reference matches several, or a step from `h.steps` was removed. */
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
      throw new Error(`${action}(${describe(selector)}): the step is still running, so it can't be removed, renamed or given other args or another result.`);
    }
    return node;
  }

  private matches(node: Node, ref: StepRef): boolean {
    const { name, kind } = target(ref);
    if (node.name !== name) return false;
    return kind === 'function or workflow' ? node.kind === 'function' || node.kind === 'workflow' : node.kind === kind;
  }

  /** Applies and keeps an edit; `edit: false` for the restart's, which no migration made. */
  private push(op: OverlayOp, edit = true): void {
    if (!this.apply(op)) throw new Error(`Assertion failed: ${op.op} of a step that isn't in the history`);
    if (edit) this.edits++;
  }

  private dropOp(op: OverlayOp): void {
    this.ops = this.ops.filter((o) => o !== op);
  }

  /** Applies one operation; false (and not kept) if its step isn't in the history. */
  private apply(op: OverlayOp): boolean {
    switch (op.op) {
      case 'workflowArgs':
        this.args = op.args;
        break;
      case 'truncate': {
        const from = this.order.get(op.from);
        const through = this.order.get(op.through);
        if (from === undefined || through === undefined) return false;
        this.nodes = this.nodes.filter((node) => {
          const i = node.recorded ? this.order.get(node.id)! : -1;
          return i < from || i > through;
        });
        break;
      }
      case 'insert': {
        const index = this.nodes.findIndex((node) => node.id === op.anchor);
        if (index < 0) return false;
        this.nodes.splice(op.where === 'after' ? index + 1 : index, 0, {
          id: op.id,
          name: op.name,
          kind: op.kind,
          args: op.args ?? {},
          argsKnown: op.args !== undefined,
          standIn: { result: op.result },
        });
        break;
      }
      case 'remove': {
        const index = this.nodes.findIndex((node) => node.id === op.target);
        if (index < 0) return false;
        this.nodes.splice(index, 1);
        break;
      }
      case 'rewrite': {
        const node = this.nodes.find((n) => n.id === op.target);
        if (!node) return false;
        node.rewritten = true;
        if (op.name !== undefined) node.name = op.name;
        if (op.args !== undefined) {
          node.args = op.args;
          node.argsKnown = true;
        }
        if ('result' in op) {
          if (node.standIn) node.standIn.result = op.result;
          else node.result = { value: op.result };
        }
        break;
      }
    }
    this.ops.push(op);
    return true;
  }

  private toStep(node: Node): HistoryStep {
    const base = { id: node.id, name: node.name, kind: node.kind, args: node.args };
    if (node.standIn) return { ...base, status: 'done', result: node.standIn.result };
    if (node.result) return { ...base, status: 'done', result: node.result.value };
    return { ...base, ...outcome(node.recorded!.runResult) };
  }
}

/** Why a run pauses instead of replaying, or instead of completing. */
export type PauseReason = Infer<typeof vPauseReason>;

/**
 * The run can't replay on this code: it pauses. `position` is where in the
 * history, if somewhere. `detail` is cut to `DETAIL_LIMIT` characters, so a
 * huge argument or error message can't make the pause too big to store.
 */
export class ReplayPause extends Error {
  public readonly detail: string;

  public constructor(
    public readonly reason: PauseReason,
    detail: string,
    public readonly position?: number,
    /** For a mismatch, whose parts are cut on their own. */
    limit?: number,
  ) {
    const capped = capDetail(detail, limit);
    super(capped);
    this.detail = capped;
    this.name = 'ReplayPause';
  }
}

/** Replay doesn't match the history: the code made a different call at `position`. The run pauses. */
export class ReplayMismatch extends ReplayPause {
  /** The call the code made, and the step the history has there, as JSON, each cut to `DETAIL_LIMIT` characters. */
  public readonly expected: string;
  public readonly recorded: string;

  public constructor(position: number, expected: string, recorded: string, standIn = false) {
    const [call, step] = [capDetail(expected), capDetail(recorded)];
    super(
      'mismatch',
      `Journal entry mismatch at step ${position}: the code calls ${call}, the history has ${step}${hint(expected, recorded, standIn)}`,
      position,
      Infinity,
    );
    this.expected = call;
    this.recorded = step;
    this.name = 'ReplayMismatch';
  }
}

function hint(expected: string, recorded: string, standIn: boolean): string {
  try {
    const [call, step] = [JSON.parse(expected) as { name?: string; kind?: string }, JSON.parse(recorded) as { name?: string; kind?: string }];
    if (standIn && call.name === step.name && call.kind === 'workflow' && step.kind === 'function') {
      return '. It was inserted as a function, and called as a workflow: insert it with { workflow: ref }.';
    }
  } catch {
    // Not JSON: no hint.
  }
  return '';
}

/** Whether two overlays store the same operations. */
export function sameOverlay(a: readonly OverlayOp[], b: readonly OverlayOp[]): boolean {
  return json(a) === json(b);
}
