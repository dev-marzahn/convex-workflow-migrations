// End-to-end tests on a real self-hosted backend: fixture app v1 starts a run
// that waits on `awaitEvent`, a second fixture app is deployed over it as the
// next release, and the run finishes on the new code.
//
//   bun run e2e                 all scenarios
//   bun run e2e patched         only these
//
// Needs Docker. Builds the package first.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { type Backend, startBackend } from './backend.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'convex-workflow-patches-e2e';

function sh(cmd: string, args: string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
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

function call<T>(app: string, backend: Backend, fn: string, args: Record<string, unknown>): T {
  // `convex run` prints nothing for a null result.
  const out = convex(app, backend, ['run', fn, JSON.stringify(args)]).trim();
  return (out ? JSON.parse(out) : undefined) as T;
}

type Ids = { grabId: string; workflowId: string };
type Grab = { log: string[]; status: string; error?: string };

async function until(app: string, backend: Backend, grabId: string, done: (grab: Grab) => boolean, timeoutMs = 60_000): Promise<Grab> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const grab = call<Grab>(app, backend, 'pipeline:grab', { grabId });
    if (done(grab)) return grab;
    if (Date.now() > deadline) throw new Error(`Timed out waiting on grab ${grabId}: ${JSON.stringify(grab)}`);
    await sleep(500);
  }
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Release 1 starts a run and leaves it waiting for its download. */
async function startWaitingRun(backend: Backend): Promise<Ids> {
  deploy('v1', backend);
  const ids = call<Ids>('v1', backend, 'pipeline:startGrab', { title: 'started on release 1' });
  // The run is waiting once its first step has run and the workflow is still in progress.
  await until('v1', backend, ids.grabId, (g) => g.log.length === 1 && g.status === 'inProgress');
  return ids;
}

// ------------------------------------------------------------- scenarios ---

const scenarios: Record<string, (backend: Backend) => Promise<void>> = {
  /** A run waiting across a patched release skips the patch before its wait and takes the one after. */
  async patched(backend) {
    const old = await startWaitingRun(backend);
    deploy('v2', backend);
    const fresh = call<Ids>('v2', backend, 'pipeline:startGrab', { title: 'started on release 2' });
    await until('v2', backend, fresh.grabId, (g) => g.log.length === 2);
    for (const { workflowId } of [old, fresh]) call('v2', backend, 'pipeline:downloadDone', { workflowId });

    const oldGrab = await until('v2', backend, old.grabId, (g) => g.status !== 'inProgress');
    expectEqual(oldGrab, { log: ['grab', 'import', 'prepare', 'publish'], status: 'completed' }, 'the run started on release 1');
    const freshGrab = await until('v2', backend, fresh.grabId, (g) => g.status !== 'inProgress');
    expectEqual(freshGrab, { log: ['grab', 'notify', 'import', 'prepare', 'publish'], status: 'completed' }, 'the run started on release 2');
  },

  /** The same change without patched() fails the waiting run: what the package exists to prevent. */
  async unguarded(backend) {
    const old = await startWaitingRun(backend);
    deploy('v2-unguarded', backend);
    call('v2-unguarded', backend, 'pipeline:downloadDone', { workflowId: old.workflowId });
    const grab = await until('v2-unguarded', backend, old.grabId, (g) => g.status !== 'inProgress');
    expectEqual(grab.status, 'failed', 'the run started on release 1');
    if (!grab.error?.includes('Journal entry mismatch')) throw new Error(`Expected a journal mismatch, got: ${grab.error}`);
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
