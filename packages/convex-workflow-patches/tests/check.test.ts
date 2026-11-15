import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { type DeclaredPatches, type PatchesComponent, type WorkflowComponent, type WorkflowId, WorkflowManager } from '../src/index.ts';
import { check as predeployCheck, COMPONENT_NOT_DEPLOYED, DEFAULT_COMPONENT_PATHS, type Facts, inspect, type Query } from '../src/predeploy.ts';
import patchesTest, { simulateDeploy } from '../src/test.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowPatches: PatchesComponent };
const manager = new WorkflowManager(components.workflow, { patches: components.workflowPatches, declared: { 'checked:pipeline': { active: ['notify'] } } });
type Ref = FunctionReference<'mutation', 'internal', { args: Record<string, never> }, WorkflowId>;
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
  // A workflow without patches, waiting.
  idle: manager.define({
    args: {},
    handler: async (s): Promise<void> => {
      await s.runMutation(step('grab'), {});
      await s.awaitEvent({ name: 'first' });
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
async function start(t: T, workflow: 'pipeline' | 'idle' = 'pipeline') {
  const id = await t.run((ctx) => manager.start(ctx, anyApi.checked![workflow] as Ref, {}));
  await settle(t);
  return id;
}
async function send(t: T, workflowId: WorkflowId, name: 'first' | 'second') {
  await t.run((ctx) => manager.sendEvent(ctx, { workflowId, name }));
  await settle(t);
}
/** Deletes a run's records, as if it last ran before the app adopted this package. */
const forget = (t: T, workflowId: WorkflowId) => t.run((ctx) => ctx.runMutation(components.workflowPatches.runs.cleanup, { workflowId }));

/**
 * The deployment as the check module sees it: `query` as convex-release and
 * the CLI give it, here calling the components in convex-test.
 */
const queryOf =
  (t: T, deployedComponents = ['workflow', 'workflowPatches']): Query =>
  async <R>({ componentPath, path }: { componentPath?: string; path: string }, args: object = {}) => {
    if (!componentPath || !deployedComponents.includes(componentPath)) {
      throw Object.assign(new Error(`${componentPath} isn't deployed`), { code: COMPONENT_NOT_DEPLOYED });
    }
    const [module, fn] = path.split(':') as [string, string];
    const ref = (components as unknown as Record<string, Record<string, Record<string, FunctionReference<'query', 'internal'>>>>)[componentPath]![module]![fn]!;
    return (await t.run((ctx) => ctx.runQuery(ref, args))) as R;
  };
const facts = (declared: DeclaredPatches): Facts => ({ declared, componentPaths: DEFAULT_COMPONENT_PATHS });
const check = async (t: T, declared: DeclaredPatches, pageSize?: number) => (await inspect(facts(declared), queryOf(t), pageSize))!;
const retiringNotify = { 'checked:pipeline': { retired: ['notify'] } };
const deprecatingNotify = { 'checked:pipeline': { deprecated: ['notify'] } };

beforeEach(() => {
  vi.useFakeTimers();
  simulateDeploy();
});
afterEach(() => vi.useRealTimers());

test('retiring a patch is blocked by a run that skipped it, not by one that took it', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] }); // release 1
  const skipped = await start(t);
  simulateDeploy(); // release 2
  await start(t); // takes notify
  await send(t, skipped, 'first'); // replays past notify without it

  expect(await check(t, retiringNotify)).toEqual({
    gone: { 'checked:pipeline': ['notify'] },
    unknown: {},
    blockers: [{ workflowId: skipped, workflow: 'checked:pipeline', patchId: 'notify', reason: 'skipped' }],
  });
});

test('deprecating a patch (step 2) is checked like retiring it', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] });
  const skipped = await start(t);
  simulateDeploy();
  await send(t, skipped, 'first');

  expect((await check(t, deprecatingNotify)).blockers).toEqual([{ workflowId: skipped, workflow: 'checked:pipeline', patchId: 'notify', reason: 'skipped' }]);
});

test('a run waiting since before the patch shipped blocks, with no handler run on the release in between', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] });
  const waiting = await start(t); // passed the notify point on release 1, waits for "first"
  simulateDeploy(); // release 2 ships notify, but nothing runs on it

  expect((await check(t, retiringNotify)).blockers).toEqual([{ workflowId: waiting, workflow: 'checked:pipeline', patchId: 'notify', reason: 'waiting' }]);
});

test('finished runs and releases that remove nothing pass', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] });
  const old = await start(t);
  simulateDeploy();
  await start(t);
  await send(t, old, 'first');
  await send(t, old, 'second'); // finished

  expect((await check(t, retiringNotify)).blockers).toEqual([]);
  expect(await check(t, { 'checked:pipeline': { active: ['notify'] } })).toEqual({ gone: {}, unknown: {}, blockers: [] });
});

test('a rollback to a release without the patch is blocked by runs that recorded it', async () => {
  const t = setup();
  const took = await start(t); // takes notify

  expect(await check(t, { 'checked:pipeline': {} })).toEqual({
    gone: {},
    unknown: { 'checked:pipeline': ['notify'] },
    blockers: [{ workflowId: took, workflow: 'checked:pipeline', patchId: 'notify', reason: 'unknown' }],
  });
});

test('every run is tracked, and an untracked run only blocks its own workflow', async () => {
  const t = setup();
  const idle = await start(t, 'idle');
  const lookup = (id: WorkflowId) => t.run((ctx) => ctx.runQuery(components.workflowPatches.runs.lookup, { workflowIds: [id] }));
  expect((await lookup(idle))[0]!.run).toEqual({ workflow: 'checked:idle', known: [] });

  const pipeline = await start(t);
  await forget(t, idle);
  await forget(t, pipeline);
  expect((await check(t, retiringNotify)).blockers).toEqual([{ workflowId: pipeline, workflow: 'checked:pipeline', reason: 'untracked' }]);
});

test('reads every page of running workflows', async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] });
  const waiting = [await start(t), await start(t), await start(t)];
  simulateDeploy();
  await start(t);

  const { blockers } = await check(t, retiringNotify, 1);
  expect(blockers.map((b) => b.reason)).toEqual(['waiting', 'waiting', 'waiting']);
  expect(new Set(blockers.map((b) => b.workflowId))).toEqual(new Set(waiting));
});

test("convex-release's check() refuses with one detail per blocking run", async () => {
  const t = setup();
  simulateDeploy({ without: ['notify'] });
  const waiting = await start(t);
  simulateDeploy();

  const logs: string[] = [];
  expect(await predeployCheck({ facts: facts(retiringNotify), query: queryOf(t), log: (line) => logs.push(line) })).toEqual({
    ok: false,
    message: '1 running workflow still needs code this release removes',
    details: [`${waiting} (checked:pipeline) has been waiting since before "notify" shipped`],
  });
  expect(logs).toEqual([]);
  expect(await predeployCheck({ facts: facts({ 'checked:pipeline': { active: ['notify'] } }), query: queryOf(t), log: () => {} })).toEqual({ ok: true });
});

test('passes on the release that adopts the package, before its component is deployed', async () => {
  const t = setup();
  const logs: string[] = [];
  const result = await predeployCheck({ facts: facts(retiringNotify), query: queryOf(t, ['workflow']), log: (line) => logs.push(line) });
  expect(result).toEqual({ ok: true });
  expect(logs).toEqual(['The deployment has no workflowPatches component yet, so no running workflow can need a removed patch.']);
});
