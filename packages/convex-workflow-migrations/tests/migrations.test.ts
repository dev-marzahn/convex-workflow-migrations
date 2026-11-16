// Runs on convex-test across simulated releases: `deploy(name, release)`
// swaps the function registered as flows:<name>, as a deploy would.
import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { v } from 'convex/values';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import {
  type Migration,
  migration,
  type MigrationsComponent,
  type WorkflowComponent,
  type WorkflowCtx,
  type WorkflowId,
  WorkflowManager,
} from '../src/index.ts';
import migrationsTest from '../src/test.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowMigrations: MigrationsComponent };
const manager = new WorkflowManager(components.workflow, { migrationsComponent: components.workflowMigrations });

type Ref = FunctionReference<'mutation', 'internal', { args: Record<string, unknown> }, WorkflowId>;
const flows = anyApi.flows!;

// Every step records that it ran, with its args.
const ran: string[] = [];
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
};

const functions: Record<string, unknown> = {
  grab: stepFn('grab'),
  notify: stepFn('notify', { at: 1234 }),
  importFiles: stepFn('import'),
  prepare: stepFn('prepare'),
  transcode: stepFn('transcode'),
  publish: stepFn('publish'),
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

/** Runs scheduled functions for a while of fake time. */
async function settle(t: T) {
  for (let elapsed = 0; elapsed < 30_000; elapsed += 250) {
    await t.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(250);
  }
  await t.finishInProgressScheduledFunctions();
}
async function start(t: T, args: Record<string, unknown> = {}) {
  const id = await t.run((ctx) => manager.start(ctx, flows.pipeline as Ref, args));
  await settle(t);
  return id;
}
async function downloadDone(t: T, workflowId: WorkflowId) {
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name: 'downloadDone' }));
  await settle(t);
}
const completed = { type: 'completed', result: null };
const ALL = ['notify-after-grab', 'import-gets-notified-at', 'prepare-becomes-transcode'];
const status = (t: T, workflowId: WorkflowId) => t.run((ctx) => manager.status(ctx, workflowId));
const record = (t: T, workflowId: WorkflowId) => t.run((ctx) => ctx.runQuery(components.workflowMigrations.runs.load, { workflowId }));
const steps = (t: T, workflowId: WorkflowId) => t.run(async (ctx) => (await manager.listSteps(ctx, workflowId)).page.map((s) => s.name.replace('flows:', '')));

beforeEach(() => {
  vi.useFakeTimers();
  deploy('r0');
  ran.length = 0;
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

test.each([
  [
    'a change without its migration',
    'unguarded',
    [],
    'Journal entry mismatch at step 1 of the run\'s history, as its migrations leave it: the code calls {"args":{},"kind":"function","name":"flows:notify"}, the history has {"args":{},"kind":"event","name":"downloadDone"}',
  ],
  ['args that no migration fixes', 'channelUnguarded', [], "The workflow's args, as its migrations leave them, don't match its args validator: "],
  ['a migration that throws', 'broken', [], 'Migration "broken" threw: oops'],
  [
    'applied ids that are not a prefix of the list (a rollback)',
    'r1',
    ALL,
    'The run has migrations "notify-after-grab", "import-gets-notified-at", "prepare-becomes-transcode" applied, but this code lists "notify-after-grab".',
  ],
  [
    'a handler that throws on the history its migrations leave',
    'badStandIn',
    [],
    `The handler threw replaying the history as migrations "notify-after-grab", "import-gets-notified-at" leave it: TypeError: Cannot read properties of null (reading 'at')`,
  ],
] as const)('a run that cannot replay fails, as upstream does: %s', async (_, to, applied, error) => {
  const t = setup();
  if (applied.length > 0) deploy('r3');
  const id = await start(t);
  const before = await record(t, id);
  expect(before?.applied).toEqual(applied);
  deploy(to);
  await downloadDone(t, id);
  const result = await status(t, id);
  expect(result.type).toBe('failed');
  expect(result.type === 'failed' && result.error).toContain(error);
  // Nothing of the handler run was saved.
  expect(await record(t, id)).toEqual(before);
  expect(ran).toEqual(applied.length > 0 ? ['grab', 'notify'] : ['grab']);
});

test('a run that failed to replay recovers with restart, once the code has its migration', async () => {
  const t = setup();
  const id = await start(t);
  deploy('unguarded');
  await downloadDone(t, id);
  expect((await status(t, id)).type).toBe('failed');
  deploy('r1');
  await t.run((ctx) => manager.restart(ctx, id));
  await settle(t);
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'import', 'prepare', 'publish']);
});

test('a run whose handler threw on its migrated history recovers with restart, once the migration is fixed', async () => {
  const t = setup();
  const id = await start(t);
  deploy('badStandIn');
  await downloadDone(t, id);
  expect((await status(t, id)).type).toBe('failed');
  deploy('r2'); // the same ids, with the stand-in fixed
  await t.run((ctx) => manager.restart(ctx, id));
  await settle(t);
  expect(await status(t, id)).toEqual(completed);
  expect(ran).toEqual(['grab', 'import {"notifiedAt":null}', 'prepare', 'publish']);
  expect(await record(t, id)).toMatchObject({ applied: ['notify-after-grab', 'import-gets-notified-at'], overlay: [{ op: 'insert', result: { at: null } }] });
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

test('migration ids are checked when the workflow is defined', () => {
  expect(() => release({}, [m1, migration('notify-after-grab', () => {})])).toThrow('the id "notify-after-grab" is listed twice');
  expect(() => migration('', () => {})).toThrow('non-empty string');
});
