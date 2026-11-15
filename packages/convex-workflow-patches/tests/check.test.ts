import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { evaluate, type RunInput } from '../src/check.ts';
import { type DeclaredPatches, type PatchesComponent, type WorkflowComponent, type WorkflowId, WorkflowManager } from '../src/index.ts';
import patchesTest, { simulateDeploy } from '../src/test.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowPatches: PatchesComponent };
const manager = new WorkflowManager(components.workflow, { patches: components.workflowPatches, declared: { 'checked:pipeline': ['notify'] } });
type Ref = FunctionReference<'mutation', 'internal', { args: Record<string, never> }, WorkflowId>;
const pipelineRef = anyApi.checked!.pipeline as Ref;
const step = (name: string) => anyApi.checked![name]!;
const noop = internalMutationGeneric({ args: {}, handler: async () => null });

// grab -> (notify) -> wait for "first" -> import -> wait for "second" -> publish
const functions = {
  grab: noop,
  notify: noop,
  importFiles: noop,
  publish: noop,
  pipeline: manager.define({
    args: {},
    handler: async (s): Promise<void> => {
      await s.runMutation(step('grab'), {});
      if (s.patched('notify')) await s.runMutation(step('notify'), {});
      await s.awaitEvent({ name: 'first' });
      await s.runMutation(step('importFiles'), {});
      await s.awaitEvent({ name: 'second' });
      await s.runMutation(step('publish'), {});
    },
  }),
};

function setup() {
  const t = convexTest(defineSchema({}), {
    './_generated/api.ts': async () => ({}),
    './checked.ts': async () => functions,
  });
  patchesTest.register(t);
  return t;
}
type T = ReturnType<typeof setup>;

const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
async function start(t: T) {
  const id = await t.run((ctx) => manager.start(ctx, pipelineRef, {}));
  await settle(t);
  return id;
}
async function send(t: T, workflowId: WorkflowId, name: 'first' | 'second') {
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name }));
  await settle(t);
}

/** What `convex-workflow-patches check` computes, from the same component queries. */
const check = (t: T, declared: DeclaredPatches) =>
  t.run(async (ctx) => {
    const page = await ctx.runQuery(components.workflow.workflow.list, { order: 'asc', paginationOpts: { cursor: null, numItems: 100 } });
    const ids = page.page.filter((run) => run.runResult === undefined).map((run) => run.workflowId);
    const running: RunInput[] = await ctx.runQuery(components.workflowPatches.runs.lookup, { workflowIds: ids });
    const deployed = Object.fromEntries((await ctx.runQuery(components.workflowPatches.runs.deployed, {})).map((r) => [r.workflow, r.declared]));
    return evaluate(declared, deployed, running);
  });
const removingNotify = { 'checked:pipeline': [] };

beforeEach(() => {
  vi.useFakeTimers();
  simulateDeploy();
});
afterEach(() => vi.useRealTimers());

test('removing a patch is blocked by a run that skipped it, not by one that took it', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] }); // release 1
  const skipped = await start(t);
  simulateDeploy(); // release 2
  await start(t); // takes notify
  await send(t, skipped, 'first'); // replays past notify without it

  expect(await check(t, removingNotify)).toEqual({
    removed: { 'checked:pipeline': ['notify'] },
    blockers: [{ workflowId: skipped, workflow: 'checked:pipeline', patchId: 'notify', reason: 'skipped' }],
  });
});

test("removing a patch is blocked by a run that hasn't run since before it shipped", async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] });
  const waiting = await start(t); // passed the notify point on release 1, waits for "first"
  simulateDeploy();
  await start(t); // release 2 runs, so the deployment records what it declares

  expect((await check(t, removingNotify)).blockers).toEqual([{ workflowId: waiting, workflow: 'checked:pipeline', patchId: 'notify', reason: 'waiting' }]);
});

test('finished runs and releases that remove nothing pass', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] });
  const old = await start(t);
  simulateDeploy();
  await start(t);
  await send(t, old, 'first');
  await send(t, old, 'second'); // finished

  expect((await check(t, removingNotify)).blockers).toEqual([]);
  expect(await check(t, { 'checked:pipeline': ['notify'] })).toEqual({ removed: {}, blockers: [] });
});

test('a patch the deployed release already removed is not removed again', async () => {
  const t = setup();
  await start(t); // release 2: knows notify
  // Release 3 dropped notify and has run since, so the deployment records no patches.
  simulateDeploy({ without: ['notify'] });
  await start(t);

  expect(await check(t, removingNotify)).toEqual({ removed: {}, blockers: [] });
});
