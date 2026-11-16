// Child workflows, and restarting canceled runs, on convex-test. As in
// migrations.test.ts, `deploy(name)` swaps the registered functions.
import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, createFunctionHandle, defineSchema, type FunctionReference, internalMutationGeneric, queryGeneric } from 'convex/server';
import { v } from 'convex/values';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { FORGET_BATCH } from '../src/component/schema.ts';
import { migration, type MigrationsComponent, type WorkflowComponent, type WorkflowCtx, type WorkflowId, WorkflowManager } from '../src/index.ts';
import migrationsTest from '../src/test.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowMigrations: MigrationsComponent };
const manager = new WorkflowManager(components.workflow, { migrationsComponent: components.workflowMigrations, onPause: null });

type Ref = FunctionReference<'mutation', 'internal', { args: Record<string, unknown> }, WorkflowId>;
const flows = anyApi.flows!;

const ran: string[] = [];
const stepFn = (name: string) =>
  internalMutationGeneric({
    handler: async (_ctx, args: Record<string, unknown>) => {
      ran.push(Object.keys(args).length > 0 ? `${name} ${JSON.stringify(args)}` : name);
      return null;
    },
  });
// A migration that changes nothing, so the applied ids show which list a record has.
const marker = migration('marker', () => {});
const channelArg = migration('channel-arg', (h) => h.updateWorkflowArgs((args) => ({ ...args, channel: 'default' })));
/** What upstream's `journal.load` returns for runs a test makes up: entries without a kind, as older upstream versions wrote them, and child workflows. */
const journals: Record<string, { step: { name: string; args: object; inProgress: boolean; kind?: string; workflowId?: string } }[]> = {};

const releases = {
  // The parent runs a child, which runs a grandchild; each waits for an event.
  parent: manager.define({
    args: {},
    migrations: [marker],
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.grab, {});
      await step.runWorkflow(flows.child, {});
      await step.runMutation(flows.publish, {});
    },
  }),
  child: manager.define({
    args: {},
    migrations: [marker],
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.fetch, {});
      await step.awaitEvent({ name: 'childDone' });
      await step.runWorkflow(flows.grandchild, {});
    },
  }),
  // The child's next release, without the migration for the step it adds.
  childUnguarded: manager.define({
    args: {},
    migrations: [marker],
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.fetch, {});
      await step.runMutation(flows.notify, {});
      await step.awaitEvent({ name: 'childDone' });
      await step.runWorkflow(flows.grandchild, {});
    },
  }),
  grandchild: manager.define({
    args: {},
    migrations: [marker],
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.leaf, {});
    },
  }),
  // Runs a child that finishes at once, then waits for the download.
  childThenWait: manager.define({
    args: {},
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runWorkflow(flows.grandchild, {});
      await step.awaitEvent({ name: 'downloadDone' });
      await step.runMutation(flows.publish, {});
    },
  }),
  // A pipeline that waits for the download, then, from release 1 on, runs a child before it.
  waits: manager.define({
    args: {},
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.grab, {});
      await step.awaitEvent({ name: 'downloadDone' });
      await step.runMutation(flows.publish, {});
    },
  }),
  // Runs a child that publishes to a channel, from its release 4 on.
  batch: manager.define({
    args: {},
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runWorkflow(flows.kid, {});
    },
  }),
  kid: manager.define({
    args: {},
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.publish, {});
    },
  }),
  kidWithChannel: manager.define({
    args: { channel: v.string() },
    migrations: [channelArg],
    handler: async (step: WorkflowCtx, { channel }): Promise<void> => {
      await step.runMutation(flows.publish, { channel });
    },
  }),
  kidUnguarded: manager.define({
    args: { channel: v.string() },
    handler: async (step: WorkflowCtx, { channel }): Promise<void> => {
      await step.runMutation(flows.publish, { channel });
    },
  }),
  // Runs many children at once, which finish at once.
  fanOut: manager.define({
    args: { children: v.number() },
    handler: async (step: WorkflowCtx, { children }): Promise<void> => {
      await Promise.all(Array.from({ length: children }, () => step.runWorkflow(flows.twig, {})));
    },
  }),
  twig: manager.define({ args: {}, handler: async (): Promise<void> => {} }),
  waitsWithChild: manager.define({
    args: {},
    migrations: [migration('child-after-grab', (h) => h.insertAfter(flows.grab, { workflow: flows.child as Ref }, { result: null as never }))],
    handler: async (step: WorkflowCtx): Promise<void> => {
      await step.runMutation(flows.grab, {});
      await step.runWorkflow(flows.child, {});
      await step.awaitEvent({ name: 'downloadDone' });
      await step.runMutation(flows.publish, {});
    },
  }),
};

const functions: Record<string, unknown> = {
  grab: stepFn('grab'),
  fetch: stepFn('fetch'),
  notify: stepFn('notify'),
  leaf: stepFn('leaf'),
  publish: stepFn('publish'),
  parent: releases.parent,
  child: releases.child,
  grandchild: releases.grandchild,
  childThenWait: releases.childThenWait,
  waits: releases.waits,
  batch: releases.batch,
  kid: releases.kid,
  fanOut: releases.fanOut,
  twig: releases.twig,
  journal: queryGeneric({
    args: { workflowId: v.string() },
    handler: async (_ctx, { workflowId }) => {
      const journalEntries = journals[workflowId];
      if (!journalEntries) throw new Error(`Workflow not found: ${workflowId}`);
      return { journalEntries };
    },
  }),
};
const deploy = (name: 'child' | 'waits' | 'kid', release: keyof typeof releases) => void (functions[name] = releases[release]);

/** With `transactionLimits`, convex-test enforces Convex's per-transaction limits, with these lowered. */
function setup(transactionLimits?: { documentsRead: number }) {
  const modules = { './_generated/api.ts': async () => ({}), './flows.ts': async () => functions };
  const t = convexTest({ schema: defineSchema({}), modules, ...(transactionLimits ? { transactionLimits } : {}) });
  migrationsTest.register(t);
  return t;
}
type T = ReturnType<typeof setup>;

async function settle(t: T, ms = 30_000) {
  for (let elapsed = 0; elapsed < ms; elapsed += 250) {
    await t.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(250);
  }
  await t.finishInProgressScheduledFunctions();
}
const status = (t: T, workflowId: WorkflowId) => t.run((ctx) => manager.status(ctx, workflowId));
const record = (t: T, workflowId: string) => t.run((ctx) => ctx.runQuery(components.workflowMigrations.runs.load, { workflowId }));
const paused = async (t: T, workflowId: string) => (await t.run((ctx) => manager.paused(ctx))).page.find((run) => run.workflowId === workflowId);
/** The child workflow a run's journal started at its `workflow` step. */
const childOf = async (t: T, workflowId: WorkflowId) =>
  (await t.run((ctx) => manager.listSteps(ctx, workflowId))).page.find((step) => step.kind === 'workflow')?.nestedWorkflowId;
const send = async (t: T, workflowId: WorkflowId, name: string) => {
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name }));
  await settle(t);
};

beforeEach(() => {
  vi.useFakeTimers();
  deploy('child', 'child');
  deploy('waits', 'waits');
  deploy('kid', 'kid');
  ran.length = 0;
  for (const id of Object.keys(journals)) delete journals[id];
});
afterEach(() => vi.useRealTimers());

async function startParent(t: T) {
  const parent = await t.run((ctx) => manager.start(ctx, flows.parent as Ref, {}));
  await settle(t);
  const child = (await childOf(t, parent))!;
  expect(child).toBeDefined();
  return { parent, child };
}

test("a paused child stalls its parent's runWorkflow step, and fail on the child releases the parent", async () => {
  const t = setup();
  const { parent, child } = await startParent(t);
  deploy('child', 'childUnguarded');
  await send(t, child, 'childDone');
  expect(await paused(t, child)).toMatchObject({ workflow: 'flows:child', reason: 'mismatch', step: 1 });
  expect(await status(t, parent)).toMatchObject({ type: 'inProgress' });
  await t.run((ctx) => manager.fail(ctx, child));
  await settle(t);
  const result = await status(t, parent);
  expect(result.type === 'failed' && result.error).toContain('Paused (mismatch): Journal entry mismatch at step 1');
  expect(ran).toEqual(['grab', 'fetch']);
});

test("cancelling the parent cancels the child past the manager: the child's pause ends at its next retry", async () => {
  const t = setup();
  const { parent, child } = await startParent(t);
  deploy('child', 'childUnguarded');
  await send(t, child, 'childDone');
  await t.run((ctx) => manager.cancel(ctx, parent));
  await settle(t, 1_000);
  expect(await status(t, child)).toEqual({ type: 'canceled' });
  expect(await paused(t, child)).toMatchObject({ attempts: 1 });
  await settle(t, 73_000);
  expect(await paused(t, child)).toBeUndefined();
});

test("cleaning up a parent deletes its children's and grandchildren's records with its own", async () => {
  const t = setup();
  const { parent, child } = await startParent(t);
  await send(t, child, 'childDone');
  expect(await status(t, parent)).toEqual({ type: 'completed', result: null });
  const grandchild = (await childOf(t, child))!;
  for (const id of [parent, child, grandchild]) expect((await record(t, id))?.applied).toEqual(['marker']);
  // Each child's record is linked to the run whose runWorkflow step started it.
  expect(await record(t, child)).toMatchObject({ origin: 'child', parent });
  expect(await record(t, grandchild)).toMatchObject({ origin: 'child', parent: child });
  expect(await t.run((ctx) => manager.cleanup(ctx, parent))).toBe(true);
  expect(await record(t, parent)).toBeNull();
  // The descendants' records go in scheduled batches; upstream deletes the children too, through its workpool.
  await settle(t);
  for (const id of [child, grandchild]) expect(await record(t, id)).toBeNull();
  await expect(status(t, grandchild)).rejects.toThrow('Workflow not found');
});

test('a queued child gets a record linked to its parent, and its args pick its migrations at its first handler run', async () => {
  const t = setup();
  // Started inline: the parent's handler run creates the child, which waits in upstream's workpool.
  const parent = await t.run((ctx) => manager.start(ctx, flows.batch as Ref, {}));
  const child = (await childOf(t, parent))!;
  const created = await record(t, child);
  expect(created).toMatchObject({ workflow: 'flows:kid', origin: 'child', parent, live: true });
  // Its parent's code doesn't know the child's migrations.
  expect(created?.applied).toBeUndefined();
  // The child's release 4 lands before it first runs: its args, from release 0, lack the channel.
  deploy('kid', 'kidWithChannel');
  await settle(t);
  expect(await status(t, child)).toEqual({ type: 'completed', result: null });
  expect(await status(t, parent)).toEqual({ type: 'completed', result: null });
  expect(ran).toEqual(['publish {"channel":"default"}']);
  expect(await record(t, child)).toMatchObject({ applied: ['channel-arg'], live: false, parent });
});

test('a queued child whose args no migration fixes pauses with args instead of failing; one whose args pass keeps them', async () => {
  const t = setup();
  const parent = await t.run((ctx) => manager.start(ctx, flows.batch as Ref, {}));
  const child = (await childOf(t, parent))!;
  deploy('kid', 'kidUnguarded');
  await settle(t);
  expect(await paused(t, child)).toMatchObject({ reason: 'args' });
  expect(await status(t, parent)).toMatchObject({ type: 'inProgress' });
  // With the migration, it resumes; a child started on this release, whose args pass, starts with every id applied.
  deploy('kid', 'kidWithChannel');
  expect(await t.run((ctx) => manager.resume(ctx, child))).toBe(true);
  await settle(t);
  expect(await status(t, parent)).toEqual({ type: 'completed', result: null });
  const fresh = await t.run((ctx) => manager.start(ctx, flows.kid as Ref, { channel: 'main' }));
  await settle(t);
  expect(await record(t, fresh)).toMatchObject({ applied: ['channel-arg'], overlay: [] });
  expect(ran).toEqual(['publish {"channel":"default"}', 'publish {"channel":"main"}']);
});

test('cleanup of a fan-out parent deletes its children’s records in batches, within the transaction limits', async () => {
  const t = setup();
  const parent = await t.run((ctx) => manager.start(ctx, flows.fanOut as Ref, { children: 30 }));
  await settle(t);
  expect(await status(t, parent)).toEqual({ type: 'completed', result: null });
  const children = (await t.run((ctx) => manager.listSteps(ctx, parent, { paginationOpts: { numItems: 100, cursor: null } }))).page.map(
    (step) => (step as { nestedWorkflowId: string }).nestedWorkflowId,
  );
  expect(children).toHaveLength(30);
  for (const id of children) expect(await record(t, id)).toMatchObject({ parent });
  expect(await t.run((ctx) => manager.cleanup(ctx, parent))).toBe(true);
  await settle(t);
  for (const id of [parent, ...children]) expect(await record(t, id)).toBeNull();

  // Far more children than a transaction can read, linked as runWorkflow steps link them, with a grandchild each.
  const limited = setup({ documentsRead: 1_000 });
  const ids = Array.from({ length: 1_200 }, (_, i) => `c${i}`);
  for (let i = 0; i < ids.length; i += FORGET_BATCH) {
    const batch = ids.slice(i, i + FORGET_BATCH);
    await limited.run(async (ctx) => {
      await ctx.runMutation(components.workflowMigrations.runs.children, {
        parent: 'p',
        children: batch.map((workflowId) => ({ workflowId, workflow: 'flows:twig' })),
      });
      for (const id of batch)
        await ctx.runMutation(components.workflowMigrations.runs.children, { parent: id, children: [{ workflowId: `${id}g`, workflow: 'flows:twig' }] });
    });
  }
  await limited.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.forget, { workflowIds: ['p'] }));
  await settle(limited, 5_000);
  for (const id of ['c0', 'c1199', 'c0g', 'c1199g', 'c600g']) expect(await record(limited, id)).toBeNull();
});

test('a run from before adoption has no links: its children come from its journal, read raw, entries without a kind included', async () => {
  const t = setup();
  // A root without a record, whose child has a record (its first handler run was after adoption), and a grandchild under that.
  journals.root = [
    { step: { name: 'flows:old', args: {}, inProgress: false } },
    { step: { name: 'flows:child', args: {}, inProgress: false, kind: 'workflow', workflowId: 'c' } },
  ];
  journals.c = [{ step: { name: 'flows:grandchild', args: {}, inProgress: false, kind: 'workflow', workflowId: 'g' } }];
  const pause = { workflow: 'flows:child', reason: 'mismatch' as const, detail: 'x', appliedCount: 0, handle: 'h', generationNumber: 0 };
  await t.run(async (ctx) => {
    await ctx.runMutation(components.workflowMigrations.runs.pause, { workflowId: 'c', ...pause });
    await ctx.runMutation(components.workflowMigrations.runs.save, { workflowId: 'g', workflow: 'flows:grandchild', applied: [], overlay: [], done: true });
    // A child the journal names that's gone: nothing to read.
    journals.root!.push({ step: { name: 'flows:child', args: {}, inProgress: false, kind: 'workflow', workflowId: 'gone' } });
  });
  expect(await record(t, 'c')).toMatchObject({ origin: 'adopted' });
  const journal = await t.run(() => createFunctionHandle(flows.journal));
  await t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.forget, { workflowIds: ['root'], journal }));
  await settle(t, 1_000);
  for (const id of ['c', 'g']) expect(await record(t, id)).toBeNull();
  expect(await paused(t, 'c')).toBeUndefined();
});

test('forget takes at most a batch of runs per call', async () => {
  const t = setup();
  const workflowIds = Array.from({ length: FORGET_BATCH + 1 }, (_, i) => `w${i}`);
  await expect(t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.forget, { workflowIds }))).rejects.toThrow(
    `at most ${FORGET_BATCH} runs per call`,
  );
});

test("cleanup of a workflow that's already gone deletes its record; of an unfinished one, nothing", async () => {
  const t = setup();
  const { parent, child } = await startParent(t);
  expect(await t.run((ctx) => manager.cleanup(ctx, parent))).toBe(false);
  expect(await record(t, parent)).not.toBeNull();
  expect(await record(t, child)).not.toBeNull();
  // As upstream's cleanup of a parent deletes a child: past the manager.
  await t.run((ctx) => ctx.runMutation(components.workflow.workflow.cleanup, { workflowId: child, force: true }));
  expect(await record(t, child)).not.toBeNull();
  expect(await t.run((ctx) => manager.cleanup(ctx, child))).toBe(false);
  expect(await record(t, child)).toBeNull();
});

test('a stand-in of kind workflow resolves the call without starting the child', async () => {
  const t = setup();
  const id = await t.run((ctx) => manager.start(ctx, flows.waits as Ref, {}));
  await settle(t);
  deploy('waits', 'waitsWithChild');
  await send(t, id, 'downloadDone');
  expect(await status(t, id)).toEqual({ type: 'completed', result: null });
  expect(ran).toEqual(['grab', 'publish']);
  expect(await childOf(t, id)).toBeUndefined();
  expect((await record(t, id))?.overlay).toMatchObject([{ op: 'insert', kind: 'workflow', name: 'flows:child' }]);
});

test('a canceled run waiting on an event restarts: upstream deletes the wait, and the run waits again', async () => {
  const t = setup();
  const id = await t.run((ctx) => manager.start(ctx, flows.waits as Ref, {}));
  await settle(t);
  await t.run((ctx) => manager.cancel(ctx, id));
  expect(await status(t, id)).toEqual({ type: 'canceled' });
  await t.run((ctx) => manager.restart(ctx, id));
  await settle(t);
  expect(await status(t, id)).toMatchObject({ type: 'inProgress' });
  await send(t, id, 'downloadDone');
  expect(await status(t, id)).toEqual({ type: 'completed', result: null });
  expect(ran).toEqual(['grab', 'publish']);
  expect((await t.run((ctx) => manager.listSteps(ctx, id))).page.map((step) => step.name)).toEqual(['flows:grab', 'downloadDone', 'flows:publish']);

  // With from, at or before the wait: upstream deletes from there.
  ran.length = 0;
  const again = await t.run((ctx) => manager.start(ctx, flows.waits as Ref, {}));
  await settle(t);
  await t.run((ctx) => manager.cancel(ctx, again));
  await t.run((ctx) => manager.restart(ctx, again, { from: 0 }));
  await settle(t);
  await send(t, again, 'downloadDone');
  expect(await status(t, again)).toEqual({ type: 'completed', result: null });
  expect(ran).toEqual(['grab', 'grab', 'publish']);
  await expect(t.run((ctx) => manager.restart(ctx, again, { from: 3 }))).rejects.toThrow('has 3 steps, so from must be below 3, got 3');
});

test("restarting a canceled run from before its child deletes the child's record, as upstream deletes the child", async () => {
  const t = setup();
  const id = await t.run((ctx) => manager.start(ctx, flows.childThenWait as Ref, {}));
  await settle(t);
  const child = (await childOf(t, id))!;
  expect(await status(t, child)).toEqual({ type: 'completed', result: null });
  expect(await record(t, child)).not.toBeNull();
  await t.run((ctx) => manager.cancel(ctx, id));
  await t.run((ctx) => manager.restart(ctx, id, { from: 0 }));
  expect(await record(t, child)).toBeNull();
  await settle(t);
  await expect(status(t, child)).rejects.toThrow('Workflow not found');
  const next = (await childOf(t, id))!;
  expect(next).not.toBe(child);
  await send(t, id, 'downloadDone');
  expect(await status(t, id)).toEqual({ type: 'completed', result: null });
  expect(ran).toEqual(['leaf', 'leaf', 'publish']);
});
