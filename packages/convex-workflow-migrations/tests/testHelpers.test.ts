import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { expect, test } from 'vite-plus/test';

import { migration, type MigrationsComponent, type WorkflowComponent, type WorkflowCtx, WorkflowManager } from '../src/index.ts';
import migrationsTest, { expectReplays, history, migrate } from '../src/test.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowMigrations: MigrationsComponent };
const manager = new WorkflowManager(components.workflow, { migrationsComponent: components.workflowMigrations });
const flows = anyApi.flows!;
const ref = (name: string) => flows[name] as FunctionReference<'mutation', 'internal'>;
const noop = internalMutationGeneric({ handler: async () => null });

const notifyAfterGrab = migration('notify-after-grab', (h) => h.insertAfter(flows.grab, flows.notify, { result: { at: null } }));
const prepareBecomesTranscode = migration('prepare-becomes-transcode', (h) => h.rename(flows.prepare, flows.transcode));
const pipeline = (shape: { notify: boolean; transcode: boolean }) => async (step: WorkflowCtx) => {
  await step.runMutation(flows.grab, {});
  // Throws if notify's result has no `at`.
  if (shape.notify) void ((await step.runMutation(flows.notify, {})) as { at: number | null }).at;
  await step.awaitEvent({ name: 'downloadDone' });
  await step.runMutation(shape.transcode ? flows.transcode : flows.prepare, {});
};

const functions = {
  grab: noop,
  notify: noop,
  prepare: noop,
  transcode: noop,
  audit: noop,
  current: manager.define({ args: {}, migrations: [notifyAfterGrab, prepareBecomesTranscode], handler: pipeline({ notify: true, transcode: true }) }),
  unguarded: manager.define({ args: {}, handler: pipeline({ notify: true, transcode: false }) }),
  // A stand-in whose result the handler can't use.
  badStandIn: manager.define({
    args: {},
    migrations: [migration('notify-after-grab', (h) => h.insertAfter(flows.grab, flows.notify, { result: null }))],
    handler: pipeline({ notify: true, transcode: false }),
  }),
  late: manager.define({
    args: {},
    migrations: [migration('audit', (h) => h.insertAfter(flows.grab, flows.audit, { runLate: true, args: {} }))],
    handler: async (step) => {
      await step.runMutation(flows.grab, {});
      await step.runMutation(flows.audit, {});
      await step.awaitEvent({ name: 'downloadDone' });
    },
  }),
};

function setup() {
  const t = convexTest(defineSchema({}), {
    './_generated/api.ts': async () => ({}),
    './flows.ts': async () => functions,
  });
  migrationsTest.register(t);
  return t;
}

// Histories the older releases recorded.
const release0Waiting = history([{ step: flows.grab }, { event: 'downloadDone', status: 'running' }], { workflowId: 'r0-waiting' });
const release0Done = history([{ step: flows.grab }, { event: 'downloadDone' }, { step: flows.prepare }]);
const release1Waiting = history([{ step: flows.grab }, { step: flows.notify, result: { at: 5 } }, { event: 'downloadDone', status: 'running' }], {
  applied: ['notify-after-grab'],
});

test('history() builds a recorded history', () => {
  expect(
    history(
      [
        { step: flows.grab, args: { id: 1 }, result: 'ok' },
        { event: 'downloadDone', status: 'running' },
        { sleep: 'nap', status: 'done' },
      ],
      { args: { id: 1 } },
    ),
  ).toEqual({
    args: { id: 1 },
    steps: [
      { id: 'h0', name: 'flows:grab', kind: 'function', args: { id: 1 }, runResult: { kind: 'success', returnValue: 'ok' }, startedAt: 0 },
      { id: 'h1', name: 'downloadDone', kind: 'event', args: {}, startedAt: 1 },
      { id: 'h2', name: 'nap', kind: 'sleep', args: {}, runResult: { kind: 'success', returnValue: null }, startedAt: 2 },
    ],
  });
});

test('expectReplays passes for histories the migrations bring into the current shape', async () => {
  await expectReplays(setup(), ref('current'), [release0Waiting, release0Done, release1Waiting]);
});

test('expectReplays reports the history, the position, and both calls when one does not replay', async () => {
  const ownWaiting = history([{ step: flows.grab }, { step: flows.notify, result: { at: 5 } }, { event: 'downloadDone', status: 'running' }]);
  const error = await expectReplays(setup(), ref('unguarded'), [release0Waiting, ownWaiting]).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain("1 of 2 histories don't replay on flows:unguarded:");
  expect(message).toContain(
    'history 0 (r0-waiting): Journal entry mismatch at step 1: the code calls {"args":{},"kind":"function","name":"flows:notify"}, the history has {"args":{},"kind":"event","name":"downloadDone"}',
  );
  expect(message).toContain('migrated history: 0: flows:grab, 1: downloadDone (running)');
});

test('expectReplays reports a handler that throws on a stand-in result', async () => {
  await expect(expectReplays(setup(), ref('badStandIn'), [release0Waiting])).rejects.toThrow('The handler threw');
});

test('expectReplays stops at a step a migration inserted with runLate', async () => {
  await expectReplays(setup(), ref('late'), [release0Waiting, release0Done]);
});

test('expectReplays reports a migration that edits a running step', async () => {
  const preparing = history([{ step: flows.grab }, { event: 'downloadDone' }, { step: flows.prepare, status: 'running' }]);
  await expect(expectReplays(setup(), ref('current'), [preparing])).rejects.toThrow(
    'Migration "prepare-becomes-transcode" threw: rename(flows:prepare): the step is still running',
  );
});

test('migrate returns the history after the migrations', async () => {
  const t = setup();
  const migrated = await migrate(t, ref('current'), release0Done);
  expect(migrated.steps.map((s) => s.name)).toEqual(['flows:grab', 'flows:notify', 'downloadDone', 'flows:transcode']);
  expect(migrated.result(flows.notify)).toEqual({ at: null });
  // Already applied: nothing changes.
  const current = await migrate(t, ref('current'), { ...release0Done, applied: ['notify-after-grab', 'prepare-becomes-transcode'] });
  expect(current.steps.map((s) => s.name)).toEqual(['flows:grab', 'downloadDone', 'flows:prepare']);
  await expect(migrate(t, ref('unguarded'), { ...release0Done, applied: ['gone'] })).rejects.toThrow('The run has migrations "gone" applied');
});
