import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { type PatchesComponent, type WorkflowComponent, type WorkflowId, WorkflowManager } from '../src/index.ts';
import patchesTest, { simulateDeploy } from '../src/test.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowPatches: PatchesComponent };
const manager = new WorkflowManager(components.workflow, { patches: components.workflowPatches });
type Ref = FunctionReference<'mutation', 'internal', { args: Record<string, never> }, WorkflowId>;
const pipelineRef = anyApi.drain!.pipeline as Ref;
const step = (name: string) => anyApi.drain![name]!;
const noop = internalMutationGeneric({ args: {}, handler: async () => null });

// grab -> (notify) -> wait -> (archive) -> publish
const functions = {
  grab: noop,
  notify: noop,
  archive: noop,
  publish: noop,
  pipeline: manager.define({
    args: {},
    handler: async (s): Promise<void> => {
      await s.runMutation(step('grab'), {});
      if (s.patched('notify')) await s.runMutation(step('notify'), {});
      await s.awaitEvent({ name: 'downloadDone' });
      if (s.patched('archive')) await s.runMutation(step('archive'), {});
      await s.runMutation(step('publish'), {});
    },
  }),
};

function setup() {
  const t = convexTest(defineSchema({}), {
    './_generated/api.ts': async () => ({}),
    './drain.ts': async () => functions,
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
async function downloadDone(t: T, workflowId: WorkflowId) {
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name: 'downloadDone' }));
  await settle(t);
}
const waiting = (t: T, patchId: string) =>
  t.run(async (ctx) => (await manager.runsWithoutPatch(ctx, pipelineRef, patchId, { cursor: null, numItems: 100 })).page);

beforeEach(() => {
  vi.useFakeTimers();
  simulateDeploy();
});
afterEach(() => vi.useRealTimers());

test('lists the running workflows that passed the patch point without the patch', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] });
  const old = await start(t);
  const oldDone = await start(t);
  await downloadDone(t, oldDone);
  simulateDeploy();
  await start(t); // passes the point with the patch

  // Only `old` still needs the branch without notify: `oldDone` finished, the third run has the patch.
  expect(await waiting(t, 'notify')).toEqual([old]);
});

test("lists a run that hasn't reached the patch point yet, since it has no marker either", async () => {
  const t = setup();
  const id = await start(t); // waits before the archive point
  expect(await waiting(t, 'archive')).toEqual([id]);
  await downloadDone(t, id);
  expect(await waiting(t, 'archive')).toEqual([]);
});

test('pages through every running workflow', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] });
  const ids = [await start(t), await start(t), await start(t)];
  const found: WorkflowId[] = [];
  let cursor: string | null = null;
  do {
    const page = await t.run((ctx) => manager.runsWithoutPatch(ctx, pipelineRef, 'notify', { cursor, numItems: 1 }));
    found.push(...page.page);
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  expect(found).toEqual(ids);
});
