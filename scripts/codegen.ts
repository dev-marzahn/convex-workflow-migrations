// Rewrites the Convex `_generated/` folders: the patches component's, the
// example app's and the e2e fixture apps'. Commit them like any Convex
// project.
//
// Component codegen pulls deployment state, so this runs against a throwaway
// backend (e2e/backend.ts). Nothing is deployed there; it's removed after.
//
//   bun run codegen
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startBackend } from '../e2e/backend.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPONENT = join(ROOT, 'packages/convex-workflow-patches/src/component');
const APPS = [join(ROOT, 'examples/basic'), ...readdirSync(join(ROOT, 'e2e/apps')).map((app) => join(ROOT, 'e2e/apps', app))];

function codegen(cwd: string, env: NodeJS.ProcessEnv, args: string[] = []): void {
  console.log(`codegen ${relative(ROOT, cwd)} ${args.join(' ')}`.trim());
  const result = spawnSync(join(cwd, 'node_modules/.bin/convex'), ['codegen', '--typecheck', 'disable', ...args], { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`convex codegen failed in ${relative(ROOT, cwd)}:\n${result.stdout}\n${result.stderr}`);
}

const backend = await startBackend('convex-workflow-patches-codegen');
try {
  codegen(APPS[0]!, backend.env, ['--component-dir', relative(APPS[0]!, COMPONENT)]);
  for (const app of APPS) codegen(app, backend.env);
} finally {
  backend.stop();
}
