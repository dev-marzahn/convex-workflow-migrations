// Runs on convex-test across simulated releases: `deploy(release)` swaps the
// function registered as flows:pipeline, as a deploy would.
import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric, mutationGeneric } from 'convex/server';
import { v } from 'convex/values';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { JITTER, PAGE_SIZE, UNFINISHED } from '../src/component/runs.ts';
import { DETAIL_LIMIT } from '../src/component/schema.ts';
import {
  type Migration,
  migration,
  type MigrationsComponent,
  type PauseInfo,
  type WorkflowComponent,
  type WorkflowCtx,
  type WorkflowId,
  WorkflowManager,
} from '../src/index.ts';
import migrationsTest from '../src/test.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowMigrations: MigrationsComponent };
const pauses: PauseInfo[] = [];
let onPauseThrows = false;
const manager = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  onPause: (_ctx, info) => {
    pauses.push(info);
    if (onPauseThrows) throw new Error('alerting is down');
  },
});

type Ref = FunctionReference<'mutation', 'internal', { args: Record<string, unknown> }, WorkflowId>;
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
// A stand-in of the wrong shape for release 2's handler, which reads `at`, and the migration that fixes its result.
const badStandIn = migration('notify-after-grab', (h) => h.insertAfter(flows.grab, flows.notify, { result: null }));
const fixStandIn = migration('notify-result-has-at', (h) => h.updateResult(flows.notify, () => ({ at: null })));
// Release 0 plus a required `channel` arg, which publish gets.
const channelArg = migration('channel-arg', (h) => h.updateWorkflowArgs((args) => ({ ...args, channel: 'default' })));

type Shape = { notify?: boolean; notifiedAt?: boolean; transcode?: boolean };
function release(shape: Shape, migrations: Migration[]) {
  return manager.define({
    args: {},
    migrations,
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.grab, {});
      const notified = shape.notify ? ((await step.runMutation(flows.notify, {})) as { at: number | null }) : undefined;
      await step.awaitEvent({ name: 'downloadDone' });
      await step.runMutation(flows.importFiles, shape.notifiedAt ? { notifiedAt: notified!.at } : {});
      await step.runMutation(shape.transcode ? flows.transcode : flows.prepare, {});
      await step.runMutation(flows.publish, {});
    },
  });
}
function withChannel(migrations: Migration[]) {
  return manager.define({
    args: { channel: v.string() },
    migrations,
    handler: async (step: WorkflowCtx, { channel }): Promise<void> => {
      await step.runMutation(flows.grab, {});
      await step.awaitEvent({ name: 'downloadDone' });
      await step.runMutation(flows.importFiles, {});
      await step.runMutation(flows.prepare, {});
      await step.runMutation(flows.publish, { channel });
    },
  });
}

const releases = {
  r0: release({}, []),
  r1: release({ notify: true }, [m1]),
  // Release 1 for a step old runs must never make, even those that hadn't got past grab.
  r1AtEnd: release({ notify: true }, [migration('notify-after-grab', (h) => h.insertAfter(flows.grab, flows.notify, { result: { at: null }, atEnd: true }))]),
  r2: release({ notify: true, notifiedAt: true }, [m1, m2]),
  r3: release({ notify: true, notifiedAt: true, transcode: true }, [m1, m2, m3]),
  // Release 1's change without its migration.
  unguarded: release({ notify: true }, []),
  // Release 1's change with a migration that does nothing, and then with the same migration fixed.
  noopX: release({ notify: true }, [migration('x', () => {})]),
  fixedX: release({ notify: true }, [migration('x', (h) => h.insertAfter(flows.grab, flows.notify, { result: { at: null } }))]),
  // Another change without its migration, with noopX's list: it imports where the history has the wait.
  skipsWaitX: manager.define({
    args: {},
    migrations: [migration('x', () => {})],
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.grab, {});
      await step.runMutation(flows.importFiles, {});
    },
  }),
  // A migration that throws.
  broken: release({ notify: true }, [
    migration('broken', () => {
      throw new Error('oops');
    }),
  ]),
  badStandIn: release({ notify: true, notifiedAt: true }, [badStandIn]),
  fixedStandIn: release({ notify: true, notifiedAt: true }, [badStandIn, fixStandIn]),
  channelUnguarded: withChannel([]),
  channel: withChannel([channelArg]),
  // Code that stops after grab: shorter than the histories of runs past it.
  short: manager.define({
    args: {},
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.grab, {});
    },
  }),
  // After the wait, a step that fails: the run fails, as before.
  failing: manager.define({
    args: {},
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.grab, {});
      await step.awaitEvent({ name: 'downloadDone' });
      await step.runMutation(flows.boom, {});
    },
  }),
  // A stand-in too big to store.
  huge: release({ notify: true }, [
    migration('huge-stand-in', (h) => h.insertAfter(flows.grab, flows.notify, { result: { at: null, padding: 'x'.repeat(600_000) } })),
  ]),
  // Calls grab with huge args, which the history doesn't have.
  hugeArgs: manager.define({
    args: {},
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.grab, { blob: 'x'.repeat(600_000) });
      await step.awaitEvent({ name: 'downloadDone' });
    },
  }),
};

const functions: Record<string, unknown> = {
  grab: stepFn('grab'),
  notify: stepFn('notify', { at: 1234 }),
  importFiles: stepFn('import'),
  prepare: stepFn('prepare'),
  transcode: stepFn('transcode'),
  publish: stepFn('publish'),
  boom: internalMutationGeneric({
    handler: async () => {
      throw new Error('the download is corrupt');
    },
  }),
  onComplete: internalMutationGeneric({
    args: { workflowId: v.string(), result: v.any(), context: v.any() },
    handler: async (_ctx, { workflowId, result }) => void completions.push({ workflowId, result }),
  }),
  pipeline: releases.r0,
};
const deploy = (name: keyof typeof releases) => void (functions.pipeline = releases[name]);

/** A test-only module of the migrations component: `setFormat` makes a record look like a newer version wrote it. */
const overrides = {
  setFormat: mutationGeneric({
    args: { workflowId: v.string(), format: v.number() },
    handler: async (ctx, { workflowId, format }) => {
      const run = await ctx.db
        .query('runs')
        .withIndex('workflowId', (q) => q.eq('workflowId', workflowId))
        .first();
      await ctx.db.patch('runs', run!._id, { format });
    },
  }),
};
const setFormat = (components.workflowMigrations as unknown as { overrides: { setFormat: FunctionReference<'mutation'> } }).overrides.setFormat;

function setup() {
  const t = convexTest(defineSchema({}), {
    './_generated/api.ts': async () => ({}),
    './flows.ts': async () => functions,
  });
  migrationsTest.register(t);
  t.registerComponent('workflowMigrations', migrationsTest.schema, { ...migrationsTest.modules, './component/overrides.ts': async () => overrides });
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
async function start(t: T, args: Record<string, unknown> = {}) {
  const id = await t.run((ctx) => manager.start(ctx, pipeline, args, { onComplete: flows.onComplete, context: null }));
  await settle(t);
  return id;
}
async function downloadDone(t: T, workflowId: WorkflowId) {
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name: 'downloadDone' }));
  await settle(t);
}
const completed = { type: 'completed', result: null };
const status = (t: T, workflowId: WorkflowId) => t.run((ctx) => manager.status(ctx, workflowId));
const record = (t: T, workflowId: WorkflowId) => t.run((ctx) => ctx.runQuery(components.workflowMigrations.runs.load, { workflowId }));
const paused = async (t: T, workflowId: WorkflowId) => (await t.run((ctx) => manager.paused(ctx))).page.find((run) => run.workflowId === workflowId);
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
    live: true,
    origin: 'start',
    format: 1,
  });
  await downloadDone(t, id);
  expect(ran).toEqual(['grab', 'notify', 'import {"notifiedAt":1234}', 'transcode', 'publish']);
  expect(await record(t, id)).toMatchObject({ overlay: [], live: false });
});

test('a queued run gets its record when it starts, so a release that changes its args before its first handler run migrates it', async () => {
  const t = setup();
  // Through the manager, and through the workflow mutation itself, as upstream's standalone start calls it.
  const ids = await t.run(async (ctx) => [
    await manager.start(ctx, pipeline, {}, { startAsync: true }),
    (await ctx.runMutation(pipeline, { args: {}, startAsync: true } as never)) as WorkflowId,
  ]);
  for (const id of ids) expect(await record(t, id)).toMatchObject({ applied: [], live: true, origin: 'start' });
  expect(ran).toEqual([]);
  // Release 4 lands before they first run: their args gain a channel through its migration.
  deploy('channel');
  await settle(t);
  for (const id of ids) {
    expect(await paused(t, id)).toBeUndefined();
    await downloadDone(t, id);
    expect(await status(t, id)).toEqual(completed);
    expect(await record(t, id)).toMatchObject({ applied: ['channel-arg'], live: false });
  }
  expect(ran.filter((step) => step.startsWith('publish'))).toEqual(['publish {"channel":"default"}', 'publish {"channel":"default"}']);
});

test('a queued run whose args no release can fix pauses with args instead of failing', async () => {
  const t = setup();
  const id = await t.run((ctx) => manager.start(ctx, pipeline, {}, { startAsync: true }));
  deploy('channelUnguarded');
  await settle(t);
  expect(await paused(t, id)).toMatchObject({ reason: 'args' });
  expect(await status(t, id)).toMatchObject({ type: 'inProgress' });
  deploy('channel');
  expect(await t.run((ctx) => manager.resume(ctx, id))).toBe(true);
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual(completed);
});

test('restarting a run that has no record, from before adoption, from 0 gives it one with nothing applied', async () => {
  const t = setup();
  const id = await start(t);
  await downloadDone(t, id);
  // As if it had run before the app adopted this package.
  await t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.forget, { workflowIds: [id] }));
  expect(await record(t, id)).toBeNull();
  deploy('channel');
  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id, { from: 0, startAsync: true }));
  expect(await record(t, id)).toMatchObject({ applied: [], live: true, origin: 'adopted' });
  await settle(t);
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'import', 'prepare', 'publish {"channel":"default"}']);
  expect(await record(t, id)).toMatchObject({ applied: ['channel-arg'], live: false });
});

test('a run whose anchor step was running across the deploy makes the inserted call for real; atEnd gives it the stand-in', async () => {
  for (const [name, notified] of [
    ['r1', true],
    ['r1AtEnd', false],
  ] as const) {
    const t = setup();
    ran.length = 0;
    deploy('r0');
    // Started, but grab hasn't run: the run is waiting at it when the deploy lands.
    const id = await t.run((ctx) => manager.start(ctx, pipeline, {}));
    expect(ran).toEqual([]);
    deploy(name);
    await settle(t);
    await downloadDone(t, id);
    expect(await status(t, id)).toEqual(completed);
    expect(ran).toEqual(notified ? ['grab', 'notify', 'import', 'prepare', 'publish'] : ['grab', 'import', 'prepare', 'publish']);
    expect((await record(t, id))?.overlay.map((op) => op.op)).toEqual(notified ? [] : ['insert']);
  }
});

test('a stand-in resolves the call without running it or adding a journal entry', async () => {
  const t = setup();
  const id = await start(t);
  deploy('r1');
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'import', 'prepare', 'publish']);
  expect(await steps(t, id)).toEqual(['grab', 'downloadDone', 'importFiles', 'prepare', 'publish']);
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
  // A minute, ±20%.
  expect(run!.nextAttemptAt - run!.at).toBeGreaterThanOrEqual(48_000);
  expect(run!.nextAttemptAt - run!.at).toBeLessThanOrEqual(72_000);
  expect(pauses).toEqual([{ workflowId: id, workflow: 'flows:pipeline', reason: 'mismatch', detail: run!.detail, step: 1, attempts: 1 }]);

  // Retried with backoff; still the same code, so still paused, and no second alert.
  await settle(t, 73_000);
  const again = await paused(t, id);
  expect(again).toMatchObject({ attempts: 2, at: run!.at });
  // The retry ran when it was due (settle advances time in 250ms steps), and the next waits 10 minutes, ±20%.
  expect(again!.nextAttemptAt - run!.nextAttemptAt).toBeGreaterThanOrEqual(480_000);
  expect(again!.nextAttemptAt - run!.nextAttemptAt).toBeLessThan(720_250);
  expect(pauses).toHaveLength(1);

  // A release with the migration: the next retry resumes the run.
  deploy('r1');
  await settle(t, 721_000);
  expect(await paused(t, id)).toBeUndefined();
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'import', 'prepare', 'publish']);
  expect(completions).toEqual([{ workflowId: id, result: { kind: 'success', returnValue: null } }]);
});

test("changed workflow args pause a run with history; updateWorkflowArgs resumes it; a new run's bad args are refused", async () => {
  const t = setup();
  const id = await start(t);
  deploy('channelUnguarded');
  await downloadDone(t, id);
  const run = await paused(t, id);
  expect(run).toMatchObject({ reason: 'args' });
  expect(run?.detail).toContain("The workflow's args don't match its args validator");
  expect(completions).toEqual([]);

  deploy('channel');
  expect(await t.run((ctx) => manager.resume(ctx, id))).toBe(true);
  await settle(t);
  expect(await status(t, id)).toEqual(completed);
  // The handler got the migrated args; the run keeps its own.
  expect(ran).toEqual(['grab', 'import', 'prepare', 'publish {"channel":"default"}']);
  expect((await record(t, id))?.overlay).toEqual([{ op: 'workflowArgs', args: { channel: 'default' } }]);
  expect(await t.run(async (ctx) => (await ctx.runQuery(components.workflow.workflow.getStatus, { workflowId: id })).workflow.args)).toEqual({});

  // A new run without the arg is refused when it starts, as upstream's is, and with startAsync too.
  deploy('channelUnguarded');
  await expect(start(t)).rejects.toThrow('Missing required field `channel`');
  await expect(t.run((ctx) => manager.start(ctx, pipeline, {}, { startAsync: true }))).rejects.toThrow('Missing required field `channel`');
});

test('a stand-in result the handler throws on pauses the run; updateResult in a later migration resumes it', async () => {
  const t = setup();
  const id = await start(t);
  deploy('badStandIn');
  await downloadDone(t, id);
  const run = await paused(t, id);
  // It throws reading notify's `at` after the wait, the last recorded step: the migration that just applied is suspect.
  expect(run).toMatchObject({ reason: 'threw' });
  expect(run?.detail).toContain('The handler threw after migrations "notify-after-grab" changed its history: ');
  expect(completions).toEqual([]);
  expect(await steps(t, id)).toEqual(['grab', 'downloadDone']); // nothing new started

  deploy('fixedStandIn');
  expect(await t.run((ctx) => manager.resume(ctx, id))).toBe(true);
  await settle(t);
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'import {"notifiedAt":null}', 'prepare', 'publish']);
});

test('a handler that returns before the end of its history pauses the run', async () => {
  const t = setup();
  const id = await start(t);
  deploy('short');
  await downloadDone(t, id);
  const run = await paused(t, id);
  expect(run).toMatchObject({ reason: 'mismatch', step: 1 });
  expect(run?.detail).toBe('Journal entry mismatch at step 1: the code returned before it, the history has {"args":{},"kind":"event","name":"downloadDone"}');
  expect(await status(t, id)).toMatchObject({ type: 'inProgress' });
});

test("a step's failure after the history fails the run, as before", async () => {
  const t = setup();
  const id = await start(t);
  deploy('failing');
  await downloadDone(t, id);
  const result = await status(t, id);
  expect(result.type === 'failed' && result.error).toContain('the download is corrupt');
  expect(completions.map((c) => c.result.kind)).toEqual(['failed']);
  expect(await paused(t, id)).toBeUndefined();
});

test('a step that fails right after a deploy fails the run, though the deploy’s migrations edited its history', async () => {
  const t = setup();
  const id = await start(t);
  deploy('r1'); // inserts notify after grab, the next time the run replays
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId: id, name: 'downloadDone', error: 'the download failed' }));
  await settle(t);
  const result = await status(t, id);
  expect(result.type === 'failed' && result.error).toContain('the download failed');
  expect(await paused(t, id)).toBeUndefined();
  expect(pauses).toEqual([]);
  expect(completions.map((c) => c.result.kind)).toEqual(['failed']);
  expect((await record(t, id))?.applied).toEqual(['notify-after-grab']);
});

test("a pause's detail is cut, so a huge argument can't make the pause too big to store", async () => {
  const t = setup();
  const id = await start(t);
  deploy('hugeArgs');
  await downloadDone(t, id);
  const run = await paused(t, id);
  expect(run).toMatchObject({ reason: 'mismatch', step: 0 });
  expect(run!.detail.length).toBeLessThan(2 * DETAIL_LIMIT + 200);
  expect(run!.detail).toMatch(
    /^Journal entry mismatch at step 0: the code calls \{"args":\{"blob":"x+…, the history has \{"args":\{\},"kind":"function","name":"flows:grab"\}$/,
  );
  expect(pauses.map((p) => p.detail)).toEqual([run!.detail]);
});

test('a retry left over from a paused run that was completed ends its pause', async () => {
  // A paused run that upstream's component completed, past the manager.
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  await t.run(async (ctx) => {
    const { workflow } = await ctx.runQuery(components.workflow.workflow.getStatus, { workflowId: id });
    const runResult = { kind: 'failed' as const, error: 'gave up' };
    await ctx.runMutation(components.workflow.workflow.complete, { workflowId: id, generationNumber: workflow.generationNumber, runResult });
  });
  expect(await paused(t, id)).toMatchObject({ attempts: 1 });
  expect(await record(t, id)).toMatchObject({ live: true });
  await settle(t, 73_000);
  expect(await paused(t, id)).toBeUndefined();
  expect(await status(t, id)).toEqual({ type: 'failed', error: 'gave up' });
  expect(completions.map((c) => c.result.kind)).toEqual(['failed']);
  // The workflow mutation found the run finished: its record isn't live any more, so the CLI doesn't list it.
  expect(await record(t, id)).toMatchObject({ live: false });
});

test('an overlay over the size limit pauses the run, naming the migration, and saves nothing', async () => {
  const t = setup();
  const id = await start(t);
  deploy('huge');
  await downloadDone(t, id);
  const run = await paused(t, id);
  expect(run).toMatchObject({ reason: 'overlay' });
  expect(run?.detail).toMatch(/^The run's overlay would be \d+ KiB, over the 512 KiB limit\. This handler run added to it: migration "huge-stand-in"\.$/);
  expect((await record(t, id))?.overlay).toEqual([]);
});

test('a retry whose workflow mutation throws keeps the pause, with the error as lastError', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  functions.pipeline = internalMutationGeneric({
    handler: async () => {
      throw new Error('boom');
    },
  });
  const before = await paused(t, id);
  const warn = vi.spyOn(console, 'warn');
  await settle(t, 73_000);
  const run = await paused(t, id);
  // It keeps the pause it retried, so restartFrom still has its step, and records the throw on its own.
  expect(run).toMatchObject({ reason: 'mismatch', step: 1, detail: before!.detail, attempts: 2, at: before!.at });
  expect(run?.lastError).toContain('The workflow mutation threw: ');
  expect(run?.lastError).toContain('boom');
  expect(run!.nextAttemptAt - run!.at).toBeGreaterThan(400_000); // the next backoff step
  expect(
    warn.mock.calls.some(([message]) => String(message).startsWith(`Retrying paused workflow ${id}: its workflow mutation threw, so it stays paused`)),
  ).toBe(true);
  warn.mockRestore();
  // The same pause again: no second onPause, and no previousReason it never saw. resume doesn't count an attempt.
  deploy('unguarded');
  expect(await t.run((ctx) => manager.resume(ctx, id))).toBe(false);
  expect(await paused(t, id)).toMatchObject({ reason: 'mismatch', step: 1, attempts: 2, nextAttemptAt: run!.nextAttemptAt });
  expect((await paused(t, id))?.lastError).toBeUndefined();
  expect(pauses.map((p) => [p.reason, p.attempts, p.previousReason])).toEqual([['mismatch', 1, undefined]]);
  deploy('r1');
  expect(await t.run((ctx) => manager.resume(ctx, id))).toBe(true);
  await settle(t);
  expect(await status(t, id)).toEqual(completed);
  expect(pauses).toHaveLength(1);
});

test('a retry is write-ahead: when its attempt dies, even past a catch, the next retry still arrives', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  const first = await paused(t, id);
  // The attempt's transaction dies: here its workflow mutation throws, and so does the warning it logs, so nothing of it commits.
  functions.pipeline = internalMutationGeneric({
    handler: async () => {
      throw new Error('boom');
    },
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    if (String(message).startsWith('Retrying paused workflow')) throw new Error('the attempt ran out of time');
  });
  await settle(t, 73_000);
  const died = await paused(t, id);
  // The retry counted it and scheduled the next one before the attempt started.
  expect(died).toMatchObject({ attempts: 2, at: first!.at, lastError: UNFINISHED });
  expect(died!.nextAttemptAt - first!.nextAttemptAt).toBeGreaterThanOrEqual(480_000);
  await settle(t, 721_000);
  expect(await paused(t, id)).toMatchObject({ attempts: 3, lastError: UNFINISHED });
  warn.mockRestore();
  // A release with the migration: the retry after that, an hour later, resumes the run.
  deploy('r1');
  vi.advanceTimersByTime(3_600_000 * (1 + JITTER));
  await settle(t);
  expect(await paused(t, id)).toBeUndefined();
  expect(await status(t, id)).toEqual(completed);
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

test('resume retries now, says whether the run got past its pause, and throws for a run that is not paused', async () => {
  const t = setup();
  const id = await start(t);
  await expect(t.run((ctx) => manager.resume(ctx, id))).rejects.toThrow(`resume: workflow ${id} isn't paused.`);
  deploy('unguarded');
  await downloadDone(t, id);
  const before = await paused(t, id);
  expect(await t.run((ctx) => manager.resume(ctx, id))).toBe(false);
  // Paused again: its attempts and its scheduled retry stay.
  expect(await paused(t, id)).toEqual(before);
  deploy('r1');
  expect(await t.run((ctx) => manager.resume(ctx, id))).toBe(true);
  await settle(t);
  expect(await status(t, id)).toEqual(completed);
  // The retry the pause scheduled finds nothing to do.
  await settle(t, 700_000);
  expect(ran).toEqual(['grab', 'import', 'prepare', 'publish']);
});

test('resumeAll retries every paused run of a workflow now; paused() pages and filters', async () => {
  const t = setup();
  const ids = [await start(t), await start(t)];
  deploy('unguarded');
  for (const workflowId of ids) await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name: 'downloadDone' }));
  await settle(t, 10_000);
  const first = await t.run((ctx) => manager.paused(ctx, { numItems: 1 }));
  expect(first.page).toHaveLength(1);
  expect(first.isDone).toBe(false);
  const second = await t.run((ctx) => manager.paused(ctx, { numItems: 1, cursor: first.continueCursor }));
  expect([...first.page, ...second.page].map((run) => run.workflowId).sort()).toEqual([...ids].sort());
  expect((await t.run((ctx) => manager.paused(ctx, { workflow: 'flows:other' }))).page).toEqual([]);
  expect((await t.run((ctx) => manager.paused(ctx, { workflow: 'flows:pipeline' }))).page).toHaveLength(2);

  deploy('r1');
  await t.run((ctx) => manager.resumeAll(ctx, { workflow: 'flows:other' }));
  await settle(t, 1_000);
  expect((await t.run((ctx) => manager.paused(ctx))).page).toHaveLength(2);
  await t.run((ctx) => manager.resumeAll(ctx, { workflow: 'flows:pipeline' }));
  await settle(t, 10_000); // well before the next scheduled retry, a minute after the pause
  for (const id of ids) expect(await status(t, id)).toEqual(completed);
  expect((await t.run((ctx) => manager.paused(ctx))).page).toEqual([]);
});

test('resumeAll retries each run paused when it was called once, a page at a time, though each retry pauses it again; new pauses do not keep it going', async () => {
  const t = setup();
  // More than a page, all waiting for the download.
  const ids = await t.run(async (ctx) => {
    const started: WorkflowId[] = [];
    for (let i = 0; i <= PAGE_SIZE; i++) started.push(await manager.start(ctx, pipeline, {}));
    return started;
  });
  const late = await start(t);
  deploy('unguarded');
  await t.run(async (ctx) => {
    for (const workflowId of ids) await manager.sendEvent(ctx, { workflowId, name: 'downloadDone' });
  });
  await settle(t, 10_000);
  const before = (await t.run((ctx) => manager.paused(ctx, { numItems: 200 }))).page;
  expect(before.map((run) => run.attempts)).toEqual(ids.map(() => 1));
  // Jitter: runs that paused together don't retry together.
  expect(new Set(before.map((run) => run.nextAttemptAt - run.at)).size).toBeGreaterThan(1);
  const calledAt = Date.now();
  // A run that pauses after the first call: here before it, with `until` set as the first call sets it to its own time.
  vi.advanceTimersByTime(5_000);
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId: late, name: 'downloadDone' }));
  await settle(t, 1_000);
  expect((await record(t, late))?.paused).toMatchObject({ attempts: 1 });

  // Still on code that doesn't match. The second page must carry the first call's bound.
  await t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.resumeAll, { until: calledAt }));
  await settle(t, 12_000); // the retries are 100 ms apart, and well before the scheduled ones
  const after = (await t.run((ctx) => manager.paused(ctx, { numItems: 200 }))).page;
  expect(after.at(-1)).toMatchObject({ workflowId: late, attempts: 1 });
  expect(
    after
      .slice(0, -1)
      .map((run) => run.workflowId)
      .sort(),
  ).toEqual([...ids].sort());
  expect(after.slice(0, -1).every((run) => run.attempts === 2 && run.lastError === undefined)).toBe(true);
  // A retry starts the next backoff step: 10 minutes.
  expect(after[0]!.nextAttemptAt - calledAt).toBeGreaterThan(400_000);
});

test("resumeAll and paused read only the runs' pauses, not their records, however big their overlays", async () => {
  // Convex's per-transaction limits, enforced: 16 MiB read.
  const t = convexTest({
    schema: defineSchema({}),
    modules: { './_generated/api.ts': async () => ({}), './flows.ts': async () => functions },
    transactionLimits: true,
  });
  migrationsTest.register(t);
  const { runs } = components.workflowMigrations;
  const overlay = [
    { op: 'insert' as const, id: '+1', where: 'after' as const, anchor: 'j0', name: 'flows:notify', kind: 'function' as const, result: 'x'.repeat(450_000) },
  ];
  const pause = {
    workflow: 'flows:pipeline',
    reason: 'mismatch' as const,
    detail: 'x',
    appliedCount: 0,
    handle: 'function://;flows:pipeline',
    generationNumber: 0,
  };
  // 40 records of 450 KiB: 18 MiB together, each written in its own transaction.
  for (let i = 0; i < 40; i++) {
    await t.run(async (ctx) => {
      await ctx.runMutation(runs.save, { workflowId: `w${i}`, workflow: 'flows:pipeline', applied: [], overlay, done: false });
      await ctx.runMutation(runs.pause, { workflowId: `w${i}`, ...pause });
    });
  }
  expect((await t.run((ctx) => manager.paused(ctx))).page).toHaveLength(40);
  await t.run((ctx) => manager.resumeAll(ctx));
  // Each retry reads its pause, and starts the attempt, whose workflow mutation finds no such run.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await settle(t, 6_000);
  warn.mockRestore();
  expect((await t.run((ctx) => manager.paused(ctx))).page.every((run) => run.attempts === 2)).toBe(true);
});

test('the record of a paused run whose workflow is gone is deleted at its next retry', async () => {
  // Upstream deletes a child workflow, paused or not, when it cleans up its parent.
  const t = setup();
  const [gone, kept] = [await start(t), await start(t)];
  deploy('unguarded');
  for (const workflowId of [gone, kept]) await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name: 'downloadDone' }));
  await settle(t, 10_000);
  await t.run((ctx) => ctx.runMutation(components.workflow.workflow.cleanup, { workflowId: gone, force: true }));
  await settle(t, 73_000);
  expect(await record(t, gone)).toBeNull();
  expect(await paused(t, kept)).toMatchObject({ attempts: 2 });
  // A workflow that is gone and has no record still fails as upstream's does.
  const retryGone = { workflowId: gone, generationNumber: 0 } as unknown as { args: Record<string, unknown> };
  await expect(t.mutation(pipeline, retryGone)).rejects.toThrow('Workflow not found');
});

test('onPause is called again when the reason or step changes, with the attempts and the reason before', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  await t.run((ctx) => manager.resume(ctx, id)); // the same pause again: no alert
  expect(pauses.map((p) => [p.reason, p.attempts, p.previousReason])).toEqual([['mismatch', 1, undefined]]);
  deploy('badStandIn'); // now it throws on the stand-in's result
  await t.run((ctx) => manager.resume(ctx, id));
  expect(pauses.map((p) => [p.reason, p.attempts, p.previousReason])).toEqual([
    ['mismatch', 1, undefined],
    ['threw', 1, 'mismatch'],
  ]);
});

test('onPause is called again when the code a retry pauses on changed: another number of migrations applied, or another mismatch', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  // The same code again: no alert.
  await t.run((ctx) => manager.resume(ctx, id));
  expect(pauses).toHaveLength(1);
  // A release with a migration that does nothing: the same mismatch, at the same step, with one more migration applied.
  deploy('noopX');
  await t.run((ctx) => manager.resume(ctx, id));
  expect(pauses).toHaveLength(2);
  expect(pauses[1]).toMatchObject({ reason: 'mismatch', step: 1, detail: pauses[0]!.detail, previousReason: 'mismatch' });
  await t.run((ctx) => manager.resume(ctx, id));
  expect(pauses).toHaveLength(2);
  // The same reason, step and migrations, but the code makes another call there.
  deploy('skipsWaitX');
  await t.run((ctx) => manager.resume(ctx, id));
  expect(pauses).toHaveLength(3);
  expect(pauses[2]?.detail).toContain('the code calls {"args":{},"kind":"function","name":"flows:importFiles"}');
});

test('restartFrom after a pause where a migration threw says to resume first, since no position was read', async () => {
  const t = setup();
  const id = await start(t);
  deploy('broken');
  await downloadDone(t, id);
  expect(await paused(t, id)).toMatchObject({ reason: 'migration' });
  expect((await paused(t, id))?.step).toBeUndefined();
  // Still broken: it would pause again.
  await expect(t.run((ctx) => manager.restartFrom(ctx, id, 1))).rejects.toThrow('would pause it again (migration)');
  // Fixed: the migrations apply now, so the pause gave no position in this history.
  deploy('r1');
  await expect(t.run((ctx) => manager.restartFrom(ctx, id, 1))).rejects.toThrow(
    'restartFrom: the run paused before its migrations had all applied (a migration threw), so it has no position to restart from yet. Call resume',
  );
  expect(await paused(t, id)).toMatchObject({ reason: 'migration', attempts: 1 });
  expect(await t.run((ctx) => manager.resume(ctx, id))).toBe(true);
  await settle(t);
  expect(await status(t, id)).toEqual(completed);
});

test('restart without from checks the journal and the record too: a journal too big to load whole, and a record from a newer version', async () => {
  const t = setup();
  const id = await start(t);
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual(completed);
  // As upstream's journal.load answers for a journal over its size limit.
  const tooBig = await t.run(async (ctx) => {
    const fake = {
      runQuery: async (ref: FunctionReference<'query', 'public' | 'internal'>, args: Record<string, unknown>) => {
        const result = (await ctx.runQuery(ref as never, args as never)) as unknown;
        return typeof result === 'object' && result !== null && 'journalEntries' in result ? { ...result, ok: false } : result;
      },
      runMutation: ctx.runMutation,
    };
    return await manager.restart(fake as never, id).then(
      () => 'restarted',
      (error: Error) => error.message,
    );
  });
  expect(tooBig).toBe(`restart: workflow ${id}'s journal is too big to load whole, so its history can't be read.`);
  expect(await status(t, id)).toEqual(completed);

  await t.run((ctx) => ctx.runMutation(setFormat, { workflowId: id, format: 2 }));
  await expect(t.run((ctx) => manager.restart(ctx, id))).rejects.toThrow(
    `restart: workflow ${id}'s record has format 2, from a newer version of this package; this one reads 1.`,
  );
  expect(await status(t, id)).toEqual(completed);
  expect(await record(t, id)).toMatchObject({ live: false, format: 2 });
});

test('a record from a newer version: the component refuses to restart or end it, so restart, cancel and fail change nothing', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  await t.run((ctx) => ctx.runMutation(setFormat, { workflowId: id, format: 2 }));
  const before = await record(t, id);
  const { runs } = components.workflowMigrations;
  const newer = `record has format 2, from a newer version of @dev-marzahn/convex-workflow-migrations; this one reads 1.`;
  await expect(t.run((ctx) => ctx.runMutation(runs.restart, { workflowId: id, workflow: 'flows:pipeline' }))).rejects.toThrow(
    `restart: workflow ${id}'s ${newer}`,
  );
  await expect(t.run((ctx) => ctx.runMutation(runs.end, { workflowId: id }))).rejects.toThrow(`cancel: workflow ${id}'s ${newer}`);
  await expect(t.run((ctx) => manager.fail(ctx, id))).rejects.toThrow(`fail: workflow ${id}'s ${newer}`);
  await expect(t.run((ctx) => manager.cancel(ctx, id))).rejects.toThrow(`cancel: workflow ${id}'s ${newer}`);
  // Upstream's cancel ran, and its onComplete, but the transaction rolled back.
  expect(await record(t, id)).toEqual(before);
  expect(await status(t, id)).toMatchObject({ type: 'inProgress' });
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

test('restartFrom drops the history from a step on, in one operation, and those steps run again', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id); // paused at step 1: the code calls notify, the history has the wait
  // Past the end of the history (grab, the wait): nothing to restart from.
  await expect(t.run((ctx) => manager.restartFrom(ctx, id, 2))).rejects.toThrow('restartFrom: the history has 2 steps, so step must be below 2, got 2.');
  expect(await paused(t, id)).toMatchObject({ attempts: 1 });
  expect((await record(t, id))?.paused?.restartFrom).toBeUndefined();

  await t.run((ctx) => manager.restartFrom(ctx, id, 1));
  await settle(t);
  expect(await paused(t, id)).toBeUndefined();
  expect(ran).toEqual(['grab', 'notify']);
  expect((await record(t, id))?.overlay.map((op) => op.op)).toEqual(['truncate']);
  expect(await status(t, id)).toMatchObject({ type: 'inProgress' }); // waiting for the download again
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'notify', 'import', 'prepare', 'publish']);
  // The old wait stays in upstream's journal, hidden; the new steps come after it.
  expect(await steps(t, id)).toEqual(['grab', 'downloadDone', 'notify', 'downloadDone', 'importFiles', 'prepare', 'publish']);
  expect(pauses).toHaveLength(1);
  await expect(t.run((ctx) => manager.restartFrom(ctx, id, 0))).rejects.toThrow(`restartFrom: workflow ${id} isn't paused.`);
});

test('restartFrom throws, changing nothing, where the run would pause again', async () => {
  const t = setup();
  deploy('r3');
  const id = await start(t);
  deploy('r2'); // a rollback: every position pauses again
  await downloadDone(t, id);
  const before = await record(t, id);
  await expect(t.run((ctx) => manager.restartFrom(ctx, id, 1))).rejects.toThrow('would pause it again (migrations)');
  expect(await record(t, id)).toEqual(before);
  expect(await steps(t, id)).toEqual(['grab', 'notify', 'downloadDone']);
});

test('restartFrom refuses a position read before the history changed: a release added a migration, or the paused step moved', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id); // paused at step 1, the wait
  // r1 inserts notify after grab: step 1 is now its stand-in, and restarting there would run notify for real.
  deploy('r1');
  const stale = 'restartFrom: the history changed since the run paused';
  await expect(t.run((ctx) => manager.restartFrom(ctx, id, 1))).rejects.toThrow(stale);
  expect(await paused(t, id)).toMatchObject({ reason: 'mismatch', step: 1, attempts: 1 });
  expect((await record(t, id))?.paused?.restartFrom).toBeUndefined();

  // The same count of migrations, but one whose body was fixed: the wait moved from step 1 to 2.
  const t2 = setup();
  deploy('r0');
  const id2 = await start(t2);
  deploy('noopX');
  await downloadDone(t2, id2);
  expect(await paused(t2, id2)).toMatchObject({ reason: 'mismatch', step: 1 });
  deploy('fixedX');
  await expect(t2.run((ctx) => manager.restartFrom(ctx, id2, 1))).rejects.toThrow(stale);
  // resume, then read paused again: here it resumes.
  expect(await t2.run((ctx) => manager.resume(ctx, id2))).toBe(true);
  await settle(t2);
  expect(await status(t2, id2)).toEqual(completed);
  expect(ran.filter((name) => name === 'notify')).toEqual([]);
});

test('resume and restartFrom throw for a run that is no longer paused, in the same transaction', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  deploy('r1');
  // The scheduled retry resumes it before the calls land.
  await settle(t, 73_000);
  expect(await paused(t, id)).toBeUndefined();
  await expect(t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.resume, { workflowId: id }))).rejects.toThrow(
    `resume: workflow ${id} isn't paused.`,
  );
  await expect(t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.resume, { workflowId: id, restartFrom: 0 }))).rejects.toThrow(
    `restartFrom: workflow ${id} isn't paused.`,
  );
  // A scheduled one just finds nothing to do.
  expect(await t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.retry, { workflowId: id }))).toBe(false);
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
  await settle(t, 73_000);
  expect(completions).toHaveLength(1);
});

test("fail fails the run and ends its pause in the caller's transaction, so it takes a mutation's ctx", async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  // Something after it in the same mutation throws: neither the failure nor the end of the pause commits.
  await expect(
    t.run(async (ctx) => {
      await manager.fail(ctx, id);
      throw new Error('later in the same mutation');
    }),
  ).rejects.toThrow('later in the same mutation');
  expect(await paused(t, id)).toMatchObject({ reason: 'mismatch' });
  expect(await status(t, id)).toMatchObject({ type: 'inProgress' });
  // An action's ctx has no db: from there the steps would be transactions apart.
  await expect(t.action(async (ctx) => manager.fail(ctx as never, id))).rejects.toThrow("fail takes a mutation's ctx");
  await t.run((ctx) => manager.fail(ctx, id));
  expect(await status(t, id)).toMatchObject({ type: 'failed' });
  expect(await record(t, id)).toMatchObject({ live: false });
  expect(await paused(t, id)).toBeUndefined();
  // resume and restartFrom check and retry in one component mutation, so they stay callable from an action.
  await expect(t.action((ctx) => manager.resume(ctx, id))).rejects.toThrow("isn't paused");
});

test('cancel ends a paused run and its pause', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  await t.run((ctx) => manager.cancel(ctx, id));
  expect(await status(t, id)).toEqual({ type: 'canceled' });
  expect(await paused(t, id)).toBeUndefined();
  expect(await record(t, id)).toMatchObject({ live: false });
  expect(completions.map((c) => c.result.kind)).toEqual(['canceled']);
});

test('restart takes a position in the migrated history, and steps from there run again, stand-ins included', async () => {
  const t = setup();
  const id = await start(t);
  deploy('r3');
  await downloadDone(t, id);
  // grab, notify (a stand-in), downloadDone, importFiles, transcode, publish
  expect((await record(t, id))?.overlay).toHaveLength(1);
  await expect(t.run((ctx) => manager.restart(ctx, id, { from: 'nothing' }))).rejects.toThrow('has no step "nothing"');

  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id, { from: 2 })); // the wait: grab and the stand-in stay
  await settle(t);
  expect(ran).toEqual([]);
  await downloadDone(t, id);
  expect(ran).toEqual(['import {"notifiedAt":null}', 'transcode', 'publish']);

  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id, { from: 1 })); // the stand-in: notify runs for real now
  await settle(t);
  expect(ran).toEqual(['notify']);
  // Upstream deleted the journal from the wait on, each time; the stand-in, which isn't in the journal, is removed.
  expect((await record(t, id))?.overlay.map((op) => op.op)).toEqual(['insert', 'remove']);
  await downloadDone(t, id);
  expect(ran).toEqual(['notify', 'import {"notifiedAt":1234}', 'transcode', 'publish']);
  expect((await record(t, id))?.applied).toHaveLength(3);
  const journal = ['grab', 'notify', 'downloadDone', 'importFiles', 'transcode', 'publish'];
  expect(await steps(t, id)).toEqual(journal);

  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id, { from: flows.transcode })); // its last call, by reference
  await settle(t);
  expect(ran).toEqual(['transcode', 'publish']);
  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id, { from: 'downloadDone' })); // by name
  await settle(t);
  expect(ran).toEqual([]);
  expect((await record(t, id))?.restart).toBeUndefined();
  await downloadDone(t, id);
  // Repeated restarts don't grow the journal: each deletes what it runs again.
  expect(await steps(t, id)).toEqual(journal);
  expect((await record(t, id))?.overlay.map((op) => op.op)).toEqual(['insert', 'remove']);
});

test('restart stores the step on the record, and a pending migration that inserts before it leaves it on that step', async () => {
  const t = setup();
  const id = await start(t);
  await downloadDone(t, id); // release 0: grab, downloadDone, importFiles, prepare, publish
  expect(await status(t, id)).toEqual(completed);
  const [, , , prepare] = await t.run(async (ctx) => (await manager.listSteps(ctx, id)).page.map((s) => s.stepId));
  deploy('r1'); // its migration inserts notify after grab, so prepare moves from 3 to 4

  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id, { from: 3, startAsync: true }));
  expect((await record(t, id))?.restart).toBe(prepare);
  await settle(t);
  expect(ran).toEqual(['prepare', 'publish']);
  expect(await status(t, id)).toEqual(completed);
  const saved = await record(t, id);
  expect(saved?.restart).toBeUndefined();
  expect(saved?.applied).toEqual(['notify-after-grab']);

  // Without from, nothing is removed; a step a restart stored and didn't get to is cleared.
  await t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.restart, { workflowId: id, workflow: 'flows:pipeline', from: prepare! }));
  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id));
  await settle(t);
  expect(ran).toEqual([]);
  expect((await record(t, id))?.restart).toBeUndefined();
});

test('restart throws for a running run, and points a paused one to restartFrom', async () => {
  const t = setup();
  const id = await start(t);
  await expect(t.run((ctx) => manager.restart(ctx, id, { from: 0 }))).rejects.toThrow(`restart: workflow ${id} is still running.`);
  deploy('unguarded');
  await downloadDone(t, id);
  await expect(t.run((ctx) => manager.restart(ctx, id, { from: 0 }))).rejects.toThrow('It is paused: use restartFrom.');
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

test('the manager needs onPause, or onPause: null to opt out explicitly', () => {
  const options = { migrationsComponent: components.workflowMigrations };
  expect(() => new WorkflowManager(components.workflow, options as never)).toThrow('pass onPause');
  expect(() => new WorkflowManager(components.workflow, { ...options, onPause: null })).not.toThrow();
});

test('migration ids are checked when the workflow is defined', () => {
  expect(() => release({}, [m1, migration('notify-after-grab', () => {})])).toThrow('the id "notify-after-grab" is listed twice');
  expect(() => migration('', () => {})).toThrow('non-empty string');
});
