// A run's history as migrations and replay see it: the journal with the
// run's overlay applied. Migrations edit it through `History`; the vendored
// executor replays the handler against `HistoryView.replay()`.
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { convexToJson, getConvexSize, type Infer, jsonToConvex, type Value } from 'convex/values';

import type { vOverlayOp, vStepKind } from './component/schema.ts';
import { safeFunctionName } from './vendor/workflow/safeFunctionName.ts';
import type { RunResult, WorkflowReturnType } from './vendor/workflow/types.ts';

export type StepKind = Infer<typeof vStepKind>;
export type OverlayOp = Infer<typeof vOverlayOp>;
type InsertOp = Extract<OverlayOp, { op: 'insert' }>;
type RewriteOp = Extract<OverlayOp, { op: 'rewrite' }>;

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
 * call made with a custom `name` option.
 */
export type InsertOptions<R> = { result: StepResult<R>; args?: StepArgs<R>; name?: string };

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
  /** The result replay gives the call instead of the recorded one, for a step whose return value changed shape. The step must have succeeded. */
  updateResult<R extends StepRef>(step: R | HistoryStep, update: (result: any) => StepResult<R>): void;
  /** The workflow's arguments as the current code's `args` validator expects them. The run keeps its recorded args; replay passes these. */
  updateWorkflowArgs(update: (args: any) => unknown): void;
}

/** One step of the history the handler replays against. */
export type ReplayEntry = {
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
};

const clone = <T>(value: T): T => (value === undefined ? value : (jsonToConvex(convexToJson(value as Value)) as T));
const json = (value: unknown) => JSON.stringify(convexToJson(value as Value));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  private argsChanged = false;
  private nextId = 1;
  /** The migration running now, and the operations each one added and the edits it made. */
  private migrating: string | undefined;
  private readonly origin = new Map<OverlayOp, string>();
  private readonly edits = new Map<string, number>();

  /**
   * The journal with `overlay` applied in order, for a run started with
   * `args`. Operations whose step is gone from the journal (a restart deleted
   * it) are dropped.
   */
  public constructor(journal: readonly RecordedStep[], overlay: readonly OverlayOp[] = [], args: unknown = {}) {
    this.order = new Map(journal.map((step, i) => [step.id, i]));
    this.nodes = journal.map((step) => ({ id: step.id, name: step.name, kind: step.kind, args: step.args, argsKnown: true, recorded: step }));
    this.args = clone(args);
    for (const op of overlay) {
      if ('id' in op) this.nextId = Math.max(this.nextId, Number(op.id.slice(1)) + 1 || 0);
      this.apply(clone(op));
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
   * For `restartFrom`: removes every step from `position` on. The journal
   * entries go in one operation, which leaves entries recorded later alone.
   */
  public truncate(position: number): void {
    const rest = this.nodes.slice(position);
    for (const node of rest) {
      if (node.recorded && !node.recorded.runResult) throw new Error(`Can't restart from step ${position}: ${node.name} (${node.id}) is still running.`);
    }
    const first = rest.find((node) => node.recorded);
    const last = [...this.order.keys()].at(-1);
    if (first && last !== undefined) this.push({ op: 'truncate', from: first.id, through: last });
    for (const node of rest) if (!node.recorded) this.push({ op: 'remove', target: node.id });
  }

  /**
   * For `restart({ from: position })`: the journal entry upstream's restart
   * deletes the journal from (none if no recorded step is at or after
   * `position`), and an overlay that gives the steps before `position` on
   * the journal that's left. Throws if those steps are all stand-ins, which
   * have no journal entry to keep their place.
   */
  public cut(position: number): { from?: string; overlay: OverlayOp[] } {
    const kept = this.nodes.slice(0, position);
    const from = this.nodes.slice(position).find((node) => node.recorded)?.id;
    const journal = [...this.order.keys()].slice(0, from === undefined ? undefined : this.order.get(from));
    const firstRecorded = kept.find((node) => node.recorded);
    if (!firstRecorded && kept.length > 0) {
      throw new Error(`Can't restart from step ${position}: every step before it was inserted by a migration. Restart from step 0 instead.`);
    }
    const ops: OverlayOp[] = [];
    if (this.argsChanged) ops.push({ op: 'workflowArgs', args: clone(this.args) });
    // Journal entries the history doesn't show, as ranges.
    const visible = new Set(kept.map((node) => node.id));
    for (let i = 0; i < journal.length; i++) {
      if (visible.has(journal[i]!)) continue;
      let j = i;
      while (j + 1 < journal.length && !visible.has(journal[j + 1]!)) j++;
      ops.push(i === j ? { op: 'remove', target: journal[i]! } : { op: 'truncate', from: journal[i]!, through: journal[j]! });
      i = j;
    }
    let previous: Node | undefined;
    for (const node of kept) {
      if (node.recorded) {
        const rewrite: RewriteOp = { op: 'rewrite', target: node.id };
        if (node.name !== node.recorded.name) rewrite.name = node.name;
        if (json(node.args) !== json(node.recorded.args)) rewrite.args = clone(node.args);
        if (node.result) rewrite.result = clone(node.result.value);
        if (Object.keys(rewrite).length > 2) ops.push(rewrite);
      } else {
        const anchor = previous ? { where: 'after' as const, anchor: previous.id } : { where: 'before' as const, anchor: firstRecorded!.id };
        const insert: InsertOp = { op: 'insert', id: node.id, ...anchor, name: node.name, kind: node.kind, result: clone(node.standIn!.result) };
        if (node.argsKnown) insert.args = clone(node.args);
        ops.push(insert);
      }
      previous = node;
    }
    return { ...(from === undefined ? {} : { from }), overlay: ops };
  }

  /** The position of the last step named `name` or matching `ref`, for `restart({ from })`; -1 if there's none. */
  public lastPosition(step: string | StepRef): number {
    return this.nodes.findLastIndex((node) => (typeof step === 'string' ? node.name === step : this.matches(node, step)));
  }

  // ---------------------------------------------- for migrations and replay ---

  /** Runs `migrate` as migration `id`, so its edits are counted and its operations attributed. Returns how many edits it made. */
  public migrateAs(id: string, migrate: () => void): number {
    this.migrating = id;
    this.edits.set(id, this.edits.get(id) ?? 0);
    try {
      migrate();
    } finally {
      this.migrating = undefined;
    }
    return this.edits.get(id) ?? 0;
  }

  /** Each migration that ran on this view, in order, with how many edits it made. */
  public editsBy(): ReadonlyMap<string, number> {
    return this.edits;
  }

  /** The operations to store: the overlay as loaded, minus dropped ones, plus this handler run's. */
  public overlay(): OverlayOp[] {
    return this.ops.map(clone);
  }

  /** The stored size of the overlay, in bytes, and the migration whose operations take the most of it. */
  public size(): { bytes: number; largest?: { id: string; bytes: number } } {
    const by = new Map<string, number>();
    let bytes = 0;
    for (const op of this.ops) {
      const size = getConvexSize(op as Value);
      bytes += size;
      const id = this.origin.get(op);
      if (id !== undefined) by.set(id, (by.get(id) ?? 0) + size);
    }
    const [id, most] = [...by].reduce<[string | undefined, number]>((top, entry) => (entry[1] > top[1] ? entry : top), [undefined, 0]);
    return { bytes, ...(id === undefined ? {} : { largest: { id, bytes: most } }) };
  }

  /** Whether the step at `position` is a stand-in or has a result a migration changed: the handler got it from a migration, not from the run. */
  public fromMigration(position: number): boolean {
    const node = this.nodes[position];
    return node !== undefined && (node.standIn !== undefined || node.result !== undefined);
  }

  /** Whether the step at `position` or a later one is a journal entry. */
  public recordedFrom(position: number): boolean {
    return this.nodes.slice(position).some((node) => node.recorded);
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
    const id = `+${this.nextId++}`;
    if (!('result' in options)) throw new Error(`${action}(${describe(anchor)}, ${name}): pass { result } for the stand-in.`);
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

  private push(op: OverlayOp): void {
    if (!this.apply(op)) throw new Error(`Assertion failed: ${op.op} of a step that isn't in the history`);
    if (this.migrating !== undefined) {
      this.origin.set(op, this.migrating);
      this.edits.set(this.migrating, (this.edits.get(this.migrating) ?? 0) + 1);
    }
  }

  private dropOp(op: OverlayOp): void {
    this.ops = this.ops.filter((o) => o !== op);
    this.origin.delete(op);
  }

  /** Applies one operation; false (and not kept) if its step isn't in the history. */
  private apply(op: OverlayOp): boolean {
    switch (op.op) {
      case 'workflowArgs':
        this.args = op.args;
        this.argsChanged = true;
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
export type PauseReason = 'mismatch' | 'args' | 'threw' | 'migration' | 'migrations' | 'overlay' | 'error';

/** The run can't replay on this code: it pauses. `position` is where in the history, if somewhere. */
export class ReplayPause extends Error {
  public constructor(
    public readonly reason: PauseReason,
    public readonly detail: string,
    public readonly position?: number,
  ) {
    super(detail);
    this.name = 'ReplayPause';
  }
}

/** Replay doesn't match the history: the code made a different call at `position`. The run pauses. */
export class ReplayMismatch extends ReplayPause {
  public constructor(
    position: number,
    /** The call the code made, and the step the history has there, as JSON. */
    public readonly expected: string,
    public readonly recorded: string,
    standIn = false,
  ) {
    super(
      'mismatch',
      `Journal entry mismatch at step ${position}: the code calls ${expected}, the history has ${recorded}${hint(expected, recorded, standIn)}`,
      position,
    );
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

/** Where replay got to when the handler threw or returned: the first history step it hasn't called, and whether it started a step past the history. */
export type ReplayProgress = { next?: { position: number }; started: boolean };

/**
 * Whether a handler that returned should pause the run instead of
 * completing it: it returned before calling every step of its history.
 */
export function returnedEarly(history: HistoryView, progress: ReplayProgress): ReplayPause | undefined {
  const next = progress.next;
  if (!next) return undefined;
  const step = history.steps[next.position]!;
  return new ReplayPause(
    'mismatch',
    `Journal entry mismatch at step ${next.position}: the code returned before it, the history has ${json({ args: step.args, kind: step.kind, name: step.name })}`,
    next.position,
  );
}

/**
 * What `threwEarly` knows about the handler run: whether the args validated,
 * whether the run has journal entries, which migrations edited its history in
 * this handler run, and whether only an unreplayed recorded step counts (for
 * a history whose run is known to have failed).
 */
export type ThrowContext = { validated: boolean; hasHistory: boolean; editedNow: readonly string[]; recordedOnly?: boolean };

/**
 * Whether a handler that threw should pause the run instead of failing it.
 * Its throw is a reaction to the run, and fails it, only if it came after the
 * handler had called every recorded step of its history, the last step it
 * got was recorded rather than made up by a migration, no migration edited
 * the history in this handler run, and it hadn't started a step past the
 * history. Otherwise the code and the history may disagree. Args that don't
 * validate pause a run that has history, and fail a new one.
 */
export function threwEarly(history: HistoryView, progress: ReplayProgress, error: unknown, context: ThrowContext): ReplayPause | undefined {
  if (error instanceof ReplayPause) return error;
  if (!context.validated) {
    return context.hasHistory ? new ReplayPause('args', `The workflow's args don't match its args validator: ${message(error)}`) : undefined;
  }
  if (progress.started) return undefined;
  const next = progress.next?.position ?? history.length;
  if (history.recordedFrom(next)) {
    return new ReplayPause('threw', `The handler threw before step ${next} of its history: ${message(error)}`, next);
  }
  if (context.recordedOnly) return undefined;
  if (next > 0 && history.fromMigration(next - 1)) {
    return new ReplayPause(
      'threw',
      `The handler threw after step ${next - 1} of its history, which a migration inserted or changed: ${message(error)}`,
      next - 1,
    );
  }
  if (context.editedNow.length > 0) {
    const ids = context.editedNow.map((id) => `"${id}"`).join(', ');
    return new ReplayPause('threw', `The handler threw after migrations ${ids} changed its history: ${message(error)}`);
  }
  return undefined;
}

/** Whether two overlays store the same operations. */
export function sameOverlay(a: readonly OverlayOp[], b: readonly OverlayOp[]): boolean {
  return json(a) === json(b);
}
