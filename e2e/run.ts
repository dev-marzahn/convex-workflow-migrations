// End-to-end tests on a real self-hosted backend: a fixture app starts a run
// that waits on `awaitEvent`, another fixture app is deployed over it as a
// later release, and the run finishes on the new code, or pauses.
//
//   bun run e2e                 all scenarios
//   bun run e2e skip            only these
//
// Needs Docker. Builds the package first.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { type Backend, startBackend } from './backend.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'convex-workflow-migrations-e2e';

function exec(cmd: string, args: string[], options: SpawnSyncOptions = {}): { stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...options });
  const [stdout, stderr] = [String(result.stdout ?? ''), String(result.stderr ?? '')];
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${`${stdout}\n${stderr}`.trim().slice(-3000)}`);
  return { stdout, stderr };
}
const sh = (cmd: string, args: string[], options: SpawnSyncOptions = {}) => exec(cmd, args, options).stdout;
const log = (message: string) => console.log(message);

// ------------------------------------------------------------------ apps ---

const appDir = (app: string) => join(ROOT, 'e2e/apps', app);
const convex = (app: string, backend: Backend, args: string[]) =>
  sh(join(appDir(app), 'node_modules/.bin/convex'), args, { cwd: appDir(app), env: backend.env });

function deploy(app: string, backend: Backend): void {
  log(`  deploying ${app}`);
  convex(app, backend, ['deploy', '-y', '--codegen', 'disable', '--typecheck', 'disable']);
}

function call<T>(app: string, backend: Backend, fn: string, args: Record<string, unknown>, component?: string): T {
  // `convex run` prints nothing for a null result.
  const out = convex(app, backend, ['run', ...(component ? ['--component', component] : []), fn, JSON.stringify(args)]).trim();
  return (out ? JSON.parse(out) : null) as T;
}

/** Calls a function that should throw, and returns what `convex run` printed. */
function callFails(app: string, backend: Backend, fn: string, args: Record<string, unknown>): string {
  const result = spawnSync(join(appDir(app), 'node_modules/.bin/convex'), ['run', fn, JSON.stringify(args)], {
    cwd: appDir(app),
    env: backend.env,
    encoding: 'utf8',
  });
  if (result.status === 0) throw new Error(`${fn} ${JSON.stringify(args)} was expected to throw, and returned ${result.stdout.trim()}`);
  return `${result.stdout}\n${result.stderr}`;
}

type Ids = { grabId: string; workflowId: string };
type Grab = { log: string[]; status: string; error?: string };
type Pauses = { paused: { reason: string; attempts: number } | null; alerts: string[] };

async function until<T>(read: () => T, done: (value: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await sleep(500);
  }
}
const grab = (app: string, backend: Backend, { grabId }: Ids) => call<Grab>(app, backend, 'pipeline:status', { grabId });
const pauses = (app: string, backend: Backend, { workflowId }: Ids) => call<Pauses>(app, backend, 'pipeline:pauses', { workflowId });
type RunRecord = { applied?: string[]; origin: string; parent?: string; live: boolean; paused?: unknown };
const record = (app: string, backend: Backend, { workflowId }: { workflowId: string }) =>
  call<RunRecord | null>(app, backend, 'runs:load', { workflowId }, 'workflowMigrations');
/** A run's status in upstream's component: its result, if it has finished. */
const runResult = (app: string, backend: Backend, workflowId: string) =>
  call<{ workflow: { runResult?: { kind: string } } }>(app, backend, 'workflow:getStatus', { workflowId }, 'workflow').workflow.runResult;
/** How many entries upstream's journal of a run has, hidden ones included. */
const journalLength = (app: string, backend: Backend, workflowId: string) =>
  call<{ page: unknown[] }>(app, backend, 'workflow:listSteps', { workflowId, order: 'asc', paginationOpts: { numItems: 1000, cursor: null } }, 'workflow').page
    .length;

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Runs the package's `bin` from an app's dependency on it, as a developer
 * would. Resolved through package.json rather than node_modules/.bin, which a
 * fresh install doesn't link before the first build.
 */
function cliRun(app: string, backend: Backend, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const pkg = join(appDir(app), 'node_modules/@dev-marzahn/convex-workflow-migrations');
  const bin = (JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { bin: Record<string, string> }).bin['convex-workflow-migrations']!;
  const result = spawnSync(process.execPath, [join(pkg, bin), ...args], { cwd: appDir(app), env: backend.env, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function cli(app: string, backend: Backend, args: string[]): { stdout: string; stderr: string } {
  const result = cliRun(app, backend, args);
  if (result.status !== 0) throw new Error(`convex-workflow-migrations ${args.join(' ')} failed:\n${`${result.stdout}\n${result.stderr}`.trim().slice(-3000)}`);
  return result;
}
const REDACT = join(ROOT, 'e2e/redact.ts');

type Exported = {
  workflowId: string;
  args: { grabId: string };
  steps: { name: string; args: { grabId?: string }; runResult?: unknown }[];
  applied?: string[];
  overlay?: { op: string; args?: unknown; result?: unknown }[];
};

const ALL = ['notify-after-grab', 'import-gets-notified-at', 'prepare-becomes-transcode'];
/** Release 4's list. */
const ALL4 = [...ALL, 'channel-arg', 'grab-gets-channel'];

/** Starts a run on `app` and leaves it waiting for its download. */
async function startWaitingRun(app: string, backend: Backend, steps: number): Promise<Ids> {
  const ids = call<Ids>(app, backend, 'pipeline:startGrab', { title: `started on ${app}` });
  // The run is waiting once its steps before the wait have run and it's still in progress.
  await until(
    () => grab(app, backend, ids),
    (g) => g.log.length === steps && g.status === 'inProgress',
    `the run started on ${app} to wait`,
  );
  return ids;
}

// ------------------------------------------------------------- scenarios ---

const scenarios: Record<string, (backend: Backend) => Promise<void>> = {
  /**
   * A run from release 0 (plain @convex-dev/workflow) waiting across a deploy
   * of release 3, which lists the migrations of releases 1 to 3: it replays
   * without releases 1 and 2 ever being deployed.
   */
  async skip(backend) {
    deploy('v1', backend);
    const old = await startWaitingRun('v1', backend, 1);
    const old2 = await startWaitingRun('v1', backend, 1);

    // The export a developer would feed to expectReplays(): release 0's journals, no records yet, newest first.
    const plain = cli('v3', backend, ['histories', 'pipeline:run']);
    const exported = JSON.parse(plain.stdout) as Exported[];
    expectEqual(
      exported.map((h) => ({ workflowId: h.workflowId, steps: h.steps.map((s) => `${s.name}${s.runResult ? '' : ' (running)'}`), applied: h.applied })),
      [old2, old].map(({ workflowId }) => ({ workflowId, steps: ['pipeline:grab', 'downloadDone (running)'], applied: undefined })),
      'the exported histories',
    );
    expectEqual(plain.stderr.includes('The export holds production data'), true, 'the warning about production data');
    // Scrubbed: the run's args and every step's.
    const redacted = cli('v3', backend, ['histories', 'pipeline:run', '--redact', REDACT]);
    const scrubbed = JSON.parse(redacted.stdout) as Exported[];
    expectEqual([scrubbed[0]!.args.grabId, ...scrubbed[0]!.steps.map((s) => s.args.grabId)], ['redacted', 'redacted', undefined], 'the redacted grab ids');
    expectEqual(redacted.stderr.includes('Scrubbed with'), true, 'the note about the scrubbed export');
    // Two running runs from before adoption, and --max-runs 1, or --max-scan 1: it says how far it looked, and exports nothing unless --allow-partial.
    const partial = cliRun('v3', backend, ['histories', 'pipeline:run', '--max-runs', '1']);
    expectEqual(
      {
        status: partial.status,
        stdout: partial.stdout,
        stderr: /running runs from before the app adopted this package than --max-runs 1\. .* up to one created \d{4}-.*Nothing was exported/s.test(
          partial.stderr,
        ),
      },
      { status: 1, stdout: '', stderr: true },
      'the export stopped at --max-runs',
    );
    const scan = cliRun('v3', backend, ['histories', 'pipeline:run', '--max-scan', '1']);
    expectEqual(
      { status: scan.status, stderr: /than --max-scan 1, finished ones included\..*Raise --max-scan/s.test(scan.stderr) },
      { status: 1, stderr: true },
      'the export stopped at --max-scan',
    );
    const allowed = JSON.parse(cli('v3', backend, ['histories', 'pipeline:run', '--max-runs', '1', '--allow-partial']).stdout) as Exported[];
    expectEqual(
      allowed.map((h) => h.workflowId),
      [old.workflowId],
      'histories exported with --max-runs 1 --allow-partial: the oldest',
    );

    deploy('v3', backend);
    const fresh = await startWaitingRun('v3', backend, 2);
    for (const ids of [old, old2, fresh]) call('v3', backend, 'pipeline:downloadDone', { workflowId: ids.workflowId });

    const oldGrab = await until(
      () => grab('v3', backend, old),
      (g) => g.status !== 'inProgress',
      'the release 0 run to finish',
    );
    // notify is a stand-in for the old run: it was past that point.
    expectEqual(oldGrab, { log: ['grab', 'import', 'transcode', 'publish'], status: 'completed' }, 'the run started on release 0');
    expectEqual(record('v3', backend, old)?.applied, ALL, 'the release 0 run’s applied migrations');
    expectEqual(record('v3', backend, old)?.origin, 'adopted', 'who created the release 0 run’s record');
    await until(
      () => grab('v3', backend, old2),
      (g) => g.status !== 'inProgress',
      'the second release 0 run to finish',
    );
    const freshGrab = await until(
      () => grab('v3', backend, fresh),
      (g) => g.status !== 'inProgress',
      'the release 3 run to finish',
    );
    expectEqual(freshGrab, { log: ['grab', 'notify', 'import', 'transcode', 'publish'], status: 'completed' }, 'the run started on release 3');
    expectEqual(record('v3', backend, fresh)?.applied, ALL, 'the release 3 run’s applied migrations');
    for (const ids of [old, old2, fresh]) expectEqual(pauses('v3', backend, ids), { paused: null, alerts: [] }, 'pauses');

    // With a record, the export has the applied migrations.
    const after = JSON.parse(cli('v3', backend, ['histories', 'pipeline:run', '--recent', '1']).stdout) as Exported[];
    expectEqual(after.length, 1, 'histories exported with --recent 1');
    expectEqual(after[0]!.applied, ALL, 'the exported applied migrations');

    // Redacted with records: the overlay is scrubbed too. The release 0 run's stand-in got the notify time null, which the module turns into 0.
    const redactedAfter = cli('v3', backend, ['histories', 'pipeline:run', '--redact', REDACT]);
    const oldScrubbed = (JSON.parse(redactedAfter.stdout) as Exported[]).find((h) => h.workflowId === old.workflowId);
    expectEqual(
      oldScrubbed?.overlay?.map((op) => ({ op: op.op, result: op.result })),
      [{ op: 'insert', result: { at: 0 } }],
      'the redacted overlay of the release 0 run',
    );
    for (const ids of [old, fresh]) expectEqual(redactedAfter.stdout.includes(ids.grabId), false, `grab id ${ids.grabId} in the redacted export`);

    // Exactly as many runs from before adoption as --max-scan, and as many steps as --max-steps, aren't more: the scan
    // stops at the first run this package started, and the finished ones from before adoption don't count toward
    // --max-runs. Newest first: the release 3 run has 6 steps; the release 0 runs 5 (grab, the wait, import, transcode,
    // publish; notify is a stand-in).
    const exact = JSON.parse(
      cli('v3', backend, ['histories', 'pipeline:run', '--max-runs', '1', '--max-scan', '2', '--max-steps', '5']).stdout,
    ) as (Exported & {
      truncated?: boolean;
    })[];
    expectEqual(
      exact.map((h) => ({ workflowId: h.workflowId, steps: h.steps.length, truncated: h.truncated })),
      [
        { workflowId: fresh.workflowId, steps: 5, truncated: true },
        { workflowId: old2.workflowId, steps: 5, truncated: undefined },
        { workflowId: old.workflowId, steps: 5, truncated: undefined },
      ],
      'histories exported with --max-runs 1 --max-scan 2 --max-steps 5',
    );
    expectEqual(cliRun('v3', backend, ['histories', 'pipeline:run', '--max-steps', '0']).status, 2, 'the exit code for --max-steps 0');

    // A run from before adoption has no links to its children: cleanup reads its journal, through a handle to upstream's journal.load.
    expectEqual(call('v3', backend, 'pipeline:cleanup', { workflowId: old.workflowId }), true, 'cleanup of the release 0 run');
    expectEqual(record('v3', backend, old), null, 'the release 0 run’s record after cleanup');
  },

  /**
   * A run from release 0 waiting across a deploy of release 3, whose
   * download then fails: the handler passes the failure on, and the run
   * fails, as before, though the deploy's migrations edited its history in
   * that handler run.
   */
  async failed(backend) {
    deploy('v1', backend);
    const ids = await startWaitingRun('v1', backend, 1);
    deploy('v3', backend);
    call('v3', backend, 'pipeline:downloadDone', { workflowId: ids.workflowId, error: 'the download failed' });
    const done = await until(
      () => grab('v3', backend, ids),
      (g) => g.status !== 'inProgress' || pauses('v3', backend, ids).paused !== null,
      'the run to fail',
    );
    expectEqual({ ...done, error: done.error?.includes('the download failed') }, { log: ['grab'], status: 'failed', error: true }, 'the failed run');
    expectEqual(pauses('v3', backend, ids), { paused: null, alerts: [] }, 'pauses');
    expectEqual(record('v3', backend, ids)?.applied, ALL, 'the applied migrations');
  },

  /**
   * The same change as release 2 without its migrations pauses the waiting
   * runs instead of failing them; deploying release 2 with them resumes them
   * at the next retry, about a minute later. A paused run whose workflow is
   * deleted meanwhile, as upstream deletes a child with its parent, loses
   * its record at that retry.
   */
  async unguarded(backend) {
    deploy('v1', backend);
    const old = await startWaitingRun('v1', backend, 1);
    const gone = await startWaitingRun('v1', backend, 1);
    const failed = await startWaitingRun('v1', backend, 1);
    deploy('v2-unguarded', backend);
    for (const ids of [old, gone, failed]) call('v2-unguarded', backend, 'pipeline:downloadDone', { workflowId: ids.workflowId });
    // Not failed: it stays in progress, with the pause recorded and reported once.
    const paused = await until(
      () => ({ ...pauses('v2-unguarded', backend, old), run: grab('v2-unguarded', backend, old) }),
      (p) => p.paused !== null || p.run.status !== 'inProgress',
      'the run to pause',
    );
    expectEqual(paused, { paused: { reason: 'mismatch', attempts: 1 }, alerts: ['mismatch'], run: { log: ['grab'], status: 'inProgress' } }, 'the paused run');
    await until(
      () => pauses('v2-unguarded', backend, gone).paused,
      (p) => p !== null,
      'the second run to pause',
    );
    call('v2-unguarded', backend, 'workflow:cleanup', { workflowId: gone.workflowId, force: true }, 'workflow');
    // fail, from a mutation: the run fails with why it paused, in that transaction.
    await until(
      () => pauses('v2-unguarded', backend, failed).paused,
      (p) => p !== null,
      'the third run to pause',
    );
    call('v2-unguarded', backend, 'pipeline:fail', { workflowId: failed.workflowId });
    const failedGrab = grab('v2-unguarded', backend, failed);
    expectEqual(
      { ...failedGrab, error: failedGrab.error?.startsWith('Paused (mismatch): ') },
      { log: ['grab'], status: 'failed', error: true },
      'the failed run',
    );
    expectEqual(pauses('v2-unguarded', backend, failed).paused, null, 'the failed run’s pause');

    deploy('v2', backend);
    log('  waiting for the retries');
    const done = await until(
      () => grab('v2', backend, old),
      (g) => g.status !== 'inProgress',
      'the retry to resume the run',
      120_000,
    );
    expectEqual(done, { log: ['grab', 'import', 'prepare', 'publish'], status: 'completed' }, 'the resumed run');
    expectEqual(pauses('v2', backend, old), { paused: null, alerts: ['mismatch'] }, 'pauses after the retry');
    await until(
      () => record('v2', backend, gone),
      (r) => r === null,
      'the deleted run’s record to be deleted',
      120_000,
    );
  },

  /**
   * A run started on release 3 pauses when release 2 is deployed over it
   * (its migrations aren't a prefix of release 2's), and resumes when
   * release 3 is back.
   */
  async rollback(backend) {
    deploy('v3', backend);
    const ids = await startWaitingRun('v3', backend, 2);
    deploy('v2', backend);
    call('v2', backend, 'pipeline:downloadDone', { workflowId: ids.workflowId });
    const paused = await until(
      () => ({ ...pauses('v2', backend, ids), run: grab('v2', backend, ids) }),
      (p) => p.paused !== null || p.run.status !== 'inProgress',
      'the run to pause',
    );
    expectEqual(
      paused,
      { paused: { reason: 'migrations', attempts: 1 }, alerts: ['migrations'], run: { log: ['grab', 'notify'], status: 'inProgress' } },
      'the paused run',
    );

    deploy('v3', backend);
    expectEqual(call('v3', backend, 'pipeline:resume', { workflowId: ids.workflowId }), true, 'resume');
    const done = await until(
      () => grab('v3', backend, ids),
      (g) => g.status !== 'inProgress',
      'the run to finish',
    );
    expectEqual(done, { log: ['grab', 'notify', 'import', 'transcode', 'publish'], status: 'completed' }, 'the resumed run');
  },

  /**
   * restartFrom and restart on a real backend. A run started on release 3
   * pauses when release 2 is deployed over it (a rollback, so every position
   * would pause again): restartFrom throws and changes nothing. With release 3
   * back, restartFrom from the wait runs it again; after the run finishes,
   * restart from transcode, by name, runs transcode and publish again.
   */
  async restart(backend) {
    deploy('v3', backend);
    const ids = await startWaitingRun('v3', backend, 2);
    deploy('v2', backend);
    call('v2', backend, 'pipeline:downloadDone', { workflowId: ids.workflowId });
    await until(
      () => pauses('v2', backend, ids).paused,
      (p) => p !== null,
      'the run to pause',
    );
    const before = record('v2', backend, ids);
    const refused = callFails('v2', backend, 'pipeline:restartFrom', { workflowId: ids.workflowId, step: 2 });
    expectEqual(refused.includes('would pause it again (migrations)'), true, `restartFrom on code that would pause it again (${refused.trim().slice(-300)})`);
    expectEqual(record('v2', backend, ids), before, 'the record after the refused restartFrom');
    expectEqual(grab('v2', backend, ids), { log: ['grab', 'notify'], status: 'inProgress' }, 'the run after the refused restartFrom');

    deploy('v3', backend);
    // Step 2 is the wait, which the download already ended: the run waits again.
    call('v3', backend, 'pipeline:restartFrom', { workflowId: ids.workflowId, step: 2 });
    expectEqual(pauses('v3', backend, ids).paused, null, 'the pause after restartFrom');
    call('v3', backend, 'pipeline:downloadDone', { workflowId: ids.workflowId });
    const done = await until(
      () => grab('v3', backend, ids),
      (g) => g.status !== 'inProgress',
      'the run to finish',
    );
    expectEqual(done, { log: ['grab', 'notify', 'import', 'transcode', 'publish'], status: 'completed' }, 'the run after restartFrom');

    call('v3', backend, 'pipeline:restart', { workflowId: ids.workflowId, from: 'pipeline:transcode' });
    const again = await until(
      () => grab('v3', backend, ids),
      (g) => g.status !== 'inProgress',
      'the restarted run to finish',
    );
    expectEqual(again, { log: ['grab', 'notify', 'import', 'transcode', 'publish', 'transcode', 'publish'], status: 'completed' }, 'the restarted run');
    expectEqual(record('v3', backend, ids)?.applied, ALL, 'the applied migrations');
    // restart had upstream delete the entries it ran again: grab, notify, the wait restartFrom hid, the wait, import, transcode, publish.
    expectEqual(journalLength('v3', backend, ids.workflowId), 7, 'the journal after restart');
  },

  /**
   * Runs whose first handler run comes after a release that changed their
   * args: one started with startAsync on release 3, and a child workflow that
   * its parent's handler run created. Both wait in upstream's workpool, behind
   * a long action, across the deploy of release 4, then migrate from what
   * their records say: the queued run from the ids it started with, the child
   * from its args. Before the deploy, the export lists both from the
   * component. The parent's cleanup deletes the child's record too.
   */
  async queued(backend) {
    deploy('v3', backend);
    const { queued, child, parent } = call<{ queued: Ids; child: Ids; parent: string }>('v3', backend, 'queued:startQueued', {});
    expectEqual(
      record('v3', backend, queued),
      { workflow: 'pipeline:run', applied: ALL, overlay: [], live: true, origin: 'start', format: 1 },
      'the queued run’s record',
    );
    expectEqual(record('v3', backend, child), { workflow: 'pipeline:run', overlay: [], live: true, origin: 'child', parent, format: 1 }, 'the child’s record');
    const listed = JSON.parse(cli('v3', backend, ['histories', 'pipeline:run', '--recent', '0']).stdout) as Exported[];
    expectEqual(
      listed.map((h) => ({ workflowId: h.workflowId, steps: h.steps.length, applied: h.applied })),
      [
        { workflowId: queued.workflowId, steps: 0, applied: ALL },
        { workflowId: child.workflowId, steps: 0, applied: undefined },
      ],
      'the export of the queued runs',
    );

    deploy('v4', backend);
    for (const ids of [queued, child]) {
      if (grab('v4', backend, ids).log.length > 0)
        throw new Error('A queued run started before the deploy finished: raise HOLD_MS in the fixtures’ queued.ts.');
    }
    for (const ids of [queued, child]) {
      await until(
        () => ({ ...grab('v4', backend, ids), paused: pauses('v4', backend, ids).paused }),
        (g) => g.log.length === 2 || g.status !== 'inProgress' || g.paused !== null,
        'the queued run to wait for its download',
        90_000,
      );
      call('v4', backend, 'pipeline:downloadDone', { workflowId: ids.workflowId });
    }
    for (const ids of [queued, child]) {
      const done = await until(
        () => grab('v4', backend, ids),
        (g) => g.status !== 'inProgress',
        'the queued run to finish',
      );
      expectEqual(done, { log: ['grab default', 'notify', 'import', 'transcode', 'publish default'], status: 'completed' }, 'the queued run');
      expectEqual(record('v4', backend, ids)?.applied, ALL4, 'the queued run’s applied migrations');
    }
    await until(
      () => runResult('v4', backend, parent),
      (result) => result !== undefined,
      'the parent to finish',
    );
    expectEqual(runResult('v4', backend, parent), { kind: 'success', returnValue: null }, 'the parent');
    expectEqual(record('v4', backend, { workflowId: parent })?.applied, ['child-gets-channel'], 'the parent’s applied migrations');

    expectEqual(call('v4', backend, 'queued:cleanup', { workflowId: parent }), true, 'cleanup of the parent');
    expectEqual(record('v4', backend, { workflowId: parent }), null, 'the parent’s record after cleanup');
    await until(
      () => record('v4', backend, child),
      (r) => r === null,
      'the child’s record to be deleted',
    );
  },

  /**
   * A step a run started on release 3, queued in upstream's workpool behind a
   * long action across the deploy of release 4, which gives that step a new
   * argument. It runs on release 4's code with release 3's args, which pass
   * because the new argument is optional, as the README's rule for queued
   * steps says; then the run replays on release 4 through its migrations,
   * and goes on.
   */
  async 'queued-step'(backend) {
    deploy('v3', backend);
    const ids = call<Ids>('v3', backend, 'queued:startBehindHold', {});
    expectEqual(record('v3', backend, ids)?.applied, ALL, 'the run’s applied migrations');
    deploy('v4', backend);
    if (grab('v4', backend, ids).log.length > 0) throw new Error('grab ran before the deploy finished: raise STEP_HOLD_MS in the v3 fixture’s queued.ts.');
    const waiting = await until(
      () => ({ ...grab('v4', backend, ids), paused: pauses('v4', backend, ids).paused }),
      (g) => g.log.length === 2 || g.status !== 'inProgress' || g.paused !== null,
      'the run to wait for its download',
      60_000,
    );
    // grab ran on release 4 without a channel: the args release 3 called it with.
    expectEqual(waiting, { log: ['grab', 'notify'], status: 'inProgress', paused: null }, 'the run after its queued grab');
    call('v4', backend, 'pipeline:downloadDone', { workflowId: ids.workflowId });
    const done = await until(
      () => grab('v4', backend, ids),
      (g) => g.status !== 'inProgress',
      'the run to finish',
    );
    expectEqual(done, { log: ['grab', 'notify', 'import', 'transcode', 'publish default'], status: 'completed' }, 'the run');
    expectEqual(record('v4', backend, ids)?.applied, ALL4, 'the run’s applied migrations');
    expectEqual(pauses('v4', backend, ids), { paused: null, alerts: [] }, 'pauses');
  },

  /**
   * Release 4 makes the workflow take a channel. A run started on release 3
   * pauses on release 4's code without the migration that gives old runs
   * one, instead of failing its args check; after release 4 is deployed with
   * it, resumeAll resumes the run without waiting for its retry.
   */
  async args(backend) {
    deploy('v3', backend);
    const ids = await startWaitingRun('v3', backend, 2);
    deploy('v4-unguarded', backend);
    call('v4-unguarded', backend, 'pipeline:downloadDone', { workflowId: ids.workflowId });
    const paused = await until(
      () => ({ ...pauses('v4-unguarded', backend, ids), run: grab('v4-unguarded', backend, ids) }),
      (p) => p.paused !== null || p.run.status !== 'inProgress',
      'the run to pause',
    );
    expectEqual(
      paused,
      { paused: { reason: 'args', attempts: 1 }, alerts: ['args'], run: { log: ['grab', 'notify'], status: 'inProgress' } },
      'the paused run',
    );

    deploy('v4', backend);
    call('v4', backend, 'pipeline:resumeAll', {});
    // Its scheduled retry is a minute after the pause, later than this.
    const done = await until(
      () => grab('v4', backend, ids),
      (g) => g.status !== 'inProgress',
      'resumeAll to resume the run',
      20_000,
    );
    expectEqual(done, { log: ['grab', 'notify', 'import', 'transcode', 'publish default'], status: 'completed' }, 'the resumed run');
    expectEqual(record('v4', backend, ids)?.applied, ALL4, 'the applied migrations');

    // The overlay's migrated workflow args hold the grab id too: --redact scrubs it there.
    const redacted = cli('v4', backend, ['histories', 'pipeline:run', '--redact', REDACT]);
    const [scrubbed] = JSON.parse(redacted.stdout) as Exported[];
    expectEqual(scrubbed?.overlay?.find((op) => op.op === 'workflowArgs')?.args, { grabId: 'redacted', channel: 'default' }, 'the redacted workflow args');
    expectEqual(redacted.stdout.includes(ids.grabId), false, 'the grab id in the redacted export');
  },
};

// ------------------------------------------------------------------ main ---

const selected = process.argv.slice(2);
for (const name of selected) if (!(name in scenarios)) throw new Error(`Unknown scenario "${name}". Scenarios: ${Object.keys(scenarios).join(', ')}`);

log('building the package');
sh('bun', ['run', 'build'], { cwd: ROOT });

let failed = 0;
for (const [name, scenario] of Object.entries(scenarios)) {
  if (selected.length > 0 && !selected.includes(name)) continue;
  log(`${name}`);
  const backend = await startBackend(`${PREFIX}-${name}`);
  const started = Date.now();
  try {
    await scenario(backend);
    log(`  ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    failed++;
    log(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    backend.stop();
  }
}
if (failed > 0) {
  log(`${failed} scenario(s) failed`);
  process.exit(1);
}
