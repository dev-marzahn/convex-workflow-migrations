// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { collect, convexDirOf, DEFAULT_COMPONENT_PATHS } from '../src/predeploy.ts';

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
const collectFrom = (root: string) => collect({ projectRoot: root, convexDir: convexDirOf(root) });

test('reads the default export of convex/patches.ts', async () => {
  const root = project({ 'convex/patches.ts': "export default { 'pipeline:run': { active: ['notify'], retired: ['old'] } } as const;\n" });
  expect(await collectFrom(root)).toEqual({
    declared: { 'pipeline:run': { active: ['notify'], retired: ['old'] } },
    componentPaths: DEFAULT_COMPONENT_PATHS,
  });
});

test('reads where the components are mounted from componentPaths', async () => {
  const root = project({ 'convex/patches.ts': "export const componentPaths = { patches: 'wfPatches' };\nexport default {};\n" });
  expect((await collectFrom(root)).componentPaths).toEqual({ workflow: 'workflow', patches: 'wfPatches' });
});

test("follows convex.json's functions directory", async () => {
  const root = project({ 'convex.json': '{ "functions": "src/convex" }', 'src/convex/patches.ts': "export default { 'a:b': {} };\n" });
  expect((await collectFrom(root)).declared).toEqual({ 'a:b': {} });
});

test('declares nothing without the file', async () => {
  expect(await collectFrom(project({ 'convex/schema.ts': 'export default {};\n' }))).toEqual({ declared: {}, componentPaths: DEFAULT_COMPONENT_PATHS });
});

test('rejects a malformed file', async () => {
  const declared = project({ 'convex/patches.ts': "export default { 'pipeline:run': ['notify'] };\n" });
  await expect(collectFrom(declared)).rejects.toThrow('must export default an object of workflow names to { active, deprecated, retired }');
  const twice = project({ 'convex/patches.ts': "export default { 'pipeline:run': { active: ['notify'], retired: ['notify'] } };\n" });
  await expect(collectFrom(twice)).rejects.toThrow('pipeline:run lists "notify" more than once');
  const paths = project({ 'convex/patches.ts': "export const componentPaths = { workpool: 'x' };\nexport default {};\n" });
  await expect(collectFrom(paths)).rejects.toThrow('may only set "workflow" and "patches"');
});

test('the check module imports only node: built-ins, so convex-release can run it alone', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/predeploy.ts'), 'utf8');
  const imports = [...source.matchAll(/^import (type )?[^;]*? from '([^']+)';$/gms)].filter(([, type]) => !type).map(([, , from]) => from!);
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.filter((from) => !from.startsWith('node:'))).toEqual([]);
});
