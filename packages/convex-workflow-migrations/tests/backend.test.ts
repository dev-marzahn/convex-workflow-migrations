// @vitest-environment node
// The e2e tests' backend is the one convex-release pins. CONTRIBUTING.md
// records that pin, with the convex-release version it's from, so a bump of
// one without the other fails here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vite-plus/test';

const ROOT = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

test("e2e/backend.ts pins the backend image CONTRIBUTING.md names as convex-release's", () => {
  const pinned = /^export const BACKEND_IMAGE = '([^']+)';$/m.exec(read('e2e/backend.ts'))?.[1];
  expect(pinned).toMatch(/^ghcr\.io\/convex\/convex-backend:[0-9a-f]{40}$/);
  const section = read('CONTRIBUTING.md').split('## Backend version')[1]!.split('\n## ')[0]!;
  expect(section).toMatch(/from convex-release \d+\.\d+\.\d+/);
  expect([...section.matchAll(/ghcr\.io\/convex\/convex-backend:\w+/g)].map((m) => m[0])).toEqual([pinned]);
});
