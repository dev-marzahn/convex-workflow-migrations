import * as upstream from '@convex-dev/workflow';
import { expect, test } from 'vite-plus/test';

import * as ours from '../src/index.ts';

// Upstream exports this package replaces or leaves out on purpose.
const REPLACED = ['WorkflowManager'];
const LEFT_OUT = {
  defineWorkflow: "its workflows can't patch; use workflow.define",
  cleanup: 'leaves patch records behind; use workflow.cleanup',
};

test('every upstream export is re-exported, replaced or deliberately left out', () => {
  const missing = Object.keys(upstream).filter((name) => !(name in ours) && !(name in LEFT_OUT));
  expect(missing).toEqual([]);
  for (const name of Object.keys(LEFT_OUT)) expect(name in ours, name).toBe(false);
  for (const name of REPLACED) expect((ours as Record<string, unknown>)[name]).not.toBe((upstream as Record<string, unknown>)[name]);
});
