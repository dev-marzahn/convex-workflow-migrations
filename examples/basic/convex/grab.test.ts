/// <reference types="vite/client" />
// The current code from scratch, on convex-test with both components. This
// needs vite.config.ts: the edge-runtime environment, and the packages whose
// test helpers use import.meta.glob inlined, /test among them.
import migrationsTest from '@dev-marzahn/convex-workflow-migrations/test';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');

function setup() {
  const t = convexTest(schema, modules);
  migrationsTest.register(t);
  return t;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('a grab started on the current release runs every step', async () => {
  const t = setup();
  const { grabId, workflowId } = await t.mutation(api.pipeline.startGrab, { title: 'Some Show S01E01' });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.mutation(api.pipeline.downloadDone, { workflowId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await t.run((ctx) => ctx.db.get('grabs', grabId)))?.log).toEqual(['grab', 'notify', 'import', 'transcode', 'publish']);
});
