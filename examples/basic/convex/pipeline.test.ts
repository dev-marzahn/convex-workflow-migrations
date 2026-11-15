/// <reference types="vite/client" />
import patchesTest, { simulateDeploy } from '@dev-marzahn/convex-workflow-patches/test';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { api } from './_generated/api';
import schema from './schema';

const modules = import.meta.glob('./**/*.ts');
const release1 = { without: ['notify-after-grab', 'prepare-before-publish'] };

function setup() {
  const t = convexTest(schema, modules);
  patchesTest.register(t);
  return t;
}
type T = ReturnType<typeof setup>;
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const log = (t: T, grabId: Awaited<ReturnType<typeof startGrab>>['grabId']) => t.run(async (ctx) => (await ctx.db.get('grabs', grabId))?.log);
async function startGrab(t: T) {
  const ids = await t.mutation(api.pipeline.startGrab, { title: 'Some Show S01E01' });
  await settle(t);
  return ids;
}

beforeEach(() => {
  vi.useFakeTimers();
  simulateDeploy();
});
afterEach(() => vi.useRealTimers());

test('a grab waiting for its download when release 2 ships gets prepare but not notify', async () => {
  const t = setup();
  simulateDeploy(release1);
  const { grabId, workflowId } = await startGrab(t);
  expect(await log(t, grabId)).toEqual(['grab']);

  simulateDeploy(); // release 2
  await t.mutation(api.pipeline.downloadDone, { workflowId });
  await settle(t);
  expect(await log(t, grabId)).toEqual(['grab', 'import', 'prepare', 'publish']);
});

test('a grab started on release 2 runs every step', async () => {
  const t = setup();
  const { grabId, workflowId } = await startGrab(t);
  await t.mutation(api.pipeline.downloadDone, { workflowId });
  await settle(t);
  expect(await log(t, grabId)).toEqual(['grab', 'notify', 'import', 'prepare', 'publish']);
});
