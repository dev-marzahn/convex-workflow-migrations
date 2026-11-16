// @vitest-environment node
// The `histories` CLI, against a fake `convex` CLI and deployment.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vite-plus/test';

import { type Convex, main, READS } from '../src/histories.ts';
import type { RecordedHistory } from '../src/history.ts';
import type { RunResult } from '../src/vendor/workflow/types.ts';

type Run = { workflowId: string; runResult?: RunResult; steps?: number; ok?: boolean; gone?: true; record?: object | (() => object) };

/** Pages like Convex: a full page says it isn't done, even when nothing follows it. */
function paginate<T>(items: readonly T[], { numItems, cursor }: { numItems: number; cursor: string | null }) {
  const start = cursor === null ? 0 : Number(cursor);
  const page = items.slice(start, start + numItems);
  return { page, isDone: page.length < numItems, continueCursor: String(start + page.length) };
}

/** A deployment's runs of `p:run`, oldest first, behind a fake `convex` CLI that records its calls. */
function deployment(runs: Run[], { component = true } = {}) {
  const calls: { path: string; numItems?: number; extra: string[] }[] = [];
  const reply = (value: unknown) => ({ ok: true, stdout: value === null ? '' : JSON.stringify(value), output: '' });
  const convex: Convex = (argv) => {
    if (argv[0] === 'data') {
      calls.push({ path: 'data', extra: argv.slice(3) });
      return component ? reply('runs\npauses') : { ok: false, stdout: '', output: "Component path 'workflowMigrations' not found" };
    }
    const [path, args] = [argv[3]!, JSON.parse(argv[4]!)];
    calls.push({ path, extra: argv.slice(5), ...(args.paginationOpts ? { numItems: args.paginationOpts.numItems } : {}) });
    const run = runs.find((r) => r.workflowId === args.workflowId);
    if (path === 'workflow:listByName') return reply(paginate([...runs].reverse(), args.paginationOpts));
    if (path === 'runs:load') return reply(typeof run?.record === 'function' ? run.record() : (run?.record ?? null));
    if (!run || run.gone) return { ok: false, stdout: '', output: `Uncaught Error: Workflow not found: ${args.workflowId}` };
    if (path === 'workflow:getStatus') return reply({ workflow: { _creationTime: runs.indexOf(run) * 1000 } });
    const journalEntries = Array.from({ length: run.steps ?? 1 }, (_, i) => ({
      _id: `${run.workflowId}.${i}`,
      stepNumber: i,
      // Older upstream versions wrote entries without a kind.
      step: { name: `step${i}`, ...(i === 0 ? {} : { kind: 'function' }), args: {}, inProgress: false, runResult: done, startedAt: i },
    }));
    return reply({ workflow: { args: { n: run.workflowId } }, journalEntries, ok: run.ok ?? true });
  };
  return { convex, calls };
}
const done: RunResult = { kind: 'success', returnValue: null };

function cli(argv: string[], { convex }: { convex: Convex }) {
  const [stdout, stderr] = [[] as string[], [] as string[]];
  const code = main(argv, { convex, stdout: (text) => stdout.push(text), stderr: (line) => stderr.push(line) });
  return { code, histories: stdout.length > 0 ? (JSON.parse(stdout.join('')) as RecordedHistory[]) : undefined, stderr: stderr.join('\n') };
}
const ids = (histories?: RecordedHistory[]) => histories?.map((h) => h.workflowId);

test('it pages through the runs newest first, and exports every running one and the newest --recent that succeeded', () => {
  const ended: Record<number, RunResult> = { 249: { kind: 'failed', error: 'gave up' }, 247: { kind: 'canceled' } };
  const runs: Run[] = Array.from({ length: 250 }, (_, i) => ({ workflowId: `r${i}`, ...(i % 50 === 0 ? {} : { runResult: ended[i] ?? done }) }));
  const d = deployment(runs);
  const { code, histories, stderr } = cli(['histories', 'p:run', '--recent', '2', '--', '--prod'], d);
  expect(code).toBe(0);
  // r249 failed and r247 was canceled: they never replay again.
  expect(ids(histories)).toEqual(['r248', 'r246', 'r200', 'r150', 'r100', 'r50', 'r0']);
  expect(histories![0]).toMatchObject({ args: { n: 'r248' }, steps: [{ id: 'r248.0', kind: 'function' }], encoding: 'json' });
  // Three pages of at most 100, and the convex options on every call.
  expect(d.calls.filter((c) => c.path === 'workflow:listByName').map((c) => c.numItems)).toEqual([100, 100, 100]);
  expect(d.calls.every((c) => c.extra.join(' ') === '--prod')).toBe(true);
  expect(stderr).toContain('Exported 7 histories of p:run.');
  expect(stderr).toContain("The export holds production data: every run's args");
});

test('--max-scan stops the scan: exit 1 with how many runs it read and the oldest, unless --allow-partial; exactly that many is not more', () => {
  const runs = (n: number): Run[] => Array.from({ length: n }, (_, i) => ({ workflowId: `r${i}` }));
  for (const maxScan of [1, 100, 150]) {
    const exact = cli(['histories', 'p:run', '--max-scan', String(maxScan)], deployment(runs(maxScan)));
    expect(exact.code).toBe(0);
    expect(exact.histories).toHaveLength(maxScan);
    const d = deployment(runs(maxScan + 1));
    const over = cli(['histories', 'p:run', '--max-scan', String(maxScan)], d);
    expect(over.code).toBe(1);
    expect(over.histories).toBeUndefined();
    // The oldest it read is r1, created at 1000 ms.
    expect(over.stderr).toContain(
      `p:run has more than --max-scan ${maxScan} runs. The export read the newest ${maxScan}, the oldest created 1970-01-01T00:00:01.000Z`,
    );
    expect(over.stderr).toContain('pass --allow-partial');
    // It asks for no more than it may read: maxScan + 1 in all.
    expect(d.calls.filter((c) => c.path === 'workflow:listByName').reduce((n, c) => n + c.numItems!, 0)).toBe(maxScan + 1);
    const partial = cli(['histories', 'p:run', '--max-scan', String(maxScan), '--allow-partial'], deployment(runs(maxScan + 1)));
    expect(partial.code).toBe(0);
    // r0, the oldest, is the one it didn't see.
    expect(ids(partial.histories)).not.toContain('r0');
    expect(partial.histories).toHaveLength(maxScan);
  }
});

test('the --max-scan stop leaves the date out when the oldest run it read is gone', () => {
  const { code, stderr } = cli(['histories', 'p:run', '--max-scan', '1'], deployment([{ workflowId: 'r0' }, { workflowId: 'r1', gone: true }]));
  expect(code).toBe(1);
  expect(stderr).toContain('p:run has more than --max-scan 1 runs. The export read the newest 1, so older running runs may be missing.');
});

test('a run with exactly --max-steps steps is not truncated; one more is', () => {
  const runs: Run[] = [
    { workflowId: 'exact', steps: 3 },
    { workflowId: 'over', steps: 4 },
  ];
  const { histories } = cli(['histories', 'p:run', '--max-steps', '3'], deployment(runs));
  const [over, exact] = histories!;
  expect(exact!.steps).toHaveLength(3);
  expect(exact!.truncated).toBeUndefined();
  expect(over!.steps.map((s) => s.id)).toEqual(['over.0', 'over.1', 'over.2']);
  expect(over!.truncated).toBe(true);
});

test('a run whose journal is too big to load is left out, with a note naming it', () => {
  const runs: Run[] = [{ workflowId: 'small' }, { workflowId: 'big', steps: 2, ok: false }, { workflowId: 'big2', ok: false, runResult: done }];
  const { code, histories, stderr } = cli(['histories', 'p:run'], deployment(runs));
  expect(code).toBe(0);
  expect(ids(histories)).toEqual(['small']);
  expect(stderr).toContain('Skipped 2 runs whose journal is over 8 MiB, too big to load; upstream fails a running one at its next handler run: big2, big.');
  expect(stderr).toContain('Exported 1 histories of p:run.');
});

test('no runs of that name exits 2, saying what the name is', () => {
  const { code, histories, stderr } = cli(['histories', 'pipeline.run'], deployment([]));
  expect(code).toBe(2);
  expect(histories).toBeUndefined();
  expect(stderr).toBe("No runs named pipeline.run; the name is the function's path, e.g. `pipeline:run`.");
});

test('--out creates its directory before the scan, and a path it cannot write to fails before the scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'histories-'));
  try {
    const out = join(dir, 'missing/nested/histories.json');
    const { code, stderr } = cli(['histories', 'p:run', '--out', out], deployment([{ workflowId: 'r0' }]));
    expect(code).toBe(0);
    expect(ids(JSON.parse(readFileSync(out, 'utf8')) as RecordedHistory[])).toEqual(['r0']);
    expect(stderr).toContain(`Exported 1 histories of p:run to ${out}.`);
    // Its parent is a file.
    const d = deployment([{ workflowId: 'r0' }]);
    const blocked = cli(['histories', 'p:run', '--out', join(out, 'histories.json')], d);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain(`EEXIST: file already exists, mkdir '${out}'`);
    // Its directory is read-only.
    const readOnly = join(dir, 'read-only');
    mkdirSync(readOnly, { mode: 0o500 });
    const denied = cli(['histories', 'p:run', '--out', join(readOnly, 'histories.json')], d);
    expect(denied.code).toBe(2);
    expect(denied.stderr).toContain('EACCES');
    expect(d.calls).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("it exports the record's applied ids and overlay, reading it around the journal until they agree, else marking the history unstable", () => {
  const overlay = [{ op: 'remove', target: 's0' }];
  let [onceReads, alwaysReads] = [0, 0];
  const runs: Run[] = [
    { workflowId: 'recorded', record: { applied: ['m'], overlay } },
    // Changes once, between the first two reads: the next read agrees.
    { workflowId: 'once', record: () => ({ applied: onceReads++ === 0 ? [] : ['m'], overlay: [] }) },
    // Changes on every read.
    { workflowId: 'always', record: () => ({ applied: [`m${alwaysReads++}`], overlay: [] }) },
    // Listed, but gone by the time it's read.
    { workflowId: 'gone', gone: true },
  ];
  const d = deployment(runs);
  const [always, once, recorded] = cli(['histories', 'p:run'], d).histories!;
  expect(recorded).toMatchObject({ applied: ['m'], overlay });
  expect(recorded!.unstable).toBeUndefined();
  expect(once).toMatchObject({ applied: ['m'] });
  expect(once!.unstable).toBeUndefined();
  expect(onceReads).toBe(3);
  expect(always!.unstable).toBe(true);
  expect(alwaysReads).toBe(READS + 1);
  expect(d.calls.filter((c) => c.path === 'journal:load')).toHaveLength(1 + 2 + READS + 1);
});

test('without the migrations component it exits 2, unless --before-adoption: then every run is exported without applied, with a note', () => {
  const runs: Run[] = [{ workflowId: 'old', record: { applied: ['m'], overlay: [] } }];
  const missing = cli(['histories', 'p:run'], deployment(runs, { component: false }));
  expect(missing.code).toBe(2);
  expect(missing.histories).toBeUndefined();
  expect(missing.stderr).toContain("The workflowMigrations component isn't deployed. If this package's component is mounted under another name");
  expect(missing.stderr).toContain('pass --before-adoption');

  const d = deployment(runs, { component: false });
  const { code, histories, stderr } = cli(['histories', 'p:run', '--before-adoption'], d);
  expect(code).toBe(0);
  expect(histories).toEqual([
    {
      workflowId: 'old',
      args: { n: 'old' },
      steps: [{ id: 'old.0', name: 'step0', kind: 'function', args: {}, runResult: done, startedAt: 0 }],
      encoding: 'json',
    },
  ]);
  expect(stderr).toContain('The workflowMigrations component isn\'t deployed: every run is exported without "applied"');
  expect(d.calls.some((c) => c.path === 'runs:load')).toBe(false);

  // With the component deployed, the app has adopted the package.
  const adopted = cli(['histories', 'p:run', '--before-adoption'], deployment(runs));
  expect(adopted).toMatchObject({
    code: 2,
    stderr: 'The workflowMigrations component is deployed, so the app has adopted this package: drop --before-adoption.',
  });
});

test('usage and deployment errors exit 2', () => {
  const d = deployment([]);
  for (const argv of [['histories'], ['histories', 'a', 'b'], ['histories', 'p:run', '--max-scan', '0'], ['histories', 'p:run', '--bogus'], ['export']]) {
    const { code, stderr } = cli(argv, d);
    expect(code, argv.join(' ')).toBe(2);
    expect(stderr).toContain('Usage: convex-workflow-migrations histories');
  }
  const unreachable: Convex = () => ({ ok: false, stdout: '', output: 'Error: fetch failed' });
  expect(cli(['histories', 'p:run'], { convex: unreachable })).toMatchObject({ code: 2, stderr: expect.stringContaining('fetch failed') });
});
