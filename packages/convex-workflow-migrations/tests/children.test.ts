// Child workflows, and restarting canceled runs, on convex-test. As in
// migrations.test.ts, `deploy(name)` swaps the registered functions.
import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { migration, type MigrationsComponent, type WorkflowComponent, type WorkflowCtx, type WorkflowId, WorkflowManager } from '../src/index.ts';
import migrationsTest from '../src/test.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowMigrations: MigrationsComponent };
const manager = new WorkflowManager(components.workflow, { migrationsComponent: components.workflowMigrations });

type Ref = FunctionReference<'mutation', 'internal', { args: Record<string, unknown> }, WorkflowId>;
const flows = anyApi.flows!;

const ran: string[] = [];
const stepFn = (name: string) =>
  internalMutationGeneric({
    handler: async () => {
      ran.push(name);
      return null;
    },
  });
// Gives every run a record: a run with nothing applied has none.
const marker = migration('marker', () => {});

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
};
const deploy = (name: 'child' | 'waits', release: keyof typeof releases) => void (functions[name] = releases[release]);

function setup() {
  const t = convexTest(defineSchema({}), { './_generated/api.ts': async () => ({}), './flows.ts': async () => functions });
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
  ran.length = 0;
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
  expect(await t.run((ctx) => manager.cleanup(ctx, parent))).toBe(true);
  for (const id of [parent, child, grandchild]) expect(await record(t, id)).toBeNull();
  // Upstream deletes the children too, through its workpool.
  await settle(t);
  await expect(status(t, grandchild)).rejects.toThrow('Workflow not found');
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
