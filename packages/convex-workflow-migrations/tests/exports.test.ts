// @vitest-environment node
// Every upstream export is re-exported, replaced or left out on purpose.
// Values are checked at runtime; types don't exist then, so their names are
// read from upstream's declarations and this package's source. And the
// package's subpaths: /replay needs no Vitest configuration.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import * as upstream from '@convex-dev/workflow';
import { expect, test } from 'vite-plus/test';

import * as replay from '../src/helpers.ts';
import * as ours from '../src/index.ts';
import * as withRegister from '../src/test.ts';

/** Upstream exports this package replaces with its own. */
const REPLACED = ['WorkflowManager'];
/** Upstream exports left out, and why. */
const LEFT_OUT = {
  defineWorkflow: "its workflows can't migrate; use workflow.define",
  restart: 'takes a journal position on a run whose migrations edited its history; use workflow.restart, which refuses that',
  cleanup: "leaves the run's record behind; use workflow.cleanup",
};
/** What the main entry exports besides upstream's names, and what /replay exports, types included. */
const ADDED =
  'History HistoryStep InsertOptions Migration MigrationsComponent PauseInfo PauseReason PausedRun StepArgs StepRef StepResult StepSelector WorkflowManagerOptions migration';
const REPLAY_NAMES = 'History HistoryOptions HistoryStep RecordedHistory RecordedStep StepSpec expectReplays history migrate';

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
  for (const [, name] of source.matchAll(/^export (?:declare )?(?:type|interface|class|function|async function|const|abstract class) (\w+)/gm))
    names.add(name!);
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

const SRC = join(import.meta.dirname, '../src');
const exportsMap = (JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as { exports: Record<string, unknown> }).exports;

test('what each entry adds: the migration API to upstream, the replay helpers in /replay, and only register in /test', () => {
  const upstreamNames = exportedNames(readFileSync(UPSTREAM_TYPES, 'utf8'));
  const added = [...exportedNames(readFileSync(OURS, 'utf8'))].filter((name) => !upstreamNames.has(name) && !(name in upstream));
  expect(added.sort().join(' ')).toBe(ADDED);
  expect(exportsMap['./replay']).toEqual({ types: './dist/helpers.d.ts', default: './dist/helpers.js' });
  expect(Object.keys(replay).sort()).toEqual(['expectReplays', 'history', 'migrate']);
  expect([...exportedNames(readFileSync(join(SRC, 'helpers.ts'), 'utf8'))].sort().join(' ')).toBe(REPLAY_NAMES);
  expect(Object.keys(withRegister).sort()).toEqual(['default', 'register']);
});

/** Every file of this package that `file` imports, and those files' imports, as source paths. */
function importClosure(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(/^(?:import|export)[^'"]*from\s+['"](\.[^'"]+)['"]/gm)) {
    const path = resolve(dirname(file), spec!).replace(/\.js$/, '.ts');
    if (existsSync(path)) importClosure(path, seen);
  }
  return seen;
}

test('/replay imports nothing that needs Vitest configuration: no import.meta.glob, no convex-test, no upstream /test', () => {
  const closure = [...importClosure(join(SRC, 'helpers.ts'))];
  expect(closure.length).toBeGreaterThan(5);
  for (const file of closure) {
    const source = readFileSync(file, 'utf8');
    expect(source, file).not.toMatch(/import\.meta\.glob\(/);
    expect(source, file).not.toMatch(/from ['"]convex-test['"]/);
    expect(source, file).not.toMatch(/from ['"]@convex-dev\/(workflow|workpool)\/test['"]/);
  }
  // The check finds what /test imports.
  const test_ = readFileSync(join(SRC, 'test.ts'), 'utf8');
  expect(test_).toMatch(/import\.meta\.glob\(/);
  expect(test_).toMatch(/from 'convex-test'/);
});
