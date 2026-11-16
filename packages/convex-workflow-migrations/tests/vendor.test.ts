// @vitest-environment node
// The vendored client must be exactly the installed @convex-dev/workflow
// release plus upstream.diff. This catches an upstream bump without
// re-vendoring, and a change to the copy that the diff doesn't record. The
// file list and the diff come from scripts/vendor.ts, which re-vendors.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vite-plus/test';

import { diffVendored, FILES, upstreamDir, upstreamVersion, VENDOR } from '../../../scripts/vendor.ts';

const PACKAGE = join(import.meta.dirname, '..');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;

test('the installed @convex-dev/workflow is the version the copy was made from', () => {
  const pinned = json(join(PACKAGE, 'package.json')).peerDependencies['@convex-dev/workflow'];
  expect(upstreamVersion()).toBe(pinned);
});

test('the vendored files are upstream plus upstream.diff', () => {
  const work = mkdtempSync(join(tmpdir(), 'convex-workflow-migrations-vendor-'));
  try {
    for (const [name, source] of Object.entries(FILES)) copyFileSync(join(upstreamDir(), source), join(work, name));
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

test('upstream.diff is what `bun run vendor diff` writes', () => {
  expect(diffVendored()).toBe(readFileSync(join(VENDOR, 'upstream.diff'), 'utf8'));
});
