// @vitest-environment node
// The `histories` CLI's reads, against a fake `convex run`.
import { expect, test } from 'vite-plus/test';

import { collectRuns, type PublicWorkflow, type Query, runHistory } from '../src/histories.ts';

/** Pages like Convex: a full page says it isn't done, even when nothing follows it. */
function paginate<T>(items: readonly T[], { numItems, cursor }: { numItems: number; cursor: string | null }) {
  const start = cursor === null ? 0 : Number(cursor);
  const page = items.slice(start, start + numItems);
  return { page, isDone: page.length < numItems, continueCursor: String(start + page.length) };
}

function deployment(runs: PublicWorkflow[], steps: number, record: object | null = null) {
  const calls: { path: string; numItems?: number }[] = [];
  const query: Query = <T>(_component: string, path: string, args: object): T => {
    const { paginationOpts } = args as { paginationOpts?: { numItems: number; cursor: string | null } };
    calls.push({ path, ...(paginationOpts ? { numItems: paginationOpts.numItems } : {}) });
    if (path === 'workflow:listByName') return paginate(runs, paginationOpts!) as T;
    if (path === 'workflow:listSteps') {
      const journal = Array.from({ length: steps }, (_, i) => ({ stepId: `s${i}`, name: `step${i}`, kind: 'function', args: {}, startedAt: i }));
      return paginate(journal, paginationOpts!) as T;
    }
    return record as T;
  };
  return { query, calls };
}
const running = (n: number): PublicWorkflow[] => Array.from({ length: n }, (_, i) => ({ workflowId: `w${i}`, args: {} }));

test('a workflow with exactly --max-runs runs has no more; one more does', () => {
  for (const maxRuns of [1, 2, 100, 150]) {
    expect(collectRuns(deployment(running(maxRuns), 0).query, 'workflow', 'p:run', { maxRuns, recent: 10 })).toMatchObject({
      scanned: maxRuns,
      more: false,
    });
    const over = collectRuns(deployment(running(maxRuns + 1), 0).query, 'workflow', 'p:run', { maxRuns, recent: 10 });
    expect(over).toMatchObject({ scanned: maxRuns, more: true, oldest: `w${maxRuns - 1}` });
    expect(over.runs).toHaveLength(maxRuns);
  }
});

test('collectRuns keeps every running run and the newest finished ones', () => {
  const runs: PublicWorkflow[] = [
    { workflowId: 'a', args: {}, runResult: { kind: 'success', returnValue: null } },
    { workflowId: 'b', args: {} },
    { workflowId: 'c', args: {}, runResult: { kind: 'failed', error: 'x' } },
    { workflowId: 'd', args: {} },
  ];
  expect(collectRuns(deployment(runs, 0).query, 'workflow', 'p:run', { maxRuns: 10, recent: 1 }).runs.map((r) => r.workflowId)).toEqual(['a', 'b', 'd']);
});

test('a run with exactly --max-steps steps is not truncated; one more is, and exports --max-steps of them', () => {
  const run = { workflowId: 'w', args: {} };
  const exact = runHistory(deployment([run], 3).query, { workflow: 'workflow' }, 'p:run', run, 3);
  expect(exact.steps).toHaveLength(3);
  expect(exact.truncated).toBeUndefined();
  const over = runHistory(deployment([run], 4).query, { workflow: 'workflow' }, 'p:run', run, 3);
  expect(over.steps.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
  expect(over.truncated).toBe(true);
});

test("runHistory exports the record's applied ids, overlay and pending restart, and refuses a newer format", () => {
  const run = { workflowId: 'w', args: {} };
  const record = { workflow: 'p:run', applied: ['m'], overlay: [{ op: 'remove', target: 's0' }], restart: 's1', format: 1 };
  const components = { workflow: 'workflow', migrations: 'workflowMigrations' };
  expect(runHistory(deployment([run], 2, record).query, components, 'p:run', run, 10)).toMatchObject({
    applied: ['m'],
    overlay: record.overlay,
    restart: 's1',
  });
  expect(() => runHistory(deployment([run], 2, { ...record, format: 2 }).query, components, 'p:run', run, 10)).toThrow('has format 2');
});
