#!/usr/bin/env node
// The package's bin, `convex-workflow-migrations histories <workflow>`
// (src/histories.ts). It runs the `convex` CLI installed in the app's
// directory, so `convex run` picks the deployment as it always does.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { type Convex, main } from './histories.ts';

const convex: Convex = (args) => {
  let bin: string;
  try {
    bin = join(dirname(createRequire(join(process.cwd(), 'package.json')).resolve('convex/package.json')), 'bin', 'main.js');
  } catch {
    return { ok: false, stdout: '', output: "The `convex` package isn't installed here. Run this from your app's directory." };
  }
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });
  return { ok: result.status === 0, stdout: result.stdout, output: `${result.stdout}\n${result.stderr}`.trim() };
};

process.exitCode = main(process.argv.slice(2), { convex, stdout: (text) => process.stdout.write(text), stderr: (line) => console.error(line) });
