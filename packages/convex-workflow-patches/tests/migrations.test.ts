// Runs on convex-test across simulated releases: `deploy(release)` swaps the
// function registered as flows:pipeline, as a deploy would.
import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { v } from 'convex/values';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import {
  type Migration,
  migration,
  type PatchesComponent,
  type PauseInfo,
  type WorkflowComponent,
  type WorkflowCtx,
  type WorkflowId,
  WorkflowManager,
} from '../src/index.ts';
import patchesTest from '../src/test.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowPatches: PatchesComponent };
const pauses: PauseInfo[] = [];
let onPauseThrows = false;
const manager = new WorkflowManager(components.workflow, {
  patches: components.workflowPatches,
  onPause: (_ctx, info) => {
    pauses.push(info);
    if (onPauseThrows) throw new Error('alerting is down');
  },
});

type Ref = FunctionReference<'mutation', 'internal', { args: Record<string, never> }, WorkflowId>;
const flows = anyApi.flows!;
const pipeline = flows.pipeline as Ref;

// Every step records that it ran, with its args.
const ran: string[] = [];
const completions: { workflowId: string; result: { kind: string; error?: string } }[] = [];
const stepFn = (name: string, returns: unknown = null) =>
  internalMutationGeneric({
    handler: async (_ctx, args: Record<string, unknown>) => {
      ran.push(Object.keys(args).length > 0 ? `${name} ${JSON.stringify(args)}` : name);
      return returns;
    },
  });

// Release 0: grab, wait, import, prepare, publish. Each later release changes it, with a migration.
const m1 = migration('notify-after-grab', (h) => h.insertAfter(flows.grab, flows.notify, { result: { at: null } }));
const m2 = migration('import-gets-notified-at', (h) =>
  h.updateArgs(flows.importFiles, (args) => ({ ...args, notifiedAt: (h.result(flows.notify) as { at: number | null } | undefined)?.at ?? null })),
);
const m3 = migration('prepare-becomes-transcode', (h) => h.rename(flows.prepare, flows.transcode));
const audit = migration('audit-after-grab', (h) => h.insertAfter(flows.grab, flows.audit, { runLate: true, args: {} }));
const auditInline = migration('audit-after-grab', (h) => h.insertAfter(flows.grab, flows.audit, { runLate: true, args: {} }));

type Shape = { notify?: boolean; notifiedAt?: boolean; transcode?: boolean; audit?: 'late' | 'inline' };
function release(shape: Shape, migrations: Migration[]) {
  return manager.define({
    args: {},
    migrations,
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.grab, {});
      if (shape.audit) await step.runMutation(flows.audit, {}, shape.audit === 'inline' ? { inline: true } : {});
      const notified = shape.notify ? ((await step.runMutation(flows.notify, {})) as { at: number | null }) : undefined;
      await step.awaitEvent({ name: 'downloadDone' });
      await step.runMutation(flows.importFiles, shape.notifiedAt ? { notifiedAt: notified!.at } : {});
      await step.runMutation(shape.transcode ? flows.transcode : flows.prepare, {});
      await step.runMutation(flows.publish, {});
    },
  });
}

const releases = {
  r0: release({}, []),
  r1: release({ notify: true }, [m1]),
  r2: release({ notify: true, notifiedAt: true }, [m1, m2]),
  r3: release({ notify: true, notifiedAt: true, transcode: true }, [m1, m2, m3]),
  // Release 1's change without its migration.
  unguarded: release({ notify: true }, []),
  // Release 0 plus a step after grab that runs late on older runs.
  late: release({ audit: 'late' }, [audit]),
  lateInline: release({ audit: 'inline' }, [auditInline]),
  // A migration that throws.
  broken: release({ notify: true }, [
    migration('broken', () => {
      throw new Error('oops');
    }),
  ]),
};

const functions: Record<string, unknown> = {
  grab: stepFn('grab'),
  notify: stepFn('notify', { at: 1234 }),
  importFiles: stepFn('import'),
  prepare: stepFn('prepare'),
  transcode: stepFn('transcode'),
  publish: stepFn('publish'),
  audit: stepFn('audit'),
  onComplete: internalMutationGeneric({
    args: { workflowId: v.string(), result: v.any(), context: v.any() },
    handler: async (_ctx, { workflowId, result }) => void completions.push({ workflowId, result }),
  }),
  pipeline: releases.r0,
};
const deploy = (name: keyof typeof releases) => void (functions.pipeline = releases[name]);

function setup() {
  const t = convexTest(defineSchema({}), {
    './_generated/api.ts': async () => ({}),
    './flows.ts': async () => functions,
  });
  patchesTest.register(t);
  return t;
}
type T = ReturnType<typeof setup>;

/** Runs scheduled functions for `ms` of fake time. Paused runs retry after a minute, so the default stays below that. */
async function settle(t: T, ms = 30_000) {
  for (let elapsed = 0; elapsed < ms; elapsed += 250) {
    await t.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(250);
  }
  await t.finishInProgressScheduledFunctions();
}
async function start(t: T) {
  const id = await t.run((ctx) => manager.start(ctx, pipeline, {}, { onComplete: flows.onComplete, context: null }));
  await settle(t);
  return id;
}
async function downloadDone(t: T, workflowId: WorkflowId) {
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name: 'downloadDone' }));
  await settle(t);
}
const completed = { type: 'completed', result: null };
const status = (t: T, workflowId: WorkflowId) => t.run((ctx) => manager.status(ctx, workflowId));
const record = (t: T, workflowId: WorkflowId) => t.run((ctx) => ctx.runQuery(components.workflowPatches.runs.load, { workflowId }));
const paused = async (t: T, workflowId: WorkflowId) => (await t.run((ctx) => manager.paused(ctx))).find((run) => run.workflowId === workflowId);
const steps = (t: T, workflowId: WorkflowId) => t.run(async (ctx) => (await manager.listSteps(ctx, workflowId)).page.map((s) => s.name.replace('flows:', '')));

beforeEach(() => {
  vi.useFakeTimers();
  deploy('r0');
  ran.length = 0;
  pauses.length = 0;
  completions.length = 0;
  onPauseThrows = false;
});
afterEach(() => vi.useRealTimers());

test('a run from release 0 replays on release 3, which lists the migrations of releases 1 to 3', async () => {
  const t = setup();
  const id = await start(t);
  expect(ran).toEqual(['grab']);
  deploy('r3'); // releases 1 and 2 were never deployed
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual(completed);
  // notify is a stand-in, so it didn't run, and import got its null.
  expect(ran).toEqual(['grab', 'import {"notifiedAt":null}', 'transcode', 'publish']);
  const saved = await record(t, id);
  expect(saved?.applied).toEqual(['notify-after-grab', 'import-gets-notified-at', 'prepare-becomes-transcode']);
  expect(saved?.overlay.map((op) => op.op)).toEqual(['insert']);
  expect(saved?.paused).toBeUndefined();
  expect(pauses).toEqual([]);
});

test('a run waiting on release 2 replays on release 3: each migration applies once', async () => {
  const t = setup();
  deploy('r2');
  const id = await start(t);
  expect((await record(t, id))?.applied).toEqual(['notify-after-grab', 'import-gets-notified-at']);
  deploy('r3');
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'notify', 'import {"notifiedAt":1234}', 'transcode', 'publish']);
  expect((await record(t, id))?.applied).toEqual(['notify-after-grab', 'import-gets-notified-at', 'prepare-becomes-transcode']);
});

test('a new run starts with every migration applied and never migrates', async () => {
  const t = setup();
  deploy('r3');
  const id = await start(t);
  expect(await record(t, id)).toEqual({
    workflow: 'flows:pipeline',
    applied: ['notify-after-grab', 'import-gets-notified-at', 'prepare-becomes-transcode'],
    overlay: [],
  });
  await downloadDone(t, id);
  expect(ran).toEqual(['grab', 'notify', 'import {"notifiedAt":1234}', 'transcode', 'publish']);
  expect((await record(t, id))?.overlay).toEqual([]);
});

test('a stand-in resolves the call without running it; a runLate step runs when replay reaches it', async () => {
  const t = setup();
  const standIn = await start(t);
  const late = await start(t);
  deploy('r1');
  await downloadDone(t, standIn);
  expect(ran).toEqual(['grab', 'grab', 'import', 'prepare', 'publish']);

  ran.length = 0;
  deploy('late');
  await downloadDone(t, late);
  expect(await status(t, late)).toEqual(completed);
  expect(ran).toEqual(['audit', 'import', 'prepare', 'publish']);
  // Its journal entry was appended after the wait, and takes the inserted position.
  expect(await steps(t, late)).toEqual(['grab', 'downloadDone', 'audit', 'importFiles', 'prepare', 'publish']);
  const op = (await record(t, late))?.overlay[0];
  expect(op).toMatchObject({ op: 'insertLate', name: 'flows:audit' });
  const ids = await t.run(async (ctx) => (await manager.listSteps(ctx, late)).page.map((s) => s.stepId));
  expect(op?.op === 'insertLate' && op.executedAs).toBe(ids[2]);
});

test('an inline runLate step runs in the handler run that reaches it, and replay goes on', async () => {
  const t = setup();
  const id = await start(t);
  deploy('lateInline');
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'audit', 'import', 'prepare', 'publish']);
});

test('a replay that does not match pauses the run instead of failing it, and alerts once', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual({ type: 'inProgress', running: [] });
  expect(completions).toEqual([]);
  const run = await paused(t, id);
  expect(run).toMatchObject({ workflow: 'flows:pipeline', reason: 'mismatch', step: 1, attempts: 1 });
  expect(run?.detail).toContain('Journal entry mismatch at step 1: the code calls {"args":{},"kind":"function","name":"flows:notify"}');
  expect(run?.detail).toContain('the history has {"args":{},"kind":"event","name":"downloadDone"}');
  expect(run!.nextAttemptAt - run!.at).toBe(60_000);
  expect(pauses).toEqual([{ workflowId: id, workflow: 'flows:pipeline', reason: 'mismatch', detail: run!.detail }]);

  // Retried with backoff; still the same code, so still paused, and no second alert.
  await settle(t, 61_000);
  const again = await paused(t, id);
  expect(again).toMatchObject({ attempts: 2, at: run!.at });
  // The retry ran when it was due (settle advances time in 250ms steps), and the next waits 10 minutes.
  expect(again!.nextAttemptAt - run!.nextAttemptAt - 600_000).toBeGreaterThanOrEqual(0);
  expect(again!.nextAttemptAt - run!.nextAttemptAt - 600_000).toBeLessThan(250);
  expect(pauses).toHaveLength(1);

  // A release with the migration: the next retry resumes the run.
  deploy('r1');
  await settle(t, 601_000);
  expect(await paused(t, id)).toBeUndefined();
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'import', 'prepare', 'publish']);
  expect(completions).toEqual([{ workflowId: id, result: { kind: 'success', returnValue: null } }]);
});

test('a retry whose workflow mutation throws counts as another failed attempt', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  functions.pipeline = internalMutationGeneric({
    handler: async () => {
      throw new Error('boom');
    },
  });
  await settle(t, 61_000);
  const run = await paused(t, id);
  expect(run).toMatchObject({ reason: 'error', attempts: 2 });
  expect(run?.detail).toContain('The workflow mutation threw: ');
  expect(run?.detail).toContain('boom');
  deploy('r1');
  await settle(t, 601_000);
  expect(await status(t, id)).toEqual(completed);
  expect(pauses).toHaveLength(1);
});

test('an onPause that throws is logged, and the run stays paused', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  onPauseThrows = true;
  await downloadDone(t, id);
  expect(pauses).toHaveLength(1);
  expect(await paused(t, id)).toMatchObject({ reason: 'mismatch' });
  expect(await status(t, id)).toMatchObject({ type: 'inProgress' });
});

test('resume retries now, and says whether the run got past its pause', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  expect(await t.run((ctx) => manager.resume(ctx, id))).toBe(false);
  expect(await paused(t, id)).toMatchObject({ attempts: 2 });
  deploy('r1');
  expect(await t.run((ctx) => manager.resume(ctx, id))).toBe(true);
  await settle(t);
  expect(await status(t, id)).toEqual(completed);
  // The retry the pause scheduled finds nothing to do.
  await settle(t, 700_000);
  expect(ran).toEqual(['grab', 'import', 'prepare', 'publish']);
});

test('a migration that throws pauses the run', async () => {
  const t = setup();
  const id = await start(t);
  deploy('broken');
  await downloadDone(t, id);
  expect(await paused(t, id)).toMatchObject({ reason: 'migration', detail: 'Migration "broken" threw: oops' });
  expect(completions).toEqual([]);
  expect((await record(t, id))?.applied).toEqual([]);
});

test('a rollback below the migrations a run has pauses it, and the roll-forward resumes it', async () => {
  const t = setup();
  deploy('r3');
  const id = await start(t);
  deploy('r2'); // roll back
  await downloadDone(t, id);
  const run = await paused(t, id);
  expect(run).toMatchObject({ reason: 'migrations' });
  expect(run?.detail).toContain('The run has migrations "notify-after-grab", "import-gets-notified-at", "prepare-becomes-transcode" applied');
  expect(ran).toEqual(['grab', 'notify']);
  deploy('r3'); // roll forward
  expect(await t.run((ctx) => manager.resume(ctx, id))).toBe(true);
  await settle(t);
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'notify', 'import {"notifiedAt":1234}', 'transcode', 'publish']);
});

test('a migration list with an id removed or reordered pauses the run', async () => {
  const t = setup();
  deploy('r2');
  const id = await start(t);
  functions.pipeline = release({ notify: true, notifiedAt: true }, [m2, m1]);
  await downloadDone(t, id);
  expect(await paused(t, id)).toMatchObject({ reason: 'migrations' });
});

test('restartFrom drops the history from a step on, and those steps run again', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id); // paused at step 1: the code calls notify, the history has the wait
  // Restarting from step 2 leaves the mismatch at 1 in place.
  await expect(t.run((ctx) => manager.restartFrom(ctx, id, 2))).rejects.toThrow('would pause it again (mismatch)');
  expect(await paused(t, id)).toMatchObject({ attempts: 1 });
  expect((await record(t, id))?.restart).toBeUndefined();

  await t.run((ctx) => manager.restartFrom(ctx, id, 1));
  await settle(t);
  expect(await paused(t, id)).toBeUndefined();
  expect(ran).toEqual(['grab', 'notify']);
  expect(await status(t, id)).toMatchObject({ type: 'inProgress' }); // waiting for the download again
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'notify', 'import', 'prepare', 'publish']);
  expect(pauses).toHaveLength(1);
});

test('fail completes a paused run as failed, and onComplete runs', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  await t.run((ctx) => manager.fail(ctx, id));
  const result = await status(t, id);
  expect(result.type).toBe('failed');
  expect(result.type === 'failed' && result.error).toContain('Paused (mismatch): Journal entry mismatch at step 1');
  expect(completions.map((c) => c.result.kind)).toEqual(['failed']);
  expect(await paused(t, id)).toBeUndefined();
  await expect(t.run((ctx) => manager.fail(ctx, id))).rejects.toThrow("isn't paused");
  // The scheduled retry finds nothing to do.
  await settle(t, 61_000);
  expect(completions).toHaveLength(1);
});

test('cancel ends a paused run and its pause', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  await t.run((ctx) => manager.cancel(ctx, id));
  expect(await status(t, id)).toEqual({ type: 'canceled' });
  expect(await paused(t, id)).toBeUndefined();
  expect(completions.map((c) => c.result.kind)).toEqual(['canceled']);
});

test("upstream's restart drops the edits of deleted steps and keeps the applied ids", async () => {
  const t = setup();
  const id = await start(t);
  deploy('r3');
  await downloadDone(t, id);
  expect((await record(t, id))?.overlay).toHaveLength(1); // notify's stand-in, after grab

  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id, { from: 1 })); // keeps grab, so the stand-in stays
  await settle(t);
  expect(ran).toEqual([]); // grab and notify replay; the wait starts again
  await downloadDone(t, id);
  expect(ran).toEqual(['import {"notifiedAt":null}', 'transcode', 'publish']);

  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id, { from: 0 })); // deletes grab, so the stand-in goes
  await settle(t);
  expect(ran).toEqual(['grab', 'notify']);
  const saved = await record(t, id);
  expect(saved?.overlay).toEqual([]);
  expect(saved?.applied).toHaveLength(3);
});

test('cleanup deletes the run with its record', async () => {
  const t = setup();
  const id = await start(t);
  deploy('r1');
  await downloadDone(t, id);
  expect(await record(t, id)).not.toBeNull();
  expect(await t.run((ctx) => manager.cleanup(ctx, id))).toBe(true);
  expect(await record(t, id)).toBeNull();
});

test('migration ids are checked when the workflow is defined', () => {
  expect(() => release({}, [m1, migration('notify-after-grab', () => {})])).toThrow('the id "notify-after-grab" is listed twice');
  expect(() => migration('', () => {})).toThrow('non-empty string');
});
