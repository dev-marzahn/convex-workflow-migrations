// Child workflows, and restarting canceled runs, on convex-test. As in
// migrations.test.ts, `deploy(name)` swaps the registered functions.
import { convexTest } from 'convex-test';
import {
  anyApi,
  componentsGeneric,
  createFunctionHandle,
  defineSchema,
  defineTable,
  type FunctionReference,
  internalMutationGeneric,
  queryGeneric,
} from 'convex/server';
import { v } from 'convex/values';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { FORGET_BATCH, JOURNAL_READ } from '../src/component/schema.ts';
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
/** The made-up runs whose journals are too big to load whole: `journal.load` returns what fit, with `ok: false`. */
const tooBig = new Set<string>();
/** How many half-MiB documents of `blobs` the made-up `journal.load` of a run reads, so its journal takes that much of the read budget. */
const journalBlobs: Record<string, number> = {};
const BLOB = 'x'.repeat((1 << 19) - 100);

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
    handler: async (ctx, { workflowId }) => {
      const journalEntries = journals[workflowId];
      if (!journalEntries) throw new Error(`Workflow not found: ${workflowId}`);
      await ctx.db.query('blobs').take(journalBlobs[workflowId] ?? 0);
      return { journalEntries, ok: !tooBig.has(workflowId) };
    },
  }),
  // A cleanup from a mutation, in one transaction: forget, as the manager's cleanup calls it, then upstream's cleanup reading the
  // journal again, as much as a whole one.
  cleanupInMutation: internalMutationGeneric({
    args: { workflowId: v.string(), journal: v.string() },
    handler: async (ctx, { workflowId, journal }) => {
      await ctx.runMutation(components.workflowMigrations.runs.forget, { workflowIds: [workflowId], journal, reserve: JOURNAL_READ });
      await ctx.db.query('blobs').take(18);
    },
  }),
};
const deploy = (name: 'child' | 'waits' | 'kid', release: keyof typeof releases) => void (functions[name] = releases[release]);

/** With `transactionLimits`, convex-test enforces Convex's per-transaction limits, with these lowered if given. */
function setup(transactionLimits?: true | { documentsRead: number }) {
  const modules = { './_generated/api.ts': async () => ({}), './flows.ts': async () => functions };
  const schema = defineSchema({ blobs: defineTable({ data: v.string() }) });
  const t = convexTest({ schema, modules, ...(transactionLimits ? { transactionLimits } : {}) });
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
  for (const id of Object.keys(journalBlobs)) delete journalBlobs[id];
  tooBig.clear();
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
  // The manager's cancel marks the records of the children upstream canceled with it finished, so the CLI doesn't list them as running.
  expect(await record(t, child)).toMatchObject({ live: false });
  await settle(t, 73_000);
  expect(await paused(t, child)).toBeUndefined();
});

test('fail, cancel and restartFrom on a paused child that upstream canceled with its parent: fail and cancel end the pause, restartFrom throws', async () => {
  for (const method of ['fail', 'cancel'] as const) {
    const t = setup();
    deploy('child', 'child');
    const { parent, child } = await startParent(t);
    deploy('child', 'childUnguarded');
    await send(t, child, 'childDone');
    // Upstream cancels the child, past the manager: the child stays paused, with a generation that's gone.
    await t.run((ctx) => ctx.runMutation(components.workflow.workflow.cancel, { workflowId: parent }));
    await settle(t, 1_000);
    expect(await status(t, child)).toEqual({ type: 'canceled' });
    expect(await paused(t, child)).toMatchObject({ attempts: 1 });
    expect(await record(t, child)).toMatchObject({ live: true });
    // There's nothing to restart: it throws, and the pause stays.
    await expect(t.run((ctx) => manager.restartFrom(ctx, child, 0))).rejects.toThrow(
      `restartFrom: workflow ${child} isn't running in upstream's component any more (it finished, for example canceled with its parent, or was restarted, past the manager), so nothing was restarted.`,
    );
    expect(await paused(t, child)).toMatchObject({ attempts: 1 });
    // fail and cancel keep the run's result, and end the pause.
    await t.run((ctx) => manager[method](ctx, child));
    expect(await paused(t, child)).toBeUndefined();
    expect(await status(t, child)).toEqual({ type: 'canceled' });
    expect(await record(t, child)).toMatchObject({ live: false });
    // A finished run that isn't paused: upstream's cancel throws, as it would without this package.
    await expect(t.run((ctx) => manager.cancel(ctx, child))).rejects.toThrow('Workflow not running');
    await expect(t.run((ctx) => manager.fail(ctx, child))).rejects.toThrow("isn't paused");
  }
});

test("cancel marks finished the live records of the descendants upstream cancels, in batches; a child that finished on its own keeps its children's", async () => {
  // Far more children than a transaction can read, each with a grandchild, linked as runWorkflow steps link them.
  const t = setup({ documentsRead: 1_000 });
  const { runs } = components.workflowMigrations;
  const ids = Array.from({ length: 1_200 }, (_, i) => `c${i}`);
  for (let i = 0; i < ids.length; i += FORGET_BATCH) {
    const batch = ids.slice(i, i + FORGET_BATCH);
    await t.run(async (ctx) => {
      await ctx.runMutation(runs.children, { parent: 'p', children: batch.map((workflowId) => ({ workflowId, workflow: 'flows:twig' })) });
      for (const id of batch) await ctx.runMutation(runs.children, { parent: id, children: [{ workflowId: `${id}g`, workflow: 'flows:twig' }] });
    });
  }
  // c7 completed before the cancel: upstream doesn't cancel it, or its child.
  await t.run((ctx) => ctx.runMutation(runs.save, { workflowId: 'c7', workflow: 'flows:twig', applied: [], overlay: [], done: true }));
  await t.run((ctx) => ctx.runMutation(runs.end, { workflowId: 'p', canceled: true }));
  await settle(t, 5_000);
  for (const id of ['c0', 'c1199', 'c0g', 'c600g', 'c1199g']) expect(await record(t, id)).toMatchObject({ live: false });
  expect(await record(t, 'c7')).toMatchObject({ live: false });
  expect(await record(t, 'c7g')).toMatchObject({ live: true });
});

test("upstream's restart without from keeps a canceled run's wait running, so the run would block on it: restart works around that", async () => {
  // This documents upstream's behaviour, which WorkflowManager.restart works around by having upstream delete from that
  // entry. If upstream fixes its restart, this test fails: then the workaround can go.
  const t = setup();
  const id = await t.run((ctx) => manager.start(ctx, flows.waits as Ref, {}));
  await settle(t);
  const wait = (await t.run((ctx) => ctx.runQuery(components.workflow.workflow.getStatus, { workflowId: id }))).inProgress.map((entry) => entry._id);
  expect(wait).toHaveLength(1);
  await t.run((ctx) => ctx.runMutation(components.workflow.workflow.cancel, { workflowId: id }));
  await t.run((ctx) => ctx.runMutation(components.workflow.workflow.restart, { workflowId: id }));
  await settle(t);
  const after = await t.run((ctx) => ctx.runQuery(components.workflow.workflow.getStatus, { workflowId: id }));
  // Still the old wait, still running: the restarted run's handler runs return "blocked by" it.
  expect(after.inProgress.map((entry) => entry._id)).toEqual(wait);
  expect(after.workflow.runResult).toBeUndefined();
  expect(ran).toEqual(['grab']);
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

test('a journal too big to load whole names only the children in the part that loaded: forget deletes those, and says so', async () => {
  const t = setup();
  const { runs } = components.workflowMigrations;
  journals.root = [{ step: { name: 'flows:child', args: {}, inProgress: false, kind: 'workflow', workflowId: 'c' } }];
  tooBig.add('root');
  await t.run((ctx) => ctx.runMutation(runs.save, { workflowId: 'c', workflow: 'flows:child', applied: [], overlay: [], done: true }));
  const journal = await t.run(() => createFunctionHandle(flows.journal));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await t.run((ctx) => ctx.runMutation(runs.forget, { workflowIds: ['root'], journal }));
  await settle(t, 1_000);
  expect(warn.mock.calls.map(([message]) => String(message))).toContain(
    "Workflow root's journal is too big to load whole: the records of its child workflows past what loaded are left.",
  );
  warn.mockRestore();
  expect(await record(t, 'c')).toBeNull();
});

/**
 * Runs from before adoption, each with a journal that reads that many half-MiB documents and names one child, which has a record.
 * There are 18 documents: as much as upstream's `journal.load` reads at most.
 */
async function bigJournals(t: T, runs: Record<string, number>) {
  await t.run(async (ctx) => {
    for (let i = 0; i < 18; i++) await ctx.db.insert('blobs', { data: BLOB });
    for (const [id, blobs] of Object.entries(runs)) {
      journals[id] = [{ step: { name: 'flows:child', args: {}, inProgress: false, kind: 'workflow', workflowId: `${id}-child` } }];
      journalBlobs[id] = blobs;
      await ctx.runMutation(components.workflowMigrations.runs.save, {
        workflowId: `${id}-child`,
        workflow: 'flows:child',
        applied: [],
        overlay: [],
        done: true,
      });
    }
  });
}

test("forget reads a journal only with enough of the transaction's read budget left for a whole one: the next batch reads the rest", async () => {
  // Convex's 16 MiB read limit, enforced. Two journals near upstream's 8 MiB limit don't fit in one transaction.
  const t = setup(true);
  await bigJournals(t, { a: 15, b: 18 });
  const journal = await t.run(() => createFunctionHandle(flows.journal));
  await t.run((ctx) => ctx.runMutation(components.workflowMigrations.runs.forget, { workflowIds: ['a', 'b'], journal }));
  expect(await record(t, 'a-child')).not.toBeNull();
  await settle(t, 1_000);
  for (const id of ['a-child', 'b-child']) expect(await record(t, id)).toBeNull();
});

test('forget with reserve, as cleanup from a mutation calls it, leaves upstream’s cleanup its read budget: a journal too big for the rest names no children', async () => {
  const t = setup(true);
  await bigJournals(t, { big: 15, small: 2 });
  const journal = await t.run(() => createFunctionHandle(flows.journal));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const workflowId of ['big', 'small']) await t.mutation(flows.cleanupInMutation, { workflowId, journal });
  await settle(t, 1_000);
  expect(warn.mock.calls.map(([message]) => String(message)).filter((message) => message.startsWith('Workflow big'))).toEqual([
    expect.stringContaining(
      "Workflow big's journal is too big to read in the transaction that cleans it up, which upstream's cleanup reads it in too: the records of its child workflows from before adoption are left.",
    ),
  ]);
  warn.mockRestore();
  expect(await record(t, 'big-child')).not.toBeNull();
  expect(await record(t, 'small-child')).toBeNull();

  // The manager's cleanup passes it from a mutation, where upstream's cleanup follows in the same transaction; not from an action.
  for (const fromAction of [false, true]) {
    const id = await t.run((ctx) => manager.start(ctx, flows.twig as Ref, {}));
    await settle(t, 1_000);
    const forgets: unknown[] = [];
    // The ctx, with its runMutation calls of runs:forget, the only ones cleanup makes with a journal, recorded.
    const spied = <C extends object>(ctx: C): C =>
      Object.assign(Object.create(ctx) as C, {
        runMutation: (ref: unknown, args: unknown) => {
          if (typeof args === 'object' && args !== null && 'journal' in args) forgets.push(args);
          return (ctx as unknown as { runMutation: (ref: unknown, args: unknown) => unknown }).runMutation(ref, args);
        },
      });
    if (fromAction) await t.action((ctx) => manager.cleanup(spied(ctx), id));
    else await t.run((ctx) => manager.cleanup(spied(ctx), id));
    expect(forgets).toEqual([{ workflowIds: [id], journal: expect.any(String), ...(fromAction ? {} : { reserve: JOURNAL_READ }) }]);
  }
});

test("runs:cleanup, for a run whose workflow is gone, passes the journal handle on: its linked children's unlinked children go too", async () => {
  const t = setup();
  const { runs } = components.workflowMigrations;
  // A gone run with a record, a linked child from before adoption, and that child's unlinked child, named in its journal.
  journals.linked = [{ step: { name: 'flows:grandchild', args: {}, inProgress: false, kind: 'workflow', workflowId: 'unlinked' } }];
  await t.run(async (ctx) => {
    await ctx.runMutation(runs.save, { workflowId: 'gone', workflow: 'flows:parent', applied: [], overlay: [], done: false });
    await ctx.runMutation(runs.save, { workflowId: 'linked', workflow: 'flows:child', applied: [], overlay: [], done: false });
    await ctx.runMutation(runs.children, { parent: 'gone', children: [{ workflowId: 'linked', workflow: 'flows:child' }] });
    await ctx.runMutation(runs.save, { workflowId: 'unlinked', workflow: 'flows:grandchild', applied: [], overlay: [], done: true });
  });
  expect(await record(t, 'linked')).toMatchObject({ origin: 'adopted', parent: 'gone' });
  const journal = await t.run(() => createFunctionHandle(flows.journal));
  expect(await t.run((ctx) => ctx.runMutation(runs.cleanup, { workflowId: 'gone', journal }))).toBe(1);
  await settle(t, 1_000);
  for (const id of ['gone', 'linked', 'unlinked']) expect(await record(t, id)).toBeNull();
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
