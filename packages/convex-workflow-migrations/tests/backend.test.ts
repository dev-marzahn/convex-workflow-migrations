// @vitest-environment node
// The e2e tests' backend is the build convex-release pins and tests against.
// convex-release has no machine-readable pin (not in its package.json, not
// in dist/): its README states it, in the one-shot image's compose example,
// as "the build this version of convex-release pins and tests against". So
// this reads the README of the installed package. Bumping
// @dev-marzahn/convex-release without e2e/backend.ts, or the other way
// round, fails here.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { expect, test } from 'vite-plus/test';

const ROOT = join(import.meta.dirname, '../../..');
const RELEASE = dirname(createRequire(import.meta.url).resolve('@dev-marzahn/convex-release/package.json'));
const read = (path: string) => readFileSync(path, 'utf8');

test('e2e/backend.ts pins the backend build the installed convex-release pins', () => {
  const pinned = /^export const BACKEND_IMAGE = '([^']+)';$/m.exec(read(join(ROOT, 'e2e/backend.ts')))?.[1];
  expect(pinned).toMatch(/^ghcr\.io\/convex\/convex-backend:[0-9a-f]{40}$/);
  const { version } = JSON.parse(read(join(RELEASE, 'package.json'))) as { version: string };
  const readme = read(join(RELEASE, 'README.md'));
  // The README is this version's: it names this version's images.
  expect(readme).toContain(`ghcr.io/dev-marzahn/convex-release-oneshot:${version}`);
  expect(readme).toContain('The backend tag is the build this version of convex-release pins and tests against.');
  const backends = new Set([...readme.matchAll(/ghcr\.io\/convex\/convex-backend:[0-9a-f]+/g)].map((match) => match[0]));
  expect([...backends]).toEqual([pinned]);
});
