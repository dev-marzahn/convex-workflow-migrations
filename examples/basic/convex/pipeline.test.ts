// @vitest-environment node
// Histories the older releases recorded, replayed against the current code
// with the helpers from /replay: no Convex backend, no convex-test, and no
// Vitest configuration needed.
import { expectReplays, history, migrate } from '@dev-marzahn/convex-workflow-migrations/replay';
import { makeFunctionReference } from 'convex/server';
import { expect, test } from 'vite-plus/test';

import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { run } from './pipeline';

// Built by hand, as the older releases recorded them.
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
  await expectReplays(run, [release0.waiting, release0.preparing, release2Waiting]);
});

test('a run from release 0 gets a stand-in notify and imports without a time', () => {
  const migrated = migrate(run, release0.preparing);
  expect(migrated.steps.map((step) => step.name)).toEqual(['pipeline:grab', 'pipeline:notify', 'downloadDone', 'pipeline:importFiles', 'pipeline:transcode']);
  expect(migrated.steps[3]?.args).toEqual({ grabId, notifiedAt: null });
});
