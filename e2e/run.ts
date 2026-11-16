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
const PREFIX = 'convex-workflow-patches-e2e';

function sh(cmd: string, args: string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...options });
  if (result.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${`${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`.trim().slice(-3000)}`);
  return String(result.stdout ?? '');
}
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
const record = (app: string, backend: Backend, { workflowId }: Ids) =>
  call<{ applied: string[]; paused?: unknown } | null>(app, backend, 'runs:load', { workflowId }, 'workflowPatches');

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Runs the package's `bin` from an app's dependency on it, as a developer
 * would. Resolved through package.json rather than node_modules/.bin, which a
 * fresh install doesn't link before the first build.
 */
function cli(app: string, backend: Backend, args: string[]): string {
  const pkg = join(appDir(app), 'node_modules/@dev-marzahn/convex-workflow-patches');
  const bin = (JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { bin: Record<string, string> }).bin['convex-workflow-patches']!;
  return sh(process.execPath, [join(pkg, bin), ...args], { cwd: appDir(app), env: backend.env });
}

const ALL = ['notify-after-grab', 'import-gets-notified-at', 'prepare-becomes-transcode'];

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

    // The export a developer would feed to expectReplays(): release 0's journal, no record yet.
    const exported = JSON.parse(cli('v3', backend, ['histories', 'pipeline:run'])) as {
      workflowId: string;
      steps: { name: string; runResult?: unknown }[];
      applied?: unknown;
    }[];
    expectEqual(
      exported.map((h) => ({ workflowId: h.workflowId, steps: h.steps.map((s) => `${s.name}${s.runResult ? '' : ' (running)'}`), applied: h.applied })),
      [{ workflowId: old.workflowId, steps: ['pipeline:grab', 'downloadDone (running)'], applied: undefined }],
      'the exported histories',
    );

    deploy('v3', backend);
    const fresh = await startWaitingRun('v3', backend, 2);
    for (const ids of [old, fresh]) call('v3', backend, 'pipeline:downloadDone', { workflowId: ids.workflowId });

    const oldGrab = await until(
      () => grab('v3', backend, old),
      (g) => g.status !== 'inProgress',
      'the release 0 run to finish',
    );
    // notify is a stand-in for the old run: it was past that point.
    expectEqual(oldGrab, { log: ['grab', 'import', 'transcode', 'publish'], status: 'completed' }, 'the run started on release 0');
    expectEqual(record('v3', backend, old)?.applied, ALL, 'the release 0 run’s applied migrations');
    const freshGrab = await until(
      () => grab('v3', backend, fresh),
      (g) => g.status !== 'inProgress',
      'the release 3 run to finish',
    );
    expectEqual(freshGrab, { log: ['grab', 'notify', 'import', 'transcode', 'publish'], status: 'completed' }, 'the run started on release 3');
    expectEqual(record('v3', backend, fresh)?.applied, ALL, 'the release 3 run’s applied migrations');
    for (const ids of [old, fresh]) expectEqual(pauses('v3', backend, ids), { paused: null, alerts: [] }, 'pauses');

    // With a record, the export has the applied migrations.
    const after = JSON.parse(cli('v3', backend, ['histories', 'pipeline:run', '--recent', '1'])) as { workflowId: string; applied?: string[] }[];
    expectEqual(after.length, 1, 'histories exported with --recent 1');
    expectEqual(after[0]!.applied, ALL, 'the exported applied migrations');
  },

  /**
   * The same change as release 2 without its migrations pauses the waiting
   * run instead of failing it; deploying release 2 with them resumes it at
   * the next retry, a minute later.
   */
  async unguarded(backend) {
    deploy('v1', backend);
    const old = await startWaitingRun('v1', backend, 1);
    deploy('v2-unguarded', backend);
    call('v2-unguarded', backend, 'pipeline:downloadDone', { workflowId: old.workflowId });
    // Not failed: it stays in progress, with the pause recorded and reported once.
    const paused = await until(
      () => ({ ...pauses('v2-unguarded', backend, old), run: grab('v2-unguarded', backend, old) }),
      (p) => p.paused !== null || p.run.status !== 'inProgress',
      'the run to pause',
    );
    expectEqual(paused, { paused: { reason: 'mismatch', attempts: 1 }, alerts: ['mismatch'], run: { log: ['grab'], status: 'inProgress' } }, 'the paused run');

    deploy('v2', backend);
    log('  waiting for the retry');
    const done = await until(
      () => grab('v2', backend, old),
      (g) => g.status !== 'inProgress',
      'the retry to resume the run',
      120_000,
    );
    expectEqual(done, { log: ['grab', 'import', 'prepare', 'publish'], status: 'completed' }, 'the resumed run');
    expectEqual(pauses('v2', backend, old), { paused: null, alerts: ['mismatch'] }, 'pauses after the retry');
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
