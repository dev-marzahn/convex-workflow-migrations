import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { v } from 'convex/values';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { type PatchesComponent, type WorkflowComponent, type WorkflowCtx, type WorkflowId, WorkflowManager } from '../src/index.ts';
import patchesTest, { simulateDeploy } from '../src/test.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowPatches: PatchesComponent };
const manager = new WorkflowManager(components.workflow, { patches: components.workflowPatches });
type Ref = FunctionReference<'mutation', 'internal', { args: Record<string, never> }, WorkflowId>;
const ref = (name: string) => anyApi.flows![name] as Ref;
const step = (name: string) => anyApi.flows![name]!;

const noop = internalMutationGeneric({ args: {}, handler: async () => null });

// How the pipeline's notify step is written in the deployed code. `simulateDeploy`
// switches patches off; this switches what replaces them.
let notify: 'patched' | 'unguarded' | 'deprecated' = 'patched';

// grab -> (notify) -> wait -> import -> (prepare) -> publish
async function pipeline(s: WorkflowCtx): Promise<string[]> {
  const path: string[] = [];
  await s.runMutation(step('grab'), {});
  if (notify === 'deprecated') s.deprecatePatch('notify');
  if (notify !== 'patched' || s.patched('notify')) {
    await s.runMutation(step('notify'), {});
    path.push('notify');
  }
  await s.awaitEvent({ name: 'downloadDone' });
  await s.runMutation(step('importFiles'), {});
  if (s.patched('prepare')) {
    await s.runMutation(step('prepare'), {});
    path.push('prepare');
  }
  await s.runMutation(step('publish'), {});
  return path;
}

const returnsPath = { args: {}, returns: v.array(v.string()) };
const functions = {
  grab: noop,
  grab2: noop,
  notify: noop,
  importFiles: noop,
  prepare: noop,
  publish: noop,
  pipeline: manager.define({ ...returnsPath, handler: pipeline }),
  // One patch id checked on both sides of the wait.
  twoSites: manager.define({
    ...returnsPath,
    handler: async (s): Promise<string[]> => {
      const path: string[] = [];
      await s.runMutation(step('grab'), {});
      if (s.patched('format')) path.push('before');
      await s.awaitEvent({ name: 'downloadDone' });
      if (s.patched('format')) {
        await s.runMutation(step('prepare'), {});
        path.push('after');
      }
      await s.runMutation(step('publish'), {});
      return path;
    },
  }),
  // A patch decided while a parallel batch is being issued.
  parallel: manager.define({
    ...returnsPath,
    handler: async (s): Promise<string[]> => {
      const path: string[] = [];
      const batch = [s.runMutation(step('grab'), {})];
      if (s.patched('notify')) {
        batch.push(s.runMutation(step('notify'), {}));
        path.push('notify');
      }
      batch.push(s.runMutation(step('grab2'), {}));
      await Promise.all(batch);
      await s.awaitEvent({ name: 'downloadDone' });
      await s.runMutation(step('publish'), {});
      return path;
    },
  }),
};

function setup() {
  const t = convexTest(defineSchema({}), {
    './_generated/api.ts': async () => ({}),
    './flows.ts': async () => functions,
  });
  patchesTest.register(t);
  return t;
}
type T = ReturnType<typeof setup>;

const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
async function start(t: T, name = 'pipeline') {
  const id = await t.run((ctx) => manager.start(ctx, ref(name), {}));
  await settle(t);
  return id;
}
async function downloadDone(t: T, workflowId: WorkflowId) {
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name: 'downloadDone' }));
  await settle(t);
}
const result = (t: T, workflowId: WorkflowId) =>
  t.run(async (ctx) => (await ctx.runQuery(components.workflow.workflow.getStatus, { workflowId })).workflow.runResult);
const markers = (t: T, workflowId: WorkflowId) =>
  t.run(async (ctx) => (await ctx.runQuery(components.workflowPatches.markers.list, { workflowId })).map((m) => m.patchId).sort());
const success = (returnValue: string[]) => ({ kind: 'success', returnValue });
const failure = async (t: T, workflowId: WorkflowId) => {
  const r = await result(t, workflowId);
  return r?.kind === 'failed' ? r.error : `not failed: ${JSON.stringify(r)}`;
};

beforeEach(() => {
  vi.useFakeTimers();
  simulateDeploy();
  notify = 'patched';
});
afterEach(() => vi.useRealTimers());

test('a run waiting across the deploy skips the patch it passed and takes the one it reaches', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify', 'prepare'] }); // release 1
  const old = await start(t);
  simulateDeploy(); // release 2
  const fresh = await start(t);
  await downloadDone(t, old);
  await downloadDone(t, fresh);

  expect(await result(t, old)).toEqual(success(['prepare']));
  expect(await markers(t, old)).toEqual(['prepare']);
  expect(await result(t, fresh)).toEqual(success(['notify', 'prepare']));
  expect(await markers(t, fresh)).toEqual(['notify', 'prepare']);
});

test('the same change without patched() fails the waiting run', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify', 'prepare'] });
  const old = await start(t);
  simulateDeploy();
  notify = 'unguarded';
  await downloadDone(t, old);
  expect(await failure(t, old)).toContain('Journal entry mismatch');
});

test('deprecatePatch fails a run that passed the point without the patch, with the patch id', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify', 'prepare'] }); // release 1
  const old = await start(t);
  simulateDeploy(); // release 2
  const fresh = await start(t);
  notify = 'deprecated'; // release 3
  await downloadDone(t, old);
  await downloadDone(t, fresh);
  expect(await failure(t, old)).toContain('deprecatePatch("notify")');
  expect(await result(t, fresh)).toEqual(success(['notify', 'prepare']));
});

test('restart from before a patch point puts the run on the new path', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify', 'prepare'] });
  const id = await start(t);
  simulateDeploy();
  await downloadDone(t, id);
  expect(await result(t, id)).toEqual(success(['prepare']));

  await t.run((ctx) => manager.restart(ctx, id, { from: 1 })); // keep only grab
  await settle(t);
  await downloadDone(t, id);
  expect(await result(t, id)).toEqual(success(['notify', 'prepare']));
});

test('one patch id gives one answer per run, even when the run crosses a deploy between its call sites', async () => {
  const t = setup();
  simulateDeploy({ without: ['format'] });
  const old = await start(t, 'twoSites');
  simulateDeploy();
  const fresh = await start(t, 'twoSites');
  await downloadDone(t, old);
  await downloadDone(t, fresh);
  expect(await result(t, old)).toEqual(success([]));
  expect(await result(t, fresh)).toEqual(success(['before', 'after']));
});

test('a patch decided while a parallel batch is issued replays', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] });
  const old = await start(t, 'parallel');
  simulateDeploy();
  const fresh = await start(t, 'parallel');
  await downloadDone(t, old);
  await downloadDone(t, fresh);
  expect(await result(t, old)).toEqual(success([]));
  expect(await result(t, fresh)).toEqual(success(['notify']));
});

test('rolling back below a recorded patch fails the run', async () => {
  const t = setup();
  const id = await start(t); // current code: notify taken and recorded
  simulateDeploy({ without: ['notify'] }); // roll back
  await downloadDone(t, id);
  expect(await failure(t, id)).toContain('Journal entry mismatch');
});

test('cleanup removes the markers', async () => {
  const t = setup();
  const id = await start(t);
  await downloadDone(t, id);
  expect(await markers(t, id)).toEqual(['notify', 'prepare']);
  expect(await t.run((ctx) => manager.cleanup(ctx, id))).toBe(true);
  expect(await markers(t, id)).toEqual([]);
});
