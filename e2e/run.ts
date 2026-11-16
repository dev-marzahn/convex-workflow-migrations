// End-to-end tests on a real self-hosted backend: a fixture app starts a run
// that waits on `awaitEvent`, a later release (another fixture, or
// examples/basic) is deployed over it, and the run finishes on the new code,
// or pauses.
//
//   bun run e2e                 all scenarios
//   bun run e2e skip            only these
//
// Needs Docker. Builds the package first.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { type Backend, startBackend } from './backend.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'convex-workflow-migrations-e2e';

function sh(cmd: string, args: string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...options });
  const [stdout, stderr] = [String(result.stdout ?? ''), String(result.stderr ?? '')];
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${`${stdout}\n${stderr}`.trim().slice(-3000)}`);
  return stdout;
}
const log = (message: string) => console.log(message);

// ------------------------------------------------------------------ apps ---

// Release 3 is the example app; the other releases are fixtures in e2e/apps.
const release3 = 'examples/basic';
const appDir = (app: string) => join(ROOT, app === release3 ? app : `e2e/apps/${app}`);
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
/** Whether the run is paused, and the reasons `onPause` recorded for it. */
const pauses = (app: string, backend: Backend, { workflowId }: Ids) => call<Pauses>(app, backend, 'pipeline:pauses', { workflowId });
/** Waits for the run to pause, or to finish, and returns its pause and its grab. */
const pausedRun = (app: string, backend: Backend, ids: Ids) =>
  until(
    () => ({ ...pauses(app, backend, ids), run: grab(app, backend, ids) }),
    (p) => p.paused !== null || p.run.status !== 'inProgress',
    'the run to pause',
  );
const record = (app: string, backend: Backend, { workflowId }: Ids) =>
  call<{ applied: string[]; overlay: unknown[] } | null>(app, backend, 'runs:load', { workflowId }, 'workflowMigrations');
const finished = (app: string, backend: Backend, ids: Ids, what: string, timeoutMs?: number) =>
  until(
    () => grab(app, backend, ids),
    (g) => g.status !== 'inProgress',
    what,
    timeoutMs,
  );

type Exported = { workflowId: string; workflow: string; args: unknown; steps: { name: string; runResult?: unknown }[]; applied?: string[]; outcome?: string };

/** Runs the `histories` CLI from `app`'s directory, as a user would: the installed bin, or the build for a fixture without the package. */
function histories(app: string, backend: Backend, args: string[], status = 0): { exported: Exported[]; stderr: string } {
  const cli =
    app === release3 ? join(appDir(app), 'node_modules/.bin/convex-workflow-migrations') : join(ROOT, 'packages/convex-workflow-migrations/dist/cli.js');
  const result = spawnSync(cli, ['histories', 'pipeline:run', ...args], { cwd: appDir(app), env: backend.env, encoding: 'utf8' });
  if (result.status !== status) throw new Error(`histories exited with ${result.status}, not ${status}:\n${result.stderr}`);
  return { exported: result.stdout ? (JSON.parse(result.stdout) as Exported[]) : [], stderr: result.stderr };
}
const shape = ({ workflowId, workflow, args, steps, applied, outcome }: Exported) => ({
  workflowId,
  workflow,
  args,
  steps: steps.map((s) => `${s.name}${s.runResult ? '' : ' (running)'}`),
  ...(applied ? { applied } : {}),
  ...(outcome ? { outcome } : {}),
});

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const ALL = ['notify-after-grab', 'import-gets-notified-at', 'prepare-becomes-transcode'];

/** Starts a run on `app` and leaves it waiting for its download, after `steps` steps. */
async function startWaitingRun(app: string, backend: Backend, steps: number): Promise<Ids> {
  const ids = call<Ids>(app, backend, 'pipeline:startGrab', { title: `started on ${app}` });
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
   * without releases 1 and 2 ever being deployed. A run started on release 3
   * has every migration applied from the start. The `histories` CLI exports
   * the release 0 run before the deploy, without the migrations component,
   * and once it finished on release 3, with its record.
   */
  async skip(backend) {
    deploy('v1', backend);
    const old = await startWaitingRun('v1', backend, 1);
    const before = histories('v1', backend, []);
    const args = { grabId: old.grabId };
    expectEqual(
      before.exported.map(shape),
      [{ workflowId: old.workflowId, workflow: 'pipeline:run', args, steps: ['pipeline:grab', 'downloadDone (running)'] }],
      'the export before the deploy',
    );
    if (!before.stderr.includes("The workflowMigrations component isn't deployed")) throw new Error(`No note about the component:\n${before.stderr}`);
    deploy(release3, backend);
    expectEqual(record(release3, backend, old), null, 'the release 0 run’s record before its next handler run');
    const fresh = await startWaitingRun(release3, backend, 2);
    expectEqual(record(release3, backend, fresh), { applied: ALL, overlay: [] }, 'the release 3 run’s record');
    for (const ids of [old, fresh]) call(release3, backend, 'pipeline:downloadDone', { workflowId: ids.workflowId });

    // notify is a stand-in for the old run: it was past that point.
    expectEqual(
      await finished(release3, backend, old, 'the release 0 run to finish'),
      { log: ['grab', 'import', 'transcode', 'publish'], status: 'completed' },
      'the release 0 run',
    );
    expectEqual(record(release3, backend, old)?.applied, ALL, 'the release 0 run’s applied migrations');
    const freshGrab = await finished(release3, backend, fresh, 'the release 3 run to finish');
    expectEqual(freshGrab, { log: ['grab', 'notify', 'import', 'transcode', 'publish'], status: 'completed' }, 'the release 3 run');
    expectEqual(record(release3, backend, fresh)?.overlay, [], 'the release 3 run’s overlay');

    const recent = histories(release3, backend, ['--recent', '1']).exported;
    expectEqual(
      recent.map((h) => h.workflowId),
      [fresh.workflowId],
      'the export with --recent 1: the newest finished run',
    );
    const exported = histories(release3, backend, []).exported.find((h) => h.workflowId === old.workflowId);
    const steps = ['pipeline:grab', 'downloadDone', 'pipeline:importFiles', 'pipeline:transcode', 'pipeline:publish'];
    expectEqual(
      exported && shape(exported),
      { workflowId: old.workflowId, workflow: 'pipeline:run', args, steps, applied: ALL, outcome: 'success' },
      'the export after',
    );
    expectEqual((exported as { overlay?: unknown }).overlay, record(release3, backend, old)?.overlay, 'the exported overlay, which has notify’s stand-in');
    // Two runs, and --max-scan 1: it stops, says where, and exports nothing.
    const stopped = histories(release3, backend, ['--max-scan', '1'], 1);
    if (!/read the newest 1, the oldest created \d{4}-/.test(stopped.stderr)) throw new Error(`The --max-scan stop doesn't say where:\n${stopped.stderr}`);
  },

  /**
   * Release 2's change without its migrations: the run release 0 left
   * waiting pauses at its next handler run instead of failing, and onPause
   * records it once. Deploying the fix, release 3, resumes it at the
   * scheduled retry, 48 to 72 s after the pause. That assumes the deploy is
   * live by then: if the first retry came before it, the run paused again
   * and its next retry is about 10 minutes out, so the scenario resumes it.
   */
  async unguarded(backend) {
    deploy('v1', backend);
    const old = await startWaitingRun('v1', backend, 1);
    deploy('v2-unguarded', backend);
    call('v2-unguarded', backend, 'pipeline:downloadDone', { workflowId: old.workflowId });
    expectEqual(
      await pausedRun('v2-unguarded', backend, old),
      { paused: { reason: 'mismatch', attempts: 1 }, alerts: ['mismatch'], run: { log: ['grab'], status: 'inProgress' } },
      'the paused run',
    );
    expectEqual(record('v2-unguarded', backend, old), null, 'the paused run’s record: nothing of the handler run was saved');

    deploy(release3, backend);
    const afterDeploy = pauses(release3, backend, old).paused;
    if (afterDeploy && afterDeploy.attempts > 1) {
      log('  the first retry came before the deploy: resuming');
      expectEqual(call(release3, backend, 'pipeline:resume', { workflowId: old.workflowId }), true, 'resume');
    } else log('  waiting for the retry');
    const done = await finished(release3, backend, old, 'the retry to resume the run', 120_000);
    expectEqual(done, { log: ['grab', 'import', 'transcode', 'publish'], status: 'completed' }, 'the resumed run');
    expectEqual(pauses(release3, backend, old), { paused: null, alerts: ['mismatch'] }, 'the pauses after the retry');
    expectEqual(record(release3, backend, old)?.applied, ALL, 'the resumed run’s applied migrations');
  },

  /**
   * A run started on release 3 pauses when release 2's code without its
   * migrations is deployed over it, a rollback: its applied migrations aren't
   * a prefix of that code's list. Rolling forward and calling resume
   * finishes it. A second run, paused the same way, is deleted by upstream's
   * forced cleanup: resume finds it gone, through the workflow mutation, and
   * deletes its pause and record.
   */
  async rollback(backend) {
    deploy(release3, backend);
    const [ids, gone] = [await startWaitingRun(release3, backend, 2), await startWaitingRun(release3, backend, 2)];
    deploy('v2-unguarded', backend);
    for (const { workflowId } of [ids, gone]) call('v2-unguarded', backend, 'pipeline:downloadDone', { workflowId });
    for (const run of [ids, gone]) {
      expectEqual(
        await pausedRun('v2-unguarded', backend, run),
        { paused: { reason: 'migrations', attempts: 1 }, alerts: ['migrations'], run: { log: ['grab', 'notify'], status: 'inProgress' } },
        'the paused run',
      );
    }

    deploy(release3, backend);
    expectEqual(call(release3, backend, 'pipeline:resume', { workflowId: ids.workflowId }), true, 'resume');
    const done = await finished(release3, backend, ids, 'the run to finish');
    expectEqual(done, { log: ['grab', 'notify', 'import', 'transcode', 'publish'], status: 'completed' }, 'the resumed run');
    expectEqual(pauses(release3, backend, ids).paused, null, 'the pause after resume');

    expectEqual(record(release3, backend, gone)?.applied, ALL, 'the paused run’s record');
    expectEqual(call(release3, backend, 'workflow:cleanup', { workflowId: gone.workflowId, force: true }, 'workflow'), true, 'the forced cleanup');
    expectEqual(call(release3, backend, 'pipeline:resume', { workflowId: gone.workflowId }), false, 'resume of the gone run');
    expectEqual(pauses(release3, backend, gone).paused, null, 'the gone run’s pause');
    expectEqual(record(release3, backend, gone), null, 'the gone run’s record');
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
