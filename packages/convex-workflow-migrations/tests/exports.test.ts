// @vitest-environment node
// Every upstream export is re-exported, replaced or left out on purpose.
// Values are checked at runtime; types don't exist then, so their names are
// read from upstream's declarations and this package's source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as upstream from '@convex-dev/workflow';
import { expect, test } from 'vite-plus/test';

import * as ours from '../src/index.ts';

/** Upstream exports this package replaces with its own. */
const REPLACED = ['WorkflowManager'];
/** Upstream exports left out, and why. */
const LEFT_OUT = {
  defineWorkflow: "its workflows can't migrate or pause; use workflow.define",
  cancel: "doesn't end a pause; use workflow.cancel",
  restart: 'takes a journal position, not one in the migrated history; use workflow.restart',
  cleanup: "leaves the run's record behind; use workflow.cleanup",
};

const UPSTREAM_TYPES = join(import.meta.dirname, '../node_modules/@convex-dev/workflow/dist/client/index.d.ts');
const OURS = join(import.meta.dirname, '../src/index.ts');

/** Every name a module's source or declarations export, types included. */
function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const [, list] of source.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
    for (const item of list!.split(',')) {
      const name = item
        .trim()
        .replace(/^type /, '')
        .split(/\s+as\s+/)
        .at(-1)!
        .trim();
      if (name) names.add(name);
    }
  }
  for (const [, name] of source.matchAll(/^export (?:declare )?(?:type|interface|class|function|const|abstract class) (\w+)/gm)) names.add(name!);
  return names;
}

test('every upstream value export is re-exported, replaced or left out', () => {
  const missing = Object.keys(upstream).filter((name) => !(name in ours) && !(name in LEFT_OUT));
  expect(missing).toEqual([]);
  for (const name of Object.keys(LEFT_OUT)) expect(name in ours, name).toBe(false);
  for (const name of REPLACED) expect((ours as Record<string, unknown>)[name]).not.toBe((upstream as Record<string, unknown>)[name]);
});

test('every upstream type export is re-exported or left out', () => {
  const names = exportedNames(readFileSync(OURS, 'utf8'));
  const upstreamNames = [...exportedNames(readFileSync(UPSTREAM_TYPES, 'utf8'))];
  expect(upstreamNames.length).toBeGreaterThan(10);
  expect(upstreamNames.filter((name) => !names.has(name) && !(name in LEFT_OUT))).toEqual([]);
});
