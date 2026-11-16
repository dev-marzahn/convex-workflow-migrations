// Runs on convex-test across simulated releases: `deploy(name, release)`
// swaps the function registered as flows:<name>, as a deploy would.
import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { v } from 'convex/values';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { JITTER, UNFINISHED } from '../src/component/runs.ts';
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
import { StepExecutor } from '../src/vendor/workflow/step.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowMigrations: MigrationsComponent };
const pauses: PauseInfo[] = [];
let onPauseThrows = false;
/** Set by a test: awaited in onPause, while the workflow mutation records the pause. */
let whilePausing: (() => Promise<void>) | undefined;
const manager = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  onPause: async (_ctx, info) => {
    pauses.push(info);
    await whilePausing?.();
    if (onPauseThrows) throw new Error('alerting is down');
  },
});

type Ref = FunctionReference<'mutation', 'internal', { args: Record<string, unknown> }, WorkflowId>;
const flows = anyApi.flows!;

// Every step records that it ran, with its args.
const ran: string[] = [];
const completions: string[] = [];
/** Set by a test: called as each step runs, after it's recorded in `ran`; it can deploy, or throw to fail the step. */
let duringStep: ((name: string) => void) | undefined;
const stepFn = (name: string, returns: unknown = null) =>
  internalMutationGeneric({
    handler: async (_ctx, args: Record<string, unknown>) => {
      ran.push(Object.keys(args).length > 0 ? `${name} ${JSON.stringify(args)}` : name);
      duringStep?.(name);
      return returns;
    },
  });

// Release 0: grab, wait, import, prepare, publish. Each later release changes it, with a migration.
const m1 = migration('notify-after-grab', (h) => h.insertAfter(flows.grab, flows.notify, { result: { at: null } }));
const m2 = migration('import-gets-notified-at', (h) =>
  h.updateArgs(flows.importFiles, (args) => ({ ...args, notifiedAt: (h.result(flows.notify) as { at: number | null } | undefined)?.at ?? null })),
);
const m3 = migration('prepare-becomes-transcode', (h) => h.rename(flows.prepare, flows.transcode));
const channelArg = migration('channel-arg', (h) => h.updateWorkflowArgs((args) => ({ ...args, channel: 'default' })));
/** Set by a test: what the racing release's second branch waits for before it calls a step past the history. */
let raceCall: Promise<void> | undefined;

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
// Publishes to a channel, which release 0 didn't take; optional, release 0's args still pass.
function withChannel(migrations: Migration[], optional = false) {
  return manager.define({
    args: { channel: optional ? v.optional(v.string()) : v.string() },
    migrations,
    handler: async (step: WorkflowCtx, { channel }): Promise<void> => {
      await step.runMutation(flows.grab, {});
      await step.awaitEvent({ name: 'downloadDone' });
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
  broken: release({ notify: true }, [
    migration('broken', () => {
      throw new Error('oops');
    }),
  ]),
  // The same migration, throwing something else.
  brokenOtherwise: release({ notify: true }, [
    migration('broken', () => {
      throw new Error('still broken');
    }),
  ]),
  // Release 2 with a stand-in whose result the handler can't read `at` of.
  badStandIn: release({ notify: true, notifiedAt: true }, [migration(m1.id, (h) => h.insertAfter(flows.grab, flows.notify, { result: null })), m2]),
  channel: withChannel([channelArg]),
  channelUnguarded: withChannel([]),
  optionalChannel: withChannel([channelArg], true),
  // Runs the pipeline as a child workflow, with release 0's args.
  parent: manager.define({
    args: {},
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runWorkflow(flows.pipeline, {});
    },
  }),
  // Code that stops after grab: shorter than the histories of runs past it.
  short: manager.define({ args: {}, handler: async (step: WorkflowCtx): Promise<void> => void (await step.runMutation(flows.grab, {})) }),
  // Release 1, then a Promise.all after the history: one branch throws, which pauses the run (rule 5), and the other calls a step past it.
  racing: manager.define({
    args: {},
    migrations: [m1],
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.grab, {});
      await step.runMutation(flows.notify, {});
      await step.awaitEvent({ name: 'downloadDone' });
      await Promise.all([
        Promise.reject(new Error('the files are not ready')),
        (async () => {
          await raceCall;
          await step.runMutation(flows.importFiles, {});
        })(),
      ]);
    },
  }),
  // Calls grab with huge args, which the history doesn't have.
  hugeArgs: manager.define({
    args: {},
    handler: async (step: WorkflowCtx): Promise<void> => void (await step.runMutation(flows.grab, { blob: 'x'.repeat(600_000) })),
  }),
};

const functions: Record<string, unknown> = {
  grab: stepFn('grab'),
  notify: stepFn('notify', { at: 1234 }),
  importFiles: stepFn('import'),
  prepare: stepFn('prepare'),
  transcode: stepFn('transcode'),
  publish: stepFn('publish'),
  onComplete: internalMutationGeneric({
    args: { workflowId: v.string(), result: v.any(), context: v.any() },
    handler: async (_ctx, { result }) => void completions.push(result.kind),
  }),
  pipeline: releases.r0,
  parent: releases.parent,
};
const deploy = (name: keyof typeof releases) => void (functions.pipeline = releases[name]);

function setup() {
  const t = convexTest(defineSchema({}), { './_generated/api.ts': async () => ({}), './flows.ts': async () => functions });
  migrationsTest.register(t);
  return t;
}
type T = ReturnType<typeof setup>;

/** Runs scheduled functions for `ms` of fake time. Paused runs retry after about a minute, so the default stays below that. */
async function settle(t: T, ms = 30_000) {
  for (let elapsed = 0; elapsed < ms; elapsed += 250) {
    await t.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(250);
  }
  await t.finishInProgressScheduledFunctions();
}
async function start(t: T, args: Record<string, unknown> = {}) {
  const id = await t.run((ctx) => manager.start(ctx, flows.pipeline as Ref, args, { onComplete: flows.onComplete, context: null }));
  await settle(t);
  return id;
}
async function downloadDone(t: T, workflowId: WorkflowId, error?: string) {
  await t.run((ctx) => manager.sendEvent(ctx, error === undefined ? { workflowId, name: 'downloadDone' } : { workflowId, name: 'downloadDone', error }));
  await settle(t);
}
/** Sends each run its event, then settles for less time than the first retry takes. */
async function downloadAll(t: T, workflowIds: WorkflowId[]) {
  for (const workflowId of workflowIds) await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name: 'downloadDone' }));
  await settle(t, 10_000);
}
const completed = { type: 'completed', result: null };
const ALL = ['notify-after-grab', 'import-gets-notified-at', 'prepare-becomes-transcode'];
const status = (t: T, workflowId: WorkflowId) => t.run((ctx) => manager.status(ctx, workflowId));
const record = (t: T, workflowId: WorkflowId) => t.run((ctx) => ctx.runQuery(components.workflowMigrations.runs.load, { workflowId }));
const steps = (t: T, workflowId: WorkflowId) => t.run(async (ctx) => (await manager.listSteps(ctx, workflowId)).page.map((s) => s.name.replace('flows:', '')));
const paused = async (t: T, workflowId: WorkflowId) => (await t.run((ctx) => manager.paused(ctx))).page.find((run) => run.workflowId === workflowId);
const resume = (t: T, workflowId: WorkflowId) => t.run((ctx) => manager.resume(ctx, workflowId));

beforeEach(() => {
  vi.useFakeTimers();
  deploy('r0');
  ran.length = 0;
  pauses.length = 0;
  completions.length = 0;
  onPauseThrows = false;
  whilePausing = undefined;
  raceCall = undefined;
  duringStep = undefined;
});
afterEach(() => vi.useRealTimers());

test('a run from release 0 replays on release 3, which lists the migrations of releases 1 to 3', async () => {
  const t = setup();
  const id = await start(t);
  expect(ran).toEqual(['grab']);
  expect(await record(t, id)).toEqual({ applied: [], overlay: [] });
  deploy('r3'); // releases 1 and 2 were never deployed
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual(completed);
  // notify is a stand-in, so it didn't run, and isn't in the journal; import got its null.
  expect(ran).toEqual(['grab', 'import {"notifiedAt":null}', 'transcode', 'publish']);
  expect(await steps(t, id)).toEqual(['grab', 'downloadDone', 'importFiles', 'transcode', 'publish']);
  const saved = await record(t, id);
  expect(saved?.applied).toEqual(ALL);
  expect(saved?.overlay.map((op) => op.op)).toEqual(['insert']);
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
  expect(await record(t, id)).toEqual({ applied: ALL, overlay: [] });
});

test('a queued run gets its record when it is created, so a release that changes its args before its first handler run migrates it', async () => {
  const t = setup();
  // Through the manager, and through the workflow mutation itself, as upstream's standalone start calls it.
  const ids = await t.run(async (ctx) => [
    await manager.start(ctx, flows.pipeline as Ref, {}, { startAsync: true }),
    (await ctx.runMutation(flows.pipeline as Ref, { args: {}, startAsync: true } as never)) as WorkflowId,
  ]);
  for (const id of ids) expect(await record(t, id)).toEqual({ applied: [], overlay: [] });
  expect(ran).toEqual([]);
  // The release that adds the channel lands before they first run: their args still pass, and its migration gives them one,
  // because the record says they're from before it.
  deploy('optionalChannel');
  await settle(t);
  for (const id of ids) {
    await downloadDone(t, id);
    expect(await status(t, id)).toEqual(completed);
    expect((await record(t, id))?.applied).toEqual(['channel-arg']);
  }
  expect(ran.filter((step) => step.startsWith('publish'))).toEqual(['publish {"channel":"default"}', 'publish {"channel":"default"}']);
});

test('a queued child has no record: at its first handler run, its args pick its migrations', async () => {
  const t = setup();
  // Started inline: the parent's handler run creates the child, which waits in upstream's workpool.
  const parent = await t.run((ctx) => manager.start(ctx, flows.parent as Ref, {}));
  const child = (await t.run((ctx) => manager.listSteps(ctx, parent))).page.find((step) => step.kind === 'workflow')!.nestedWorkflowId;
  expect(await record(t, child)).toBeNull();
  // The child's release with the channel lands before it first runs: its args, from release 0, lack one.
  deploy('channel');
  await settle(t);
  await downloadDone(t, child);
  expect(await status(t, parent)).toEqual(completed);
  expect(ran).toEqual(['grab', 'publish {"channel":"default"}']);
  expect((await record(t, child))?.applied).toEqual(['channel-arg']);
  // A child whose args pass is from the current code: nothing applies.
  const fresh = await start(t, { channel: 'main' });
  expect(await record(t, fresh)).toEqual({ applied: ['channel-arg'], overlay: [] });
});

test('a replay that does not match pauses the run instead of failing it, alerts once, and resumes at a retry once the code has its migration', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  expect(await status(t, id)).toEqual({ type: 'inProgress', running: [] });
  expect(completions).toEqual([]);
  const run = await paused(t, id);
  expect(run).toMatchObject({ workflow: 'flows:pipeline', reason: 'mismatch', step: 1, attempts: 1 });
  expect(run?.detail).toBe(
    'Journal entry mismatch at step 1 of the run\'s history, as its migrations leave it: the code calls {"args":{},"kind":"function","name":"flows:notify"}, the history has {"args":{},"kind":"event","name":"downloadDone"}',
  );
  // A minute, ±20%.
  expect(run!.nextAttemptAt - run!.at).toBeGreaterThanOrEqual(48_000);
  expect(run!.nextAttemptAt - run!.at).toBeLessThanOrEqual(72_000);
  expect(pauses).toEqual([{ workflowId: id, reason: 'mismatch', detail: run!.detail, step: 1, attempts: 1 }]);
  expect(await record(t, id)).toEqual({ applied: [], overlay: [], paused: true });

  // Retried with backoff; still the same code, so still paused, and no second alert.
  await settle(t, 73_000);
  const again = await paused(t, id);
  expect(again).toMatchObject({ attempts: 2, at: run!.at });
  expect(again!.lastError).toBeUndefined();
  // The next waits 10 minutes, ±20%.
  expect(again!.nextAttemptAt - run!.nextAttemptAt).toBeGreaterThanOrEqual(480_000);
  expect(again!.nextAttemptAt - run!.nextAttemptAt).toBeLessThan(720_250);
  expect(pauses).toHaveLength(1);

  // A release with the migration: the next retry resumes the run.
  deploy('r1');
  await settle(t, 721_000);
  expect(await paused(t, id)).toBeUndefined();
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'import', 'prepare', 'publish']);
  expect(completions).toEqual(['success']);
  expect(await record(t, id)).toMatchObject({ applied: ['notify-after-grab'] });
});

test.each([
  [
    'args that no migration fixes',
    'channelUnguarded',
    [],
    'args',
    "The workflow's args, as its migrations leave them, don't match its args validator: ",
    'channel',
  ],
  ['a migration that throws', 'broken', [], 'migration', 'Migration "broken" threw: oops', undefined],
  [
    'applied ids that are not a prefix of the list (a rollback)',
    'r1',
    ALL,
    'migrations',
    'The run has migrations "notify-after-grab", "import-gets-notified-at", "prepare-becomes-transcode" applied, but this code lists "notify-after-grab".',
    'r3',
  ],
  [
    // It reads notify's `at` after the wait, the last recorded step: the migrations that just applied are suspect (rule 5).
    'a handler that throws on the history its migrations leave',
    'badStandIn',
    [],
    'threw',
    `The handler threw after migrations "notify-after-grab" changed its history (rule 5: migrations edited the history in this handler run): Cannot read properties of null (reading 'at')`,
    'r2',
  ],
] as const)('a run that cannot replay pauses, saves nothing, and resume replays it once the code is fixed: %s', async (_, to, applied, reason, detail, fix) => {
  const t = setup();
  if (applied.length > 0) deploy('r3');
  const id = await start(t);
  const before = await record(t, id);
  expect(before?.applied).toEqual(applied);
  deploy(to);
  await downloadDone(t, id);
  expect(await status(t, id)).toMatchObject({ type: 'inProgress' });
  expect(await paused(t, id)).toMatchObject({ reason, detail: expect.stringContaining(detail) });
  // Nothing of the handler run was saved, and nothing new started.
  expect(await record(t, id)).toEqual({ ...before, paused: true });
  expect(ran).toEqual(applied.length > 0 ? ['grab', 'notify'] : ['grab']);
  if (!fix) return;
  deploy(fix);
  expect(await resume(t, id)).toBe(true);
  await settle(t);
  expect(await status(t, id)).toEqual(completed);
  expect(await paused(t, id)).toBeUndefined();
});

test('a handler that returns before the end of its history pauses the run', async () => {
  const t = setup();
  const id = await start(t);
  deploy('short');
  await downloadDone(t, id);
  expect(await paused(t, id)).toMatchObject({
    reason: 'mismatch',
    step: 1,
    detail: `Journal entry mismatch at step 1 of the run's history, as its migrations leave it: the code returned before it, the history has {"args":{},"kind":"event","name":"downloadDone"}`,
  });
  expect(await status(t, id)).toMatchObject({ type: 'inProgress' });
});

test('a handler run that pauses starts no step, though another branch calls one past the history while the pause is recorded', async () => {
  const t = setup();
  const id = await start(t);
  deploy('racing');
  // The second branch calls importFiles once the pause has been decided, while the workflow mutation awaits onPause.
  let pausing!: () => void;
  raceCall = new Promise<void>((resolve) => (pausing = resolve));
  whilePausing = async () => {
    pausing();
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  const startSteps = vi.spyOn(StepExecutor.prototype, 'startSteps');
  await downloadDone(t, id);
  expect(startSteps).not.toHaveBeenCalled();
  startSteps.mockRestore();
  expect(await paused(t, id)).toMatchObject({
    reason: 'threw',
    detail:
      'The handler threw after migrations "notify-after-grab" changed its history (rule 5: migrations edited the history in this handler run): the files are not ready',
  });
  expect(await steps(t, id)).toEqual(['grab', 'downloadDone']);
  expect(ran).toEqual(['grab']);
});

test('a step that fails in the handler run where a migration first applies fails the run: the handler passes the failure on', async () => {
  const t = setup();
  const id = await start(t);
  deploy('r1'); // inserts notify after grab, the next time the run replays
  await downloadDone(t, id, 'the download failed');
  const result = await status(t, id);
  expect(result.type === 'failed' && result.error).toContain('the download failed');
  expect([await paused(t, id), pauses, completions]).toEqual([undefined, [], ['failed']]);
  expect((await record(t, id))?.applied).toEqual(['notify-after-grab']);
});

test.each([
  // Release 3's import-gets-notified-at gives the failed import new args.
  ['importFiles', 'r1', 'import', ['grab', 'notify', 'import']],
  // Its prepare-becomes-transcode renames the failed prepare.
  ['prepare', 'r2', 'prepare', ['grab', 'notify', 'import {"notifiedAt":1234}', 'prepare']],
] as const)(
  'a run waiting on %s when release 3 deploys fails when that step fails, though a migration rewrote the step: the handler passes the failure on',
  async (_, from, failing, log) => {
    const t = setup();
    deploy(from);
    const id = await start(t);
    // Release 3 deploys while the step runs, and the step fails.
    duringStep = (name) => {
      if (name !== failing) return;
      deploy('r3');
      throw new Error('the step broke');
    };
    await downloadDone(t, id);
    const result = await status(t, id);
    expect(result.type === 'failed' && result.error).toContain('the step broke');
    expect([await paused(t, id), pauses, completions, ran]).toEqual([undefined, [], ['failed'], log]);
    expect((await record(t, id))?.applied).toEqual(ALL);
  },
);

test("a pause's detail is cut, so a huge argument can't make the pause too big to store", async () => {
  const t = setup();
  const id = await start(t);
  deploy('hugeArgs');
  await downloadDone(t, id);
  const run = await paused(t, id);
  expect(run).toMatchObject({ reason: 'mismatch', step: 0 });
  expect(run!.detail.length).toBeLessThan(DETAIL_LIMIT + 300);
  expect(run!.detail).toMatch(/: the code calls \{"args":\{"blob":"x+…, the history has \{"args":\{\},"kind":"function","name":"flows:grab"\}$/);
});

test('a retry is write-ahead: an attempt whose workflow mutation throws, or that dies, keeps the pause, and the next retry still arrives', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  const first = await paused(t, id);
  functions.pipeline = internalMutationGeneric({
    handler: async () => {
      throw new Error('boom');
    },
  });
  await settle(t, 73_000);
  // The attempt caught the throw: the pause it retried stays, with the error.
  expect(await paused(t, id)).toMatchObject({ reason: 'mismatch', step: 1, attempts: 2, at: first!.at, lastError: expect.stringContaining('boom') });
  // Now the attempt's whole transaction dies: here the warning it logs throws too, so nothing of it commits.
  const warn = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    if (String(message).startsWith('Retrying paused workflow')) throw new Error('the attempt ran out of time');
  });
  await settle(t, 721_000);
  // The retry counted it and scheduled the next one before the attempt started.
  const died = await paused(t, id);
  expect(died).toMatchObject({ attempts: 3, lastError: UNFINISHED });
  warn.mockRestore();
  // A release with the migration: the retry after that, an hour later, resumes the run.
  deploy('r1');
  vi.advanceTimersByTime(3_600_000 * (1 + JITTER));
  await settle(t);
  expect(await paused(t, id)).toBeUndefined();
  expect(await status(t, id)).toEqual(completed);
});

test('onPause is called again when the reason, the step or the detail changes, with the attempts; one that throws is logged', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  onPauseThrows = true;
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  await downloadDone(t, id);
  expect(await paused(t, id)).toMatchObject({ reason: 'mismatch', step: 1 });
  expect(logged.mock.calls.some((args) => args.join(' ').includes(`onPause threw for workflow ${id}`))).toBe(true);
  logged.mockRestore();
  expect(await resume(t, id)).toBe(false); // the same pause again: no alert
  expect(pauses.map((p) => [p.reason, p.step, p.attempts])).toEqual([['mismatch', 1, 1]]);
  deploy('hugeArgs'); // another step
  await resume(t, id);
  deploy('badStandIn'); // another reason and step
  await resume(t, id);
  deploy('broken'); // another reason, and still no step
  await resume(t, id);
  deploy('brokenOtherwise'); // the same reason, no step, another detail
  await resume(t, id);
  await resume(t, id); // the same detail again: no alert
  expect(pauses.map((p) => [p.reason, p.step, p.attempts])).toEqual([
    ['mismatch', 1, 1],
    ['mismatch', 0, 1],
    ['threw', undefined, 1],
    ['migration', undefined, 1],
    ['migration', undefined, 1],
  ]);
  expect(pauses.slice(-2).map((p) => p.detail)).toEqual(['Migration "broken" threw: oops', 'Migration "broken" threw: still broken']);
  expect(await status(t, id)).toMatchObject({ type: 'inProgress' });
});

test('resume retries now, says whether the run got past its pause, and throws for a run that is not paused', async () => {
  const t = setup();
  const id = await start(t);
  await expect(resume(t, id)).rejects.toThrow(`resume: workflow ${id} isn't paused.`);
  deploy('unguarded');
  await downloadDone(t, id);
  const before = await paused(t, id);
  expect(await resume(t, id)).toBe(false);
  // Paused again: its attempts and its scheduled retry stay.
  expect(await paused(t, id)).toEqual(before);
  deploy('r1');
  expect(await resume(t, id)).toBe(true);
  await settle(t);
  expect(await status(t, id)).toEqual(completed);
  // The retry the pause scheduled finds nothing to do.
  await settle(t, 700_000);
  expect(ran).toEqual(['grab', 'import', 'prepare', 'publish']);
});

test('resume returns false when the pause ends without a replay: upstream finished or canceled the run past the manager, or it is gone', async () => {
  const t = setup();
  const [finished, canceled, gone] = [await start(t), await start(t), await start(t)];
  deploy('unguarded');
  await downloadAll(t, [finished, canceled, gone]);
  await t.run(async (ctx) => {
    const { workflow } = await ctx.runQuery(components.workflow.workflow.getStatus, { workflowId: finished });
    const runResult = { kind: 'failed' as const, error: 'gave up' };
    await ctx.runMutation(components.workflow.workflow.complete, { workflowId: finished, generationNumber: workflow.generationNumber, runResult });
    // Canceling bumps the generation, so the workflow mutation returns at the generation check.
    await ctx.runMutation(components.workflow.workflow.cancel, { workflowId: canceled });
    await ctx.runMutation(components.workflow.workflow.cleanup, { workflowId: gone, force: true });
  });
  for (const id of [finished, canceled, gone]) {
    expect(await resume(t, id)).toBe(false);
    expect(await paused(t, id)).toBeUndefined();
  }
  expect([await status(t, finished), await status(t, canceled)]).toEqual([{ type: 'failed', error: 'gave up' }, { type: 'canceled' }]);
  expect([(await record(t, finished))?.applied, await record(t, gone)]).toEqual([[], null]);
});

test("fail completes a paused run as failed and ends its pause, in the caller's transaction", async () => {
  const t = setup();
  const [id, other] = [await start(t), await start(t)];
  deploy('unguarded');
  await downloadAll(t, [id, other]);
  // Something after it in the same mutation throws: neither the failure nor the end of the pause commits.
  const failThenThrow = t.run(async (ctx) => {
    await manager.fail(ctx, id);
    throw new Error('later in the same mutation');
  });
  await expect(failThenThrow).rejects.toThrow('later in the same mutation');
  completions.length = 0; // onComplete ran in the transaction that rolled back
  expect(await paused(t, id)).toMatchObject({ reason: 'mismatch' });
  await expect(t.action((ctx) => manager.fail(ctx as never, id))).rejects.toThrow("fail takes a mutation's ctx");
  await t.run((ctx) => manager.fail(ctx, id));
  expect(await status(t, id)).toEqual({ type: 'failed', error: expect.stringContaining('Paused (mismatch): Journal entry mismatch at step 1') });
  await t.run((ctx) => manager.fail(ctx, other, 'given up'));
  expect(await status(t, other)).toEqual({ type: 'failed', error: 'given up' });
  expect(completions).toEqual(['failed', 'failed']);
  expect([await paused(t, id), await paused(t, other)]).toEqual([undefined, undefined]);
  await expect(t.run((ctx) => manager.fail(ctx, id))).rejects.toThrow(`fail: workflow ${id} isn't paused.`);
  // The scheduled retries find nothing to do.
  await settle(t, 73_000);
  expect(completions).toHaveLength(2);
});

test('a paused run that upstream finished past the manager: its retry ends the pause, and fail only ends it', async () => {
  const t = setup();
  const [id, other] = [await start(t), await start(t)];
  deploy('unguarded');
  await downloadAll(t, [id, other]);
  for (const workflowId of [id, other]) {
    await t.run(async (ctx) => {
      const { workflow } = await ctx.runQuery(components.workflow.workflow.getStatus, { workflowId });
      const runResult = { kind: 'failed' as const, error: 'gave up' };
      await ctx.runMutation(components.workflow.workflow.complete, { workflowId, generationNumber: workflow.generationNumber, runResult });
    });
  }
  await t.run((ctx) => manager.fail(ctx, other));
  expect(await paused(t, other)).toBeUndefined();
  expect(await paused(t, id)).toMatchObject({ attempts: 1 });
  await settle(t, 73_000);
  expect(await paused(t, id)).toBeUndefined();
  for (const workflowId of [id, other]) expect(await status(t, workflowId)).toEqual({ type: 'failed', error: 'gave up' });
  expect(completions).toEqual(['failed', 'failed']);
});

test('cancel ends a paused run and its pause', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  await t.run((ctx) => manager.cancel(ctx, id));
  expect(await status(t, id)).toEqual({ type: 'canceled' });
  expect(await paused(t, id)).toBeUndefined();
  expect(completions).toEqual(['canceled']);
});

test('the record and pause of a paused run whose workflow is gone are deleted at its next retry', async () => {
  // Upstream deletes a child workflow, paused or not, when it cleans up its parent.
  const t = setup();
  const [gone, kept] = [await start(t), await start(t)];
  deploy('unguarded');
  await downloadAll(t, [gone, kept]);
  await t.run((ctx) => ctx.runMutation(components.workflow.workflow.cleanup, { workflowId: gone, force: true }));
  await settle(t, 73_000);
  expect([await record(t, gone), await paused(t, gone)]).toEqual([null, undefined]);
  expect(await paused(t, kept)).toMatchObject({ attempts: 2 });
  // Called directly, the workflow mutation of a gone workflow still fails as upstream's does.
  const retryGone = { workflowId: gone, generationNumber: 0 } as unknown as { args: Record<string, unknown> };
  await expect(t.mutation(flows.pipeline as Ref, retryGone)).rejects.toThrow('Workflow not found');
});

test('paused() pages, oldest pause first, and filters by workflow', async () => {
  const t = setup();
  const ids = [await start(t), await start(t)];
  deploy('unguarded');
  await downloadAll(t, ids);
  const first = await t.run((ctx) => manager.paused(ctx, { numItems: 1 }));
  expect([first.page.map((run) => run.workflowId), first.isDone]).toEqual([[ids[0]], false]);
  const next = await t.run((ctx) => manager.paused(ctx, { numItems: 1, cursor: first.continueCursor }));
  expect(next.page.map((run) => run.workflowId)).toEqual([ids[1]]);
  expect((await t.run((ctx) => manager.paused(ctx, { workflow: 'flows:pipeline' }))).page).toHaveLength(2);
  expect((await t.run((ctx) => manager.paused(ctx, { workflow: 'flows:other' }))).page).toEqual([]);
});

test('restart replays the whole history with its migrations; restart from a step refuses a history its migrations edited', async () => {
  const t = setup();
  const id = await start(t);
  deploy('r3');
  await downloadDone(t, id);
  expect((await record(t, id))?.overlay).toHaveLength(1);
  await expect(t.run((ctx) => manager.restart(ctx, id, { from: 2 }))).rejects.toThrow(
    `restart: workflow ${id}'s migrations edited its history, and restart({ from }) on such a run isn't supported yet.`,
  );
  ran.length = 0;
  await t.run((ctx) => manager.restart(ctx, id));
  await settle(t);
  expect([await status(t, id), ran]).toEqual([completed, []]);
  // Without edits, from passes through to upstream, which counts its journal.
  const fresh = await start(t);
  await downloadDone(t, fresh);
  await t.run((ctx) => manager.restart(ctx, fresh, { from: 'flows:transcode' }));
  await settle(t);
  expect(ran).toEqual(['grab', 'notify', 'import {"notifiedAt":1234}', 'transcode', 'publish', 'transcode', 'publish']);
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
