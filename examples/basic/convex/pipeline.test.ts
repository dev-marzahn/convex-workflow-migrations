/// <reference types="vite/client" />
import patchesTest, { expectReplays, history, migrate } from '@dev-marzahn/convex-workflow-patches/test';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

function setup() {
  const t = convexTest(schema, modules);
  patchesTest.register(t);
  return t;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Histories the older releases recorded, as `npx convex-workflow-patches
// histories pipeline:run` exports them, or built by hand.
const grabId = 'k57' as Id<'grabs'>;
const prepare = makeFunctionReference<'mutation'>('pipeline:prepare');
const release0 = {
  waiting: history(
    [
      { step: internal.pipeline.grab, args: { grabId } },
      { event: 'downloadDone', status: 'running' },
    ],
    { args: { grabId } },
  ),
  preparing: history(
    [
      { step: internal.pipeline.grab, args: { grabId } },
      { event: 'downloadDone' },
      { step: internal.pipeline.importFiles, args: { grabId } },
      { step: prepare, args: { grabId } },
    ],
    { args: { grabId } },
  ),
};
const release2Waiting = history(
  [
    { step: internal.pipeline.grab, args: { grabId } },
    { step: internal.pipeline.notify, args: { grabId }, result: { at: 1700000000000 } },
    { event: 'downloadDone', status: 'running' },
  ],
  { args: { grabId }, applied: ['notify-after-grab', 'import-gets-notified-at'] },
);

test('runs from every older release replay on the current code', async () => {
  await expectReplays(setup(), internal.pipeline.run, [release0.waiting, release0.preparing, release2Waiting]);
});

test('a run from release 0 gets a stand-in notify and imports without a time', async () => {
  const migrated = await migrate(setup(), internal.pipeline.run, release0.preparing);
  expect(migrated.steps.map((step) => step.name)).toEqual(['pipeline:grab', 'pipeline:notify', 'downloadDone', 'pipeline:importFiles', 'pipeline:transcode']);
  expect(migrated.steps[3]?.args).toEqual({ grabId, notifiedAt: null });
});

test('a grab started on the current release runs every step', async () => {
  const t = setup();
  const { grabId, workflowId } = await t.mutation(api.pipeline.startGrab, { title: 'Some Show S01E01' });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.mutation(api.pipeline.downloadDone, { workflowId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await t.run((ctx) => ctx.db.get('grabs', grabId)))?.log).toEqual(['grab', 'notify', 'import', 'transcode', 'publish']);
});
