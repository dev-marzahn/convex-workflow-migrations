// @vitest-environment node
// The vendored client must be exactly the installed @convex-dev/workflow
// release plus upstream.diff. This catches an upstream bump without
// re-vendoring, and a change to the copy that the diff doesn't record.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(PACKAGE, 'src/vendor/workflow');
const UPSTREAM = dirname(createRequire(import.meta.url).resolve('@convex-dev/workflow/package.json'));

/** Vendored file → its source in the upstream package. Keep in sync with VENDORED.md. */
const FILES: Record<string, string> = {
  'environment.ts': 'src/client/environment.ts',
  'logging.ts': 'src/component/logging.ts',
  'publicTypes.ts': 'src/types.ts',
  'safeFunctionName.ts': 'src/client/safeFunctionName.ts',
  'shared.ts': 'src/shared.ts',
  'step.ts': 'src/client/step.ts',
  'types.ts': 'src/client/types.ts',
  'workflowContext.ts': 'src/client/workflowContext.ts',
  'workflowMutation.ts': 'src/client/workflowMutation.ts',
};

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;

test('the installed @convex-dev/workflow is the version the copy was made from', () => {
  const pinned = json(join(PACKAGE, 'package.json')).peerDependencies['@convex-dev/workflow'];
  expect(json(join(UPSTREAM, 'package.json')).version).toBe(pinned);
});

test('the vendored files are upstream plus upstream.diff', () => {
  const work = mkdtempSync(join(tmpdir(), 'convex-workflow-migrations-vendor-'));
  try {
    for (const [name, source] of Object.entries(FILES)) copyFileSync(join(UPSTREAM, source), join(work, name));
    const patch = spawnSync('patch', ['-s', '-p1', '-d', work], { input: readFileSync(join(VENDOR, 'upstream.diff')), encoding: 'utf8' });
    expect(patch.stderr + patch.stdout).toBe('');
    expect(patch.status).toBe(0);
    for (const name of Object.keys(FILES)) {
      expect(readFileSync(join(VENDOR, name), 'utf8'), name).toBe(readFileSync(join(work, name), 'utf8'));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
