import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { v } from 'convex/values';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { type PatchDeclaration, type PatchesComponent, type WorkflowComponent, type WorkflowCtx, type WorkflowId, WorkflowManager } from '../src/index.ts';
import patchesTest, { simulateDeploy } from '../src/test.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowPatches: PatchesComponent };
// Mutable, so a test can move a patch to another state as a release would.
const declared: Record<string, PatchDeclaration> = {};
const DECLARED: Record<string, PatchDeclaration> = {
  'flows:pipeline': { active: ['notify', 'prepare'] },
  'flows:twoSites': { active: ['format'] },
  'flows:laterSite': { active: ['format'] },
  'flows:parallel': { active: ['notify'] },
  'flows:moved': { active: ['notify'] },
  'flows:wide': { active: ['notify'] },
  'flows:child': { active: ['notify'] },
  'flows:twoWaits': { active: ['notify'] },
  'flows:typo': {},
};
const manager = new WorkflowManager(components.workflow, { patches: components.workflowPatches, declared });
type Ref = FunctionReference<'mutation', 'internal', { args: Record<string, never> }, WorkflowId>;
const ref = (name: string) => anyApi.flows![name] as Ref;
const step = (name: string) => anyApi.flows![name]!;

const noop = internalMutationGeneric({ args: {}, handler: async () => null });

// How the pipeline's notify step is written in the deployed code. `simulateDeploy`
// switches patches off; this switches what replaces them.
let notify: 'patched' | 'unguarded' | 'deprecated' = 'patched';
// Where the `moved` workflow decides its patch: inside its batch, or before it.
let decide: 'inBatch' | 'first' = 'inBatch';
// Which of the `twoSites` workflow's call sites the deployed code has.
let formatSites: 'both' | 'second' = 'both';

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
  // One patch id at two call sites with waits between, for releases that drop the first.
  laterSite: manager.define({
    ...returnsPath,
    handler: async (s): Promise<string[]> => {
      const path: string[] = [];
      await s.runMutation(step('grab'), {});
      if (formatSites === 'both' && s.patched('format')) path.push('before');
      await s.awaitEvent({ name: 'first' });
      await s.runMutation(step('importFiles'), {});
      await s.awaitEvent({ name: 'downloadDone' });
      if (s.patched('format')) path.push('after');
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
  // The same patch, decided inside the batch or hoisted before it.
  moved: manager.define({
    ...returnsPath,
    handler: async (s): Promise<string[]> => {
      const early = decide === 'first' ? s.patched('notify') : undefined;
      const batch = [s.runMutation(step('grab'), {})];
      const took = early ?? s.patched('notify');
      if (took) batch.push(s.runMutation(step('notify'), {}));
      batch.push(s.runMutation(step('grab2'), {}));
      await Promise.all(batch);
      await s.awaitEvent({ name: 'downloadDone' });
      await s.runMutation(step('publish'), {});
      return took ? ['notify'] : [];
    },
  }),
  // A batch wider than maxParallelism (10), with the patch decided mid-batch.
  wide: manager.define({
    ...returnsPath,
    handler: async (s): Promise<string[]> => {
      const batch = Array.from({ length: 6 }, () => s.runMutation(step('grab'), {}));
      const notified = s.patched('notify');
      if (notified) batch.push(s.runMutation(step('notify'), {}));
      batch.push(...Array.from({ length: 6 }, () => s.runMutation(step('grab2'), {})));
      await Promise.all(batch);
      await s.awaitEvent({ name: 'downloadDone' });
      await s.runMutation(step('publish'), {});
      return notified ? ['notify'] : [];
    },
  }),
  // A child workflow, started under a custom step name.
  parent: manager.define({
    ...returnsPath,
    handler: async (s): Promise<string[]> => (await s.runWorkflow(ref('child'), {}, { name: 'custom child name' })) as string[],
  }),
  child: manager.define({
    ...returnsPath,
    handler: async (s): Promise<string[]> => {
      const notified = s.patched('notify');
      if (notified) await s.runMutation(step('notify'), {});
      return notified ? ['notify'] : [];
    },
  }),
  // Two waits, so a run that skipped a patch is still running afterwards.
  twoWaits: manager.define({
    ...returnsPath,
    handler: async (s): Promise<string[]> => {
      await s.runMutation(step('grab'), {});
      const removed = !(declared['flows:twoWaits']?.active ?? []).includes('notify');
      if (removed || s.patched('notify')) await s.runMutation(step('notify'), {});
      await s.awaitEvent({ name: 'downloadDone' });
      await s.runMutation(step('importFiles'), {});
      await s.awaitEvent({ name: 'prepared' });
      await s.runMutation(step('publish'), {});
      return [];
    },
  }),
  typo: manager.define({
    ...returnsPath,
    handler: async (s): Promise<string[]> => (s.patched('notfiy') ? ['typo'] : []),
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
const records = (t: T, workflowId: WorkflowId) => t.run((ctx) => ctx.runQuery(components.workflowPatches.runs.load, { workflowId }));
const markers = async (t: T, workflowId: WorkflowId) => (await records(t, workflowId)).markers.map((m) => m.patchId).sort();
const success = (returnValue: string[]) => ({ kind: 'success', returnValue });
const failure = async (t: T, workflowId: WorkflowId) => {
  const r = await result(t, workflowId);
  return r?.kind === 'failed' ? r.error : `not failed: ${JSON.stringify(r)}`;
};

beforeEach(() => {
  vi.useFakeTimers();
  simulateDeploy();
  notify = 'patched';
  decide = 'inBatch';
  formatSites = 'both';
  for (const key of Object.keys(declared)) delete declared[key];
  for (const [workflow, entry] of Object.entries(DECLARED)) declared[workflow] = { ...entry };
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
  declared['flows:pipeline'] = { active: ['prepare'], deprecated: ['notify'] };
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

test('moving a released patched() call before its batch keeps runs that took it on the new path', async () => {
  const t = setup();
  const id = await start(t, 'moved'); // decides inside the batch, takes the patch
  decide = 'first'; // the next release hoists the decision
  await downloadDone(t, id);
  expect(await result(t, id)).toEqual(success(['notify']));
});

test('a batch wider than maxParallelism with a patch decided in the middle', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] });
  const old = await start(t, 'wide');
  simulateDeploy();
  const fresh = await start(t, 'wide');
  await downloadDone(t, old);
  await downloadDone(t, fresh);
  expect(await result(t, old)).toEqual(success([]));
  expect(await result(t, fresh)).toEqual(success(['notify']));
  const [marker] = (await records(t, fresh)).markers;
  const names = await t.run(async (ctx) => (await manager.listSteps(ctx, fresh)).page.map((s) => [s.stepId, s.name]));
  expect(Object.fromEntries(names)[marker!.beforeStepId]).toBe('flows:notify');
});

test('a child workflow started under a custom name is recorded under its function name', async () => {
  const t = setup();
  const parent = await start(t, 'parent');
  expect(await result(t, parent)).toEqual(success(['notify']));
  const child = await t.run(async (ctx) => (await manager.listSteps(ctx, parent)).page.find((s) => s.kind === 'workflow'));
  const childId = child?.kind === 'workflow' ? child.nestedWorkflowId : undefined;
  expect(child?.name).toBe('custom child name');
  expect((await records(t, childId!)).run?.workflow).toBe('flows:child');
});

test('a run that skipped a patch at one call site keeps the old path when a release keeps only a later one', async () => {
  const t = setup();
  simulateDeploy({ without: ['format'] }); // release 1
  const id = await start(t, 'laterSite');
  simulateDeploy(); // release 2: both call sites; the run replays past the first without the patch
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId: id, name: 'first' }));
  await settle(t);
  expect((await records(t, id)).skips.map((skip) => skip.patchId)).toEqual(['format']);
  formatSites = 'second'; // release 3: only the call after the last wait
  await downloadDone(t, id);
  expect(await result(t, id)).toEqual(success([]));
});

test('patched() and deprecatePatch() only accept ids in their own state', async () => {
  const t = setup();
  declared['flows:typo'] = { deprecated: ['notfiy'] };
  expect(await failure(t, await start(t, 'typo'))).toContain('Workflow patch "notfiy" is deprecated for flows:typo: call deprecatePatch("notfiy")');
  declared['flows:typo'] = { retired: ['notfiy'] };
  expect(await failure(t, await start(t, 'typo'))).toContain('Workflow patch "notfiy" is retired for flows:typo');
  notify = 'deprecated';
  expect(await failure(t, await start(t))).toContain('Workflow patch "notify" is active for flows:pipeline: move it to "deprecated"');
});

test('patched() with an id the workflow does not declare fails the run', async () => {
  const t = setup();
  const id = await start(t, 'typo');
  expect(await failure(t, id)).toContain('Workflow patch "notfiy" isn\'t declared for flows:typo');
});

test('a run that skipped a patch whose old branch was removed fails with the patch named', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] }); // release 1
  const id = await start(t, 'twoWaits');
  simulateDeploy(); // release 2: the run replays past notify without it
  await downloadDone(t, id);
  expect((await records(t, id)).skips.map((skip) => skip.patchId)).toEqual(['notify']);
  declared['flows:twoWaits'] = { retired: ['notify'] }; // release 3: notify's old branch is gone
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId: id, name: 'prepared' }));
  await settle(t);
  const error = await failure(t, id);
  expect(error).toContain('Workflow patch "notify" was removed');
  expect(error).toContain('Journal entry mismatch');
});
