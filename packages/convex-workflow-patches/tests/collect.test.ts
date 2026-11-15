// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { collect } from '../src/check.ts';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'convex-workflow-patches-collect-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('reads the default export of convex/patches.ts', async () => {
  const root = project({ 'convex/patches.ts': "export default { 'pipeline:run': ['notify'] } satisfies Record<string, readonly string[]>;\n" });
  expect(await collect(root)).toEqual({ 'pipeline:run': ['notify'] });
});

test("follows convex.json's functions directory", async () => {
  const root = project({ 'convex.json': '{ "functions": "src/convex" }', 'src/convex/patches.ts': "export default { 'a:b': [] };\n" });
  expect(await collect(root)).toEqual({ 'a:b': [] });
});

test('declares nothing without the file', async () => {
  expect(await collect(project({ 'convex/schema.ts': 'export default {};\n' }))).toEqual({});
});

test('rejects a malformed file', async () => {
  const root = project({ 'convex/patches.ts': "export default { 'pipeline:run': 'notify' };\n" });
  await expect(collect(root)).rejects.toThrow('must export default an object of workflow names to arrays of patch ids');
});
