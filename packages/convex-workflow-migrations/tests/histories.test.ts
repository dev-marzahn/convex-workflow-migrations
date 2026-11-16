// @vitest-environment node
// The `histories` CLI's reads, against a fake `convex run`.
import { expect, test } from 'vite-plus/test';

import { collectRuns, type PublicWorkflow, type Query, READS, runHistory } from '../src/histories.ts';

/** Pages like Convex: a full page says it isn't done, even when nothing follows it. */
function paginate<T>(items: readonly T[], { numItems, cursor }: { numItems: number; cursor: string | null }) {
  const start = cursor === null ? 0 : Number(cursor);
  const page = items.slice(start, start + numItems);
  return { page, isDone: page.length < numItems, continueCursor: String(start + page.length) };
}

type Run = PublicWorkflow & { origin?: 'start' | 'child' | 'adopted'; live?: boolean };
type Entry = { _id: string; stepNumber: number; step: { name: string; kind?: string; args: object; inProgress: boolean; startedAt: number } };

/** A deployment's runs, oldest first, and their journals and records. */
function deployment(runs: Run[], { steps = 0, ok = true, record = null as object | null | (() => object | null) } = {}) {
  const calls: { path: string; order?: string; numItems?: number }[] = [];
  const journal: Entry[] = Array.from({ length: steps }, (_, i) => ({
    _id: `s${i}`,
    stepNumber: i,
    // Older upstream versions wrote entries without a kind.
    step: { name: `step${i}`, ...(i === 0 ? {} : { kind: 'function' }), args: {}, inProgress: false, startedAt: i },
  }));
  const query: Query = <T>(_component: string, path: string, args: object): T => {
    const { paginationOpts, order, workflowId, workflowIds } = args as {
      paginationOpts?: { numItems: number; cursor: string | null };
      order?: string;
      workflowId?: string;
      workflowIds?: string[];
    };
    calls.push({ path, ...(order ? { order } : {}), ...(paginationOpts ? { numItems: paginationOpts.numItems } : {}) });
    if (path === 'workflow:listByName') return paginate(order === 'desc' ? [...runs].reverse() : runs, paginationOpts!) as T;
    if (path === 'runs:live')
      return paginate(
        runs.filter((run) => run.live).map((run) => run.workflowId),
        paginationOpts!,
      ) as T;
    if (path === 'runs:origins')
      return runs.filter((run) => workflowIds!.includes(run.workflowId) && run.origin).map(({ workflowId, origin }) => ({ workflowId, origin })) as T;
    if (path === 'journal:load') {
      const run = runs.find((r) => r.workflowId === workflowId);
      if (!run) throw new Error(`convex run --component workflow journal:load failed:\nUncaught Error: Workflow not found: ${workflowId}`);
      return {
        workflow: { _creationTime: runs.indexOf(run), args: run.args, ...(run.runResult ? { runResult: run.runResult } : {}) },
        journalEntries: journal,
        ok,
      } as T;
    }
    return (typeof record === 'function' ? record() : record) as T;
  };
  return { query, calls };
}
const done = { kind: 'success' as const, returnValue: null };
const both = { workflow: 'workflow', migrations: 'workflowMigrations' };

test('the running runs come from the component; upstream is scanned only for runs from before adoption, up to the first this package started', () => {
  const runs: Run[] = [
    // From before adoption: one still running without a record, one finished, one that got a record at its first handler run since.
    { workflowId: 'p0', args: {} },
    { workflowId: 'p1', args: {}, runResult: done },
    { workflowId: 'p2', args: {}, origin: 'adopted', live: true },
    // Started by this package.
    { workflowId: 'a0', args: {}, origin: 'start', live: true },
    { workflowId: 'a1', args: {}, origin: 'start', runResult: done },
    ...Array.from({ length: 300 }, (_, i): Run => ({ workflowId: `b${i}`, args: {}, origin: 'child', live: true })),
  ];
  const { query, calls } = deployment(runs);
  const collected = collectRuns(query, both, 'p:run', { maxRuns: 1000, recent: 2 });
  expect(collected.running).toEqual(['p2', 'a0', ...runs.slice(5).map((run) => run.workflowId), 'p0']);
  expect(collected.finished).toEqual(['a1', 'p1']);
  expect(collected).toMatchObject({ scanned: 3, more: false, last: 'p2' });
  // One page of the oldest runs, not every run.
  expect(calls.filter((call) => call.path === 'workflow:listByName' && call.order === 'asc')).toHaveLength(1);
  expect(calls.filter((call) => call.path === 'runs:origins')).toHaveLength(1);
});

test('--max-runs bounds the scan of runs from before adoption alone; exactly that many is not more', () => {
  const before = (n: number): Run[] => Array.from({ length: n }, (_, i) => ({ workflowId: `p${i}`, args: {} }));
  const after = Array.from({ length: 150 }, (_, i): Run => ({ workflowId: `a${i}`, args: {}, origin: 'start', live: true }));
  for (const maxRuns of [1, 2, 100, 150]) {
    const exact = collectRuns(deployment([...before(maxRuns), ...after]).query, both, 'p:run', { maxRuns, recent: 0 });
    expect(exact).toMatchObject({ scanned: maxRuns, more: false });
    // Every live run, whatever --max-runs is.
    expect(exact.running).toHaveLength(150 + maxRuns);
    const over = collectRuns(deployment([...before(maxRuns + 1), ...after]).query, both, 'p:run', { maxRuns, recent: 0 });
    expect(over).toMatchObject({ scanned: maxRuns, more: true, last: `p${maxRuns - 1}` });
    // The newer ones from before adoption are the ones left out.
    expect(over.running).not.toContain(`p${maxRuns}`);
  }
  // Without the migrations component, every run is from before adoption.
  expect(collectRuns(deployment(after).query, { workflow: 'workflow' }, 'p:run', { maxRuns: 150, recent: 0 })).toMatchObject({ scanned: 150, more: false });
  expect(collectRuns(deployment(after).query, { workflow: 'workflow' }, 'p:run', { maxRuns: 149, recent: 0 })).toMatchObject({ more: true });
});

test('a run with exactly --max-steps steps is not truncated; one more is, and so is a journal too big to load', () => {
  const runs = [{ workflowId: 'w', args: {} }];
  const exact = runHistory(deployment(runs, { steps: 3 }).query, { workflow: 'workflow' }, 'p:run', 'w', 3)!;
  expect(exact.history.steps).toHaveLength(3);
  expect(exact.history.truncated).toBeUndefined();
  const over = runHistory(deployment(runs, { steps: 4 }).query, { workflow: 'workflow' }, 'p:run', 'w', 3)!;
  expect(over.history.steps.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
  expect(over.history.truncated).toBe(true);
  expect(runHistory(deployment(runs, { steps: 2, ok: false }).query, { workflow: 'workflow' }, 'p:run', 'w', 3)!.history.truncated).toBe(true);
  // Read raw: an entry without a kind is a function call.
  expect(exact.history.steps[0]).toMatchObject({ id: 's0', kind: 'function' });
  // A workflow that's gone has no history.
  expect(runHistory(deployment(runs).query, { workflow: 'workflow' }, 'p:run', 'gone', 3)).toBeUndefined();
});

test("runHistory exports the record's applied ids, overlay and pending restart, and refuses a newer format", () => {
  const runs = [{ workflowId: 'w', args: {} }];
  const record = { workflow: 'p:run', applied: ['m'], overlay: [{ op: 'remove', target: 's0' }], restart: 's1', format: 1 };
  expect(runHistory(deployment(runs, { steps: 2, record }).query, both, 'p:run', 'w', 10)!.history).toMatchObject({
    applied: ['m'],
    overlay: record.overlay,
    restart: 's1',
  });
  // A child's record before its first handler run doesn't say what's applied.
  const child = runHistory(deployment(runs, { record: { ...record, applied: undefined } }).query, both, 'p:run', 'w', 10)!.history;
  expect('applied' in child).toBe(false);
  expect(() => runHistory(deployment(runs, { steps: 2, record: { ...record, format: 2 } }).query, both, 'p:run', 'w', 10)).toThrow('has format 2');
});

test('runHistory reads the record around the journal, and marks the history unstable if they never agree', () => {
  const runs = [{ workflowId: 'w', args: {} }];
  // Changes once, between the first two reads: the next read agrees.
  let reads = 0;
  const once = () => ({ applied: reads++ === 0 ? [] : ['m'], overlay: [], format: 1 });
  const settled = runHistory(deployment(runs, { record: once }).query, both, 'p:run', 'w', 10)!.history;
  expect(settled).toMatchObject({ applied: ['m'] });
  expect(settled.unstable).toBeUndefined();
  // Changes on every read.
  let n = 0;
  const always = () => ({ applied: [`m${n++}`], overlay: [], format: 1 });
  expect(runHistory(deployment(runs, { record: always }).query, both, 'p:run', 'w', 10)!.history.unstable).toBe(true);
  expect(n).toBe(READS + 1);
});
