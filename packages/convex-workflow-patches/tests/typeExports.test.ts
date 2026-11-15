// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vite-plus/test';

// Type exports don't exist at runtime, so exports.test.ts can't see them. This
// reads the names from upstream's declarations and this package's source.
const UPSTREAM = join(import.meta.dirname, '../node_modules/@convex-dev/workflow/dist/client/index.d.ts');
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

test('every upstream type export is re-exported by this package', () => {
  const ours = exportedNames(readFileSync(OURS, 'utf8'));
  const upstream = [...exportedNames(readFileSync(UPSTREAM, 'utf8'))];
  expect(upstream.length).toBeGreaterThan(10);
  // Values are covered by exports.test.ts, which also lists what is left out on purpose.
  const leftOut = ['defineWorkflow', 'cleanup'];
  expect(upstream.filter((name) => !ours.has(name) && !leftOut.includes(name))).toEqual([]);
});
