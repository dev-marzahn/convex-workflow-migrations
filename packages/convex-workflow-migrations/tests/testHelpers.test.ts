import { convexTest } from 'convex-test';
import { anyApi, componentsGeneric, defineSchema, type FunctionReference, internalMutationGeneric } from 'convex/server';
import { v } from 'convex/values';
import { expect, test } from 'vite-plus/test';

import { migration, type MigrationsComponent, type Redactable, type WorkflowComponent, type WorkflowCtx, WorkflowManager } from '../src/index.ts';
import { redactHistory } from '../src/redact.ts';
import migrationsTest, { expectEdits, expectReplays, history, migrate } from '../src/test.ts';

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
  fetch: noop,
  notify: noop,
  prepare: noop,
  transcode: noop,
  child: noop,
  current: manager.define({ args: {}, migrations: [notifyAfterGrab, prepareBecomesTranscode], handler: pipeline({ notify: true, transcode: true }) }),
  unguarded: manager.define({ args: {}, handler: pipeline({ notify: true, transcode: false }) }),
  // A stand-in whose result the handler can't use.
  badStandIn: manager.define({
    args: {},
    migrations: [migration('notify-after-grab', (h) => h.insertAfter(flows.grab, flows.notify, { result: null }))],
    handler: pipeline({ notify: true, transcode: false }),
  }),
  // Release 0 with a required arg, with and without the migration that gives old runs one.
  withArg: manager.define({
    args: { quality: v.string() },
    migrations: [migration('quality-arg', (h) => h.updateWorkflowArgs((args) => ({ ...args, quality: 'hd' })))],
    handler: async (step, { quality }) => {
      await step.runMutation(flows.grab, { quality });
      await step.awaitEvent({ name: 'downloadDone' });
    },
  }),
  withArgUnguarded: manager.define({
    args: { quality: v.string() },
    handler: async (step) => {
      await step.runMutation(flows.grab, {});
      await step.awaitEvent({ name: 'downloadDone' });
    },
  }),
  // Release 0 took only an email; release 1 adds a quality, which grab gets too.
  personal: manager.define({
    args: { email: v.string(), quality: v.string() },
    migrations: [
      migration('quality-arg', (h) => h.updateWorkflowArgs((args) => ({ ...args, quality: 'hd' }))),
      migration('grab-gets-quality', (h) => h.updateArgs(flows.grab, (args) => ({ ...args, quality: h.workflowArgs.quality }))),
    ],
    handler: async (step, { email, quality }) => {
      await step.runMutation(flows.grab, { email, quality });
      await step.awaitEvent({ name: 'downloadDone' });
    },
  }),
  // Code that ends after grab.
  short: manager.define({
    args: {},
    handler: async (step) => {
      await step.runMutation(flows.grab, {});
    },
  }),
  // Rethrows a failed grab, as release 0 did.
  rethrows: manager.define({
    args: {},
    handler: async (step) => {
      await step.runMutation(flows.grab, {});
      await step.awaitEvent({ name: 'downloadDone' });
    },
  }),
  // Rethrows a failed grab, which older code called fetch.
  renamesGrab: manager.define({
    args: {},
    migrations: [migration('fetch-becomes-grab', (h) => h.rename(flows.fetch, flows.grab))],
    handler: async (step) => {
      await step.runMutation(flows.grab, {});
    },
  }),
  // No longer waits for the download after notify, and no longer catches notify's failure.
  dropsWait: manager.define({
    args: {},
    migrations: [migration('drop-wait', (h) => h.remove({ event: 'downloadDone' }))],
    handler: async (step) => {
      await step.runMutation(flows.grab, {});
      await step.runMutation(flows.notify, {});
    },
  }),
  // Inserts child as a function, then calls it as a workflow.
  childAsWorkflow: manager.define({
    args: {},
    migrations: [migration('child-after-grab', (h) => h.insertAfter(flows.grab, flows.child, { result: null }))],
    handler: async (step) => {
      await step.runMutation(flows.grab, {});
      await step.runWorkflow(flows.child, {});
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

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

test('history() builds a recorded history', () => {
  expect(
    history(
      [
        { step: flows.grab, args: { id: 1 }, result: 'ok' },
        { event: 'downloadDone', status: 'running' },
        { sleep: 'nap', status: 'done' },
      ],
      { args: { id: 1 }, outcome: 'failed' },
    ),
  ).toEqual({
    args: { id: 1 },
    steps: [
      { id: 'h0', name: 'flows:grab', kind: 'function', args: { id: 1 }, runResult: { kind: 'success', returnValue: 'ok' }, startedAt: 0 },
      { id: 'h1', name: 'downloadDone', kind: 'event', args: {}, startedAt: 1 },
      { id: 'h2', name: 'nap', kind: 'sleep', args: {}, runResult: { kind: 'success', returnValue: null }, startedAt: 2 },
    ],
    outcome: 'failed',
  });
});

test('expectReplays passes for histories the migrations bring into the current shape', async () => {
  await expectReplays(setup(), ref('current'), [release0Waiting, release0Done, release1Waiting]);
});

test('expectReplays reports the history, the position, and both calls when one does not replay', async () => {
  const ownWaiting = history([{ step: flows.grab }, { step: flows.notify, result: { at: 5 } }, { event: 'downloadDone', status: 'running' }]);
  const message = await failure(expectReplays(setup(), ref('unguarded'), [release0Waiting, ownWaiting]));
  expect(message).toContain("1 of 2 histories don't replay on flows:unguarded:");
  expect(message).toContain(
    'history 0 (r0-waiting) (mismatch): Journal entry mismatch at step 1: the code calls {"args":{},"kind":"function","name":"flows:notify"}, the history has {"args":{},"kind":"event","name":"downloadDone"}',
  );
  expect(message).toContain('migrated history: 0: flows:grab, 1: downloadDone (running)');
});

test('expectReplays reports a handler that throws on a stand-in result', async () => {
  const message = await failure(expectReplays(setup(), ref('badStandIn'), [release0Waiting]));
  expect(message).toContain('(threw): The handler threw before step 2 of its history');
});

test('expectReplays reports a migration that edits a running step', async () => {
  const preparing = history([{ step: flows.grab }, { event: 'downloadDone' }, { step: flows.prepare, status: 'running' }]);
  await expect(expectReplays(setup(), ref('current'), [preparing])).rejects.toThrow(
    'Migration "prepare-becomes-transcode" threw: rename(flows:prepare): the step is still running',
  );
});

test('expectReplays checks the workflow args as the migrations leave them', async () => {
  const t = setup();
  await expectReplays(t, ref('withArg'), [
    history([
      { step: flows.grab, args: { quality: 'hd' } },
      { event: 'downloadDone', status: 'running' },
    ]),
  ]);
  const message = await failure(expectReplays(t, ref('withArgUnguarded'), [release0Waiting]));
  expect(message).toContain("(args): The workflow's args don't match its args validator");
});

test('expectReplays reports code that returns before the end of the history', async () => {
  const message = await failure(expectReplays(setup(), ref('short'), [release0Done]));
  expect(message).toContain('(mismatch): Journal entry mismatch at step 1: the code returned before it');
});

test("expectReplays passes a failed run's rethrow after its history, and reports one for a run that succeeded", async () => {
  const t = setup();
  const failed = history([{ step: flows.grab, error: 'grab failed' }], { outcome: 'failed' });
  await expectReplays(t, ref('rethrows'), [failed, { ...failed, outcome: undefined }]);
  const message = await failure(expectReplays(t, ref('rethrows'), [{ ...failed, outcome: 'success' }]));
  expect(message).toContain('(threw): The run succeeded, but the handler now fails after replaying its history: Error: grab failed');
  // The migrations edit this history (a stand-in after grab), and the handler passes the wait's failure on: it fails, as it did.
  await expectReplays(t, ref('current'), [history([{ step: flows.grab }, { event: 'downloadDone', error: 'the download failed' }], { outcome: 'failed' })]);
});

test('expectReplays fails, not pauses, a run whose newest step failed, though migrations edited its history', async () => {
  const t = setup();
  // Waiting for the download when the release with the migrations shipped, and then the download failed.
  const waitFailed = history([{ step: flows.grab }, { event: 'downloadDone', error: 'the download failed' }]);
  await expectReplays(t, ref('current'), [waitFailed]);
  // A migration that renamed the failed step may be why it fails: that pauses.
  const renamed = await failure(expectReplays(t, ref('renamesGrab'), [history([{ step: flows.fetch, error: 'fetch failed' }])]));
  expect(renamed).toContain('(threw): The handler threw after migrations "fetch-becomes-grab" changed its history');
});

test('expectReplays pauses a throw on a failure that is last only because a migration removed the steps after it', async () => {
  // The old code caught notify's failure and waited for the download; the new code no longer waits, and no longer catches it.
  const caught = history([{ step: flows.grab }, { step: flows.notify, error: 'mail bounced' }, { event: 'downloadDone' }]);
  const message = await failure(expectReplays(setup(), ref('dropsWait'), [caught]));
  expect(message).toContain('(threw): The handler threw after migrations "drop-wait" changed its history: ');
  expect(message).toContain('mail bounced');
});

test('a redacted export replays: the overlay is scrubbed with the steps and the run args', async () => {
  const t = setup();
  const email = 'a@b.c';
  const waiting = history(
    [
      { step: flows.grab, args: { email } },
      { event: 'downloadDone', status: 'running' },
    ],
    { args: { email } },
  );
  // As exported: one run with both migrations saved, one with only the first, the second still to apply.
  const workflowArgs = { op: 'workflowArgs' as const, args: { email, quality: 'hd' } };
  const both = {
    ...waiting,
    applied: ['quality-arg', 'grab-gets-quality'],
    overlay: [workflowArgs, { op: 'rewrite' as const, target: 'h0', args: { email, quality: 'hd' } }],
  };
  const first = { ...waiting, applied: ['quality-arg'], overlay: [workflowArgs] };
  await expectReplays(t, ref('personal'), [both, first]);

  const redact = (value: Redactable): Redactable => ({ ...value, args: JSON.parse(JSON.stringify(value.args).replaceAll(email, 'x')) });
  const redacted = await Promise.all([both, first].map((h) => redactHistory(h, redact)));
  expect(JSON.stringify(redacted)).not.toContain(email);
  await expectReplays(t, ref('personal'), redacted);
});

test('expectReplays fails a truncated history, and migrate throws for one', async () => {
  const message = await failure(expectReplays(setup(), ref('current'), [{ ...release0Done, truncated: true }]));
  expect(message).toContain('(truncated): The history is truncated: the export stopped at 3 steps');
  await expect(migrate(setup(), ref('current'), { ...release0Done, truncated: true })).rejects.toThrow('The history is truncated');
});

test("an exported run's pending restart applies, as the deployment's next handler run will apply it", async () => {
  const t = setup();
  // Restarted from the wait: the run's next handler run hides it, and waits for the download again.
  const restarted = { ...release0Done, outcome: undefined, restart: 'h1' };
  expect((await migrate(t, ref('current'), restarted)).steps.map((s) => s.name)).toEqual(['flows:grab', 'flows:notify']);
  // short returns after grab: against the whole history, that's an early return.
  await expect(expectReplays(t, ref('short'), [release0Done])).rejects.toThrow('the code returned before it');
  await expectReplays(t, ref('short'), [{ ...release0Done, restart: 'h1' }]);
});

test('a stand-in inserted as a function and called as a workflow says so', async () => {
  const message = await failure(expectReplays(setup(), ref('childAsWorkflow'), [release0Waiting]));
  expect(message).toContain('It was inserted as a function, and called as a workflow: insert it with { workflow: ref }.');
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

test('expectEdits passes when the migrations changed the history, and names the ones that did nothing', async () => {
  const t = setup();
  await expectEdits(migrate(t, ref('current'), release0Done));
  await expectEdits(migrate(t, ref('current'), release0Done), ['prepare-becomes-transcode']);
  // A run waiting before prepare: the rename has nothing to rename.
  const message = await failure(expectEdits(migrate(t, ref('current'), release0Waiting)));
  expect(message).toContain('"prepare-becomes-transcode" changed nothing');
  expect(message).not.toContain('"notify-after-grab"');
  const applied = await failure(expectEdits(migrate(t, ref('current'), { ...release0Done, applied: ['notify-after-grab'] }), ['notify-after-grab']));
  expect(applied).toContain('"notify-after-grab" didn\'t run');
  await expect(expectEdits(release0Done as never)).rejects.toThrow('expectEdits takes the history migrate() returns.');
});
