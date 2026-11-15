#!/usr/bin/env node
// convex-workflow-patches drain: a deploy gate for removing a patch's old branch.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `Usage: convex-workflow-patches drain --workflow <name> --patch <id> [--patch <id> ...] [--function <name>] [-- <convex run options>]

Lists the running workflows that may still need the code path without each
patch, and exits 1 if there are any. Run it against the deployed code before
you deploy code that removes a patch's old branch.

  --workflow  The workflow function, as Convex names it: pipeline:run
  --patch     A patch id. Repeat for several.
  --function  The app's drain query (workflow.drainQuery()). Default: patches:drain

Options after -- go to \`convex run\`, e.g. -- --prod.
Exit codes: 0 nothing waiting, 1 runs waiting, 2 usage or deployment error.`;

type DrainOptions = {
  /** The app's drain query. */
  fn: string;
  /** The workflow function's name. */
  workflow: string;
  /** Options passed on to `convex run`. */
  convexArgs: string[];
};

type Page = { page: string[]; isDone: boolean; continueCursor: string };

class UsageError extends Error {}

/** The app's installed `convex` CLI, so `convex run` uses its deployment config. */
function convexBin(): string {
  try {
    return join(dirname(createRequire(join(process.cwd(), 'package.json')).resolve('convex/package.json')), 'bin', 'main.js');
  } catch {
    throw new Error("The `convex` package isn't installed here. Run this from your app's directory.");
  }
}

function runDrainQuery({ fn, workflow, convexArgs }: DrainOptions, patchId: string, cursor: string | null): Page {
  const result = spawnSync(process.execPath, [convexBin(), 'run', fn, JSON.stringify({ workflow, patchId, cursor }), ...convexArgs], { encoding: 'utf8' });
  if (result.status !== 0) {
    const out = `${result.stdout}\n${result.stderr}`.trim();
    if (/Could not find (public )?function/i.test(out)) {
      throw new Error(
        `${fn} isn't deployed. Export \`workflow.drainQuery()\` from convex/patches.ts as \`drain\` (or pass --function), deploy it, then run this again.`,
      );
    }
    throw new Error(`convex run ${fn} failed:\n${out}`);
  }
  try {
    return JSON.parse(result.stdout) as Page;
  } catch {
    throw new Error(`convex run ${fn} didn't print a drain query result:\n${result.stdout.trim()}`);
  }
}

/** Every running workflow without a marker for `patchId`, across all pages. */
function waitingRuns(options: DrainOptions, patchId: string): string[] {
  const runs: string[] = [];
  let cursor: string | null = null;
  do {
    const page = runDrainQuery(options, patchId, cursor);
    runs.push(...page.page);
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  return runs;
}

function drain(argv: string[]): number {
  const split = argv.indexOf('--');
  const { values } = parseArgs({
    args: split < 0 ? argv : argv.slice(0, split),
    options: {
      workflow: { type: 'string' },
      patch: { type: 'string', multiple: true },
      function: { type: 'string', default: 'patches:drain' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const { workflow, patch: patches = [] } = values;
  if (!workflow || patches.length === 0) throw new UsageError('drain needs --workflow and at least one --patch.');
  const options: DrainOptions = { fn: values.function, workflow, convexArgs: split < 0 ? [] : argv.slice(split + 1) };

  let waiting = 0;
  for (const patchId of patches) {
    const runs = waitingRuns(options, patchId);
    if (runs.length === 0) {
      console.log(`${patchId}: no running ${workflow} workflow needs the code path without it.`);
      continue;
    }
    waiting += runs.length;
    console.log(`${patchId}: ${runs.length} running ${workflow} workflow(s) may still need the code path without it:`);
    for (const id of runs) console.log(`  ${id}`);
  }
  return waiting > 0 ? 1 : 0;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  try {
    if (command !== 'drain') throw new UsageError(`Unknown command "${command}".`);
    return drain(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) console.error(`\n${USAGE}`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
