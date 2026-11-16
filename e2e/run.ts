// End-to-end tests on a real self-hosted backend: a fixture app starts a run
// that waits on `awaitEvent`, a later release (another fixture, or
// examples/basic) is deployed over it, and the run finishes on the new code,
// or fails.
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
const record = (app: string, backend: Backend, { workflowId }: Ids) =>
  call<{ applied: string[]; overlay: unknown[] } | null>(app, backend, 'runs:load', { workflowId }, 'workflowMigrations');
const finished = (app: string, backend: Backend, ids: Ids, what: string) =>
  until(
    () => grab(app, backend, ids),
    (g) => g.status !== 'inProgress',
    what,
  );

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
   * has every migration applied from the start.
   */
  async skip(backend) {
    deploy('v1', backend);
    const old = await startWaitingRun('v1', backend, 1);
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
  },

  /**
   * Release 2's change without its migrations: the run release 0 left
   * waiting fails at its next handler run, with the mismatch, as it would
   * without this package.
   */
  async 'failed-mismatch'(backend) {
    deploy('v1', backend);
    const old = await startWaitingRun('v1', backend, 1);
    deploy('v2-unguarded', backend);
    call('v2-unguarded', backend, 'pipeline:downloadDone', { workflowId: old.workflowId });
    const failed = await finished('v2-unguarded', backend, old, 'the run to fail');
    expectEqual({ log: failed.log, status: failed.status }, { log: ['grab'], status: 'failed' }, 'the release 0 run');
    const mismatch =
      'Journal entry mismatch at step 1 of the run\'s history, as its migrations leave it: the code calls {"args":{"grabId":"' +
      `${old.grabId}"},"kind":"function","name":"pipeline:notify"}, the history has {"args":{},"kind":"event","name":"downloadDone"}`;
    if (!failed.error?.includes(mismatch)) throw new Error(`Expected the mismatch "${mismatch}", got: ${failed.error}`);
    expectEqual(record('v2-unguarded', backend, old), null, 'the failed run’s record');
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
