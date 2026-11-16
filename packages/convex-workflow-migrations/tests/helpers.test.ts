// The /replay helpers replay histories without Convex: they take the workflow
// mutation `define` returned, and no convex-test instance.
import { anyApi, componentsGeneric } from 'convex/server';
import { v } from 'convex/values';
import { expect, test } from 'vite-plus/test';

import { expectReplays, history, migrate } from '../src/helpers.ts';
import { type EventId, migration, type MigrationsComponent, type WorkflowComponent, type WorkflowCtx, WorkflowManager } from '../src/index.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowMigrations: MigrationsComponent };
const manager = new WorkflowManager(components.workflow, { migrationsComponent: components.workflowMigrations, onPause: null });
const flows = anyApi.flows!;

const notifyAfterGrab = migration('notify-after-grab', (h) => h.insertAfter(flows.grab, flows.notify, { result: { at: null } }));
const prepareBecomesTranscode = migration('prepare-becomes-transcode', (h) => h.rename(flows.prepare, flows.transcode));
const pipeline = (shape: { notify: boolean; transcode: boolean }) => async (step: WorkflowCtx) => {
  await step.runMutation(flows.grab, {});
  // Throws if notify's result has no `at`.
  if (shape.notify) void ((await step.runMutation(flows.notify, {})) as { at: number | null }).at;
  await step.awaitEvent({ name: 'downloadDone' });
  await step.runMutation(shape.transcode ? flows.transcode : flows.prepare, {});
};
const grabThenWait = (args: (workflowArgs: any) => object) => async (step: WorkflowCtx, workflowArgs: any) => {
  await step.runMutation(flows.grab, args(workflowArgs));
  await step.awaitEvent({ name: 'downloadDone' });
};

const workflows = {
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
    handler: grabThenWait(({ quality }) => ({ quality })),
  }),
  withArgUnguarded: manager.define({ args: { quality: v.string() }, handler: grabThenWait(() => ({})) }),
  // Grab now returns { value }, which older code returned bare: a transform that wraps any result, and one that leaves a wrapped one alone.
  wraps: manager.define({
    args: {},
    migrations: [migration('grab-wraps', (h) => h.updateResult(flows.grab, (result) => ({ value: result })))],
    handler: grabThenWait(() => ({})),
  }),
  normalizes: manager.define({
    args: {},
    migrations: [
      migration('grab-wraps', (h) =>
        h.updateResult(flows.grab, (result) => (typeof result === 'object' && result !== null && 'value' in result ? result : { value: result })),
      ),
    ],
    handler: grabThenWait(() => ({})),
  }),
};

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
        { workflow: flows.child, name: 'kid', canceled: true, startedAt: 1 },
        { sleep: 'nap', error: 'late' },
      ],
      { args: { id: 1 }, applied: [] },
    ),
  ).toEqual({
    args: { id: 1 },
    steps: [
      { id: 'h0', name: 'flows:grab', kind: 'function', args: { id: 1 }, runResult: { kind: 'success', returnValue: 'ok' }, startedAt: 0 },
      { id: 'h1', name: 'downloadDone', kind: 'event', args: {}, startedAt: 1 },
      { id: 'h2', name: 'kid', kind: 'workflow', args: {}, runResult: { kind: 'canceled' }, startedAt: 1 },
      { id: 'h3', name: 'nap', kind: 'sleep', args: {}, runResult: { kind: 'failed', error: 'late' }, startedAt: 3 },
    ],
    applied: [],
  });
});

test('an event step takes the args awaitEvent({ id }) records: { eventId }', async () => {
  const waitsOnId = manager.define({
    args: { eventId: v.string() },
    handler: async (step, { eventId }) => {
      await step.awaitEvent({ id: eventId as EventId<string> });
      await step.runMutation(flows.grab, {});
    },
  });
  const options = { args: { eventId: 'e1' } };
  await expectReplays(waitsOnId, [history([{ event: 'e1', args: { eventId: 'e1' } }], options)]);
  expect(await failure(expectReplays(waitsOnId, [history([{ event: 'e1' }], options)]))).toContain('(mismatch)');
});

test('expectReplays passes for histories the migrations bring into the current shape', async () => {
  await expectReplays(workflows.current, [release0Waiting, release0Done, release1Waiting]);
});

test('the helpers take the workflow mutation, not a function reference', async () => {
  await expect(expectReplays(flows.current as never, [release0Waiting])).rejects.toThrow(
    "expectReplays takes a workflow that this package's WorkflowManager defined: the mutation workflow.define returned, not a function reference.",
  );
  expect(() => migrate(flows.current as never, release0Waiting)).toThrow('migrate takes a workflow');
});

test('expectReplays reports the history, the position, both calls and the migrated history when one does not replay', async () => {
  const ownWaiting = history([{ step: flows.grab }, { step: flows.notify, result: { at: 5 } }, { event: 'downloadDone', status: 'running' }]);
  const message = await failure(expectReplays(workflows.unguarded, [release0Waiting, ownWaiting]));
  expect(message).toContain("1 of 2 histories don't replay on the current handler:");
  expect(message).toContain(
    'history 0 (r0-waiting) (mismatch): Journal entry mismatch at step 1 of the run\'s history, as its migrations leave it: the code calls {"args":{},"kind":"function","name":"flows:notify"}, the history has {"args":{},"kind":"event","name":"downloadDone"}',
  );
  expect(message).toContain('migrated history: 0: flows:grab, 1: downloadDone (running)');
});

test('expectReplays reports a handler that throws while replaying, as the reason the run would pause or fail, but not one passing on a failure it got', async () => {
  // As at runtime: a recorded step is left that the handler didn't replay (throw rule 2).
  const message = await failure(expectReplays(workflows.badStandIn, [release0Waiting]));
  expect(message).toContain(
    `(threw): The handler threw before step 2 of its history (rule 2: a recorded step is left that the handler hasn't replayed): Cannot read properties of null (reading 'at')`,
  );
  // Nothing a migration did: at runtime the run fails (rule 6), and the history doesn't replay.
  const throwing = manager.define({
    args: {},
    handler: async (step: WorkflowCtx) => {
      await step.runMutation(flows.grab, {});
      throw new Error('broken handler');
    },
  });
  expect(await failure(expectReplays(throwing, [history([{ step: flows.grab }])]))).toContain(
    '(fails): The handler threw replaying the history, which fails the run (rule 6: no earlier rule applies): Error: broken handler',
  );
  // The download failed, and the handler throws that: the run fails, as it did (rule 4).
  await expectReplays(workflows.current, [history([{ step: flows.grab }, { event: 'downloadDone', error: 'the download failed' }])]);
  // So does a prepare that failed, though a migration renamed it to transcode (rule 4, not 5).
  await expectReplays(workflows.current, [history([{ step: flows.grab }, { event: 'downloadDone' }, { step: flows.prepare, error: 'it broke' }])]);
});

test('expectReplays reports a return value its returns validator rejects as (returns), also after a failure', async () => {
  const givesUp = manager.define({
    args: {},
    returns: v.number(),
    handler: async (step: WorkflowCtx): Promise<number> => {
      await step.runMutation(flows.grab, {});
      try {
        await step.awaitEvent({ name: 'downloadDone' });
      } catch {
        return 'gave up' as unknown as number;
      }
      return 'done' as unknown as number;
    },
  });
  const report =
    "(returns): The handler's return value doesn't match its returns validator, which fails the run: Invalid return value: Validator error: Expected `number`, got `string`";
  for (const download of [{}, { error: 'the download failed' }]) {
    const message = await failure(expectReplays(givesUp, [history([{ step: flows.grab }, { event: 'downloadDone', ...download }])]));
    expect(message).toContain(report);
  }
});

test('expectReplays reports code that returns before the end of the history', async () => {
  const short = manager.define({ args: {}, handler: async (step: WorkflowCtx) => void (await step.runMutation(flows.grab, {})) });
  expect(await failure(expectReplays(short, [release0Waiting]))).toContain(
    `(mismatch): Journal entry mismatch at step 1 of the run's history, as its migrations leave it: the code returned before it, the history has {"args":{},"kind":"event","name":"downloadDone"}`,
  );
});

test('a migration may edit a running step, which at runtime it never sees', async () => {
  const preparing = history([{ step: flows.grab }, { event: 'downloadDone' }, { step: flows.prepare, status: 'running' }]);
  await expectReplays(workflows.current, [preparing]);
});

test('expectReplays checks the workflow args as the migrations leave them; an empty history without applied ids lets its args pick', async () => {
  await expectReplays(workflows.withArg, [
    history([
      { step: flows.grab, args: { quality: 'hd' } },
      { event: 'downloadDone', status: 'running' },
    ]),
  ]);
  const message = await failure(expectReplays(workflows.withArgUnguarded, [release0Waiting]));
  expect(message).toContain("(args): The workflow's args, as its migrations leave them, don't match its args validator");
  // A child its parent started before the release that added quality: the args lack it, so every migration applies.
  expect(migrate(workflows.withArg, history([], { args: {} })).workflowArgs).toEqual({ quality: 'hd' });
  // Args that pass mean the code that started it is the current one: updateWorkflowArgs doesn't run.
  expect(migrate(workflows.withArg, history([], { args: { quality: 'sd' } })).workflowArgs).toEqual({ quality: 'sd' });
  // A queued run's record has the ids it started with: the pending ones apply.
  expect(migrate(workflows.withArg, history([], { args: { quality: 'sd' }, applied: [] })).workflowArgs).toEqual({ quality: 'hd' });
});

test('expectReplays and migrate fail an updateResult that changes its own output, since a step can finish on the new code', async () => {
  // Grab was running across the deploy, and returned on the new code: its result is in the new shape already.
  const finishedOnNewCode = history([
    { step: flows.grab, result: { value: 'file' } },
    { event: 'downloadDone', status: 'running' },
  ]);
  const oldShape = history([
    { step: flows.grab, result: 'file' },
    { event: 'downloadDone', status: 'running' },
  ]);
  const message = await failure(expectReplays(workflows.wraps, [oldShape]));
  expect(message).toContain(
    '(migration): Migration "grab-wraps" threw: updateResult(flows:grab): run again on its own output, the update changed it ({"value":"file"} became {"value":{"value":"file"}})',
  );
  expect(() => migrate(workflows.wraps, finishedOnNewCode)).toThrow('run again on its own output, the update changed it');
  await expectReplays(workflows.normalizes, [oldShape, finishedOnNewCode]);
  expect(migrate(workflows.normalizes, finishedOnNewCode).result(flows.grab)).toEqual({ value: 'file' });
});

test('migrate returns the history after the migrations', () => {
  const migrated = migrate(workflows.current, release0Done);
  expect(migrated.steps.map((s) => s.name)).toEqual(['flows:grab', 'flows:notify', 'downloadDone', 'flows:transcode']);
  expect(migrated.result(flows.notify)).toEqual({ at: null });
  // Already applied: nothing changes.
  const current = migrate(workflows.current, { ...release0Done, applied: ['notify-after-grab', 'prepare-becomes-transcode'] });
  expect(current.steps.map((s) => s.name)).toEqual(['flows:grab', 'downloadDone', 'flows:prepare']);
  expect(() => migrate(workflows.unguarded, { ...release0Done, applied: ['gone'] })).toThrow('The run has migrations "gone" applied');
});

test('an exported history: its outcome decides which throws fail, and a truncated or unstable one fails', async () => {
  const givesUp = manager.define({
    args: {},
    migrations: [notifyAfterGrab],
    handler: async (step: WorkflowCtx) => {
      await step.runMutation(flows.grab, {});
      await step.runMutation(flows.notify, {});
      await step.awaitEvent({ name: 'downloadDone' });
      throw new Error('gave up');
    },
  });
  const waited = history([{ step: flows.grab }, { event: 'downloadDone' }]);
  // A run still going would pause: migrations edited its history in this handler run (rule 5).
  expect(await failure(expectReplays(givesUp, [waited]))).toContain('(threw): The handler threw after migrations "notify-after-grab"');
  // One that failed or was canceled after its last step: that throw is how it ended.
  for (const outcome of ['failed', 'canceled'] as const) await expectReplays(givesUp, [{ ...waited, outcome }]);
  // A throw before its last recorded step still fails (rule 2).
  expect(await failure(expectReplays(workflows.badStandIn, [{ ...waited, outcome: 'failed' }]))).toContain('(threw): The handler threw before step 2');
  // One that succeeded fails when the handler now passes on a failure (rule 4), which replays otherwise.
  const failedDownload = history([{ step: flows.grab }, { event: 'downloadDone', error: 'the download failed' }]);
  await expectReplays(workflows.current, [failedDownload]);
  expect(await failure(expectReplays(workflows.current, [{ ...failedDownload, outcome: 'success' }]))).toContain(
    '(fails): The run succeeded, but the handler now fails replaying its history: Error: the download failed',
  );
  // An export cut short, or read while its record changed, can't be checked.
  expect(await failure(expectReplays(workflows.current, [{ ...release0Waiting, truncated: true }]))).toContain('(truncated): The export stopped at 2 steps');
  expect(await failure(expectReplays(workflows.current, [{ ...release0Waiting, unstable: true }]))).toContain("(unstable): The run's record changed");
  expect(() => migrate(workflows.current, { ...release0Waiting, truncated: true })).toThrow('(truncated)');
});
