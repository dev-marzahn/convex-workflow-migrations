// Runs on convex-test across simulated releases: `deploy(release)` swaps the
// function registered as flows:pipeline, as a deploy would.
import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { v } from 'convex/values';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

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
  r2: release({ notify: true, notifiedAt: true }, [m1, m2]),
  r3: release({ notify: true, notifiedAt: true, transcode: true }, [m1, m2, m3]),
  // Release 1's change without its migration.
  unguarded: release({ notify: true }, []),
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

function setup() {
  const t = convexTest(defineSchema({}), {
    './_generated/api.ts': async () => ({}),
    './flows.ts': async () => functions,
  });
  migrationsTest.register(t);
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
    format: 1,
  });
  await downloadDone(t, id);
  expect(ran).toEqual(['grab', 'notify', 'import {"notifiedAt":1234}', 'transcode', 'publish']);
  expect((await record(t, id))?.overlay).toEqual([]);
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

test("changed workflow args pause a run with history; updateWorkflowArgs resumes it; a new run's bad args still fail it", async () => {
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

  // A new run without the arg is refused when it starts, as upstream's is.
  deploy('channelUnguarded');
  await expect(start(t)).rejects.toThrow('Missing required field `channel`');
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
  // What `fail` from an action leaves behind if it dies after completing the run.
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
  await settle(t, 73_000);
  expect(await paused(t, id)).toBeUndefined();
  expect(await status(t, id)).toEqual({ type: 'failed', error: 'gave up' });
  expect(completions.map((c) => c.result.kind)).toEqual(['failed']);
});

test('an overlay over the size limit pauses the run, naming the migration, and saves nothing', async () => {
  const t = setup();
  const id = await start(t);
  deploy('huge');
  await downloadDone(t, id);
  const run = await paused(t, id);
  expect(run).toMatchObject({ reason: 'overlay' });
  expect(run?.detail).toMatch(/^The run's overlay would be \d+ KiB, over the 512 KiB limit\. Migration "huge-stand-in" added the most, \d+ KiB\.$/);
  expect((await record(t, id))?.overlay).toEqual([]);
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
  const warn = vi.spyOn(console, 'warn');
  await settle(t, 73_000);
  const run = await paused(t, id);
  expect(run).toMatchObject({ reason: 'error', attempts: 2 });
  expect(run?.detail).toContain('The workflow mutation threw: ');
  expect(run?.detail).toContain('boom');
  expect(warn.mock.calls.some(([message]) => String(message).startsWith(`Retrying paused workflow ${id} threw`))).toBe(true);
  warn.mockRestore();
  deploy('r1');
  await settle(t, 721_000);
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

test('resume retries now, says whether the run got past its pause, and throws for a run that is not paused', async () => {
  const t = setup();
  const id = await start(t);
  await expect(t.run((ctx) => manager.resume(ctx, id))).rejects.toThrow(`resume: workflow ${id} isn't paused.`);
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

test('resumeAll retries each paused run once, spaced out, though each retry pauses it again', async () => {
  const t = setup();
  const ids = [await start(t), await start(t), await start(t)];
  deploy('unguarded');
  for (const workflowId of ids) await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name: 'downloadDone' }));
  await settle(t, 10_000);
  const before = (await t.run((ctx) => manager.paused(ctx))).page;
  expect(before.map((run) => run.attempts)).toEqual([1, 1, 1]);
  // Jitter: runs that paused together don't retry together.
  expect(new Set(before.map((run) => run.nextAttemptAt - run.at)).size).toBeGreaterThan(1);

  // A page of one run per transaction, still on code that doesn't match.
  await t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.resumeAll, { numItems: 1 }));
  await settle(t, 5_000); // well before the scheduled retries
  const after = (await t.run((ctx) => manager.paused(ctx))).page;
  expect(after.map((run) => run.attempts)).toEqual([2, 2, 2]);
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
    ['threw', 3, 'mismatch'],
  ]);
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
  // Restarting from step 2 leaves the mismatch at 1 in place.
  await expect(t.run((ctx) => manager.restartFrom(ctx, id, 2))).rejects.toThrow('would pause it again (mismatch)');
  expect(await paused(t, id)).toMatchObject({ attempts: 1 });
  expect((await record(t, id))?.restart).toBeUndefined();

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
  await expect(t.run((ctx) => manager.restartFrom(ctx, id, 0))).rejects.toThrow('restartFrom: workflow');
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
  // The restarts hide the old steps, which stay in upstream's journal; the stand-in is removed.
  expect((await record(t, id))?.overlay.map((op) => op.op)).toEqual(['insert', 'truncate', 'truncate', 'remove']);
  await downloadDone(t, id);
  expect(ran).toEqual(['notify', 'import {"notifiedAt":1234}', 'transcode', 'publish']);
  expect((await record(t, id))?.applied).toHaveLength(3);

  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id, { from: flows.transcode })); // its last call, by reference
  await settle(t);
  expect(ran).toEqual(['transcode', 'publish']);
  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id, { from: 'downloadDone' })); // by name
  await settle(t);
  expect(ran).toEqual([]);
  expect((await record(t, id))?.restart).toBeUndefined();
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

test('migration ids are checked when the workflow is defined', () => {
  expect(() => release({}, [m1, migration('notify-after-grab', () => {})])).toThrow('the id "notify-after-grab" is listed twice');
  expect(() => migration('', () => {})).toThrow('non-empty string');
});
