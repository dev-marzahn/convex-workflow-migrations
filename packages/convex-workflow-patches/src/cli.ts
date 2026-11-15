#!/usr/bin/env node
// convex-workflow-patches check: refuses a release that removes code a running
// workflow still needs. Run it from the app's directory before deploying.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { type Blocker, collect, evaluate, type RunInput } from './check.ts';
import type { DeclaredPatches } from './patchState.ts';

const USAGE = `Usage: convex-workflow-patches check [--workflow-component <path>] [--patches-component <path>] [--page-size <n>] [-- <convex run options>]

Compares the patches this checkout declares (convex/patches.ts) with the ones
the deployed release declares, and lists the running workflows that still need
code the checkout removes. Exits 1 if there are any. Run it from your app's
directory, against the deployment you're about to deploy to.

  --workflow-component  Where @convex-dev/workflow is mounted. Default: workflow
  --patches-component   Where this package's component is mounted. Default: workflowPatches
  --page-size           Workflows read per \`convex run\`. Default: 100

Options after -- go to \`convex run\`, e.g. -- --prod.
Exit codes: 0 nothing blocks, 1 running workflows block, 2 usage or deployment error.`;

type Options = { workflowComponent: string; patchesComponent: string; pageSize: number; convexArgs: string[] };
type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };

class UsageError extends Error {}

/** The app's installed `convex` CLI, so `convex run` uses its deployment config. */
function convexBin(): string {
  try {
    return join(dirname(createRequire(join(process.cwd(), 'package.json')).resolve('convex/package.json')), 'bin', 'main.js');
  } catch {
    throw new Error("The `convex` package isn't installed here. Run this from your app's directory.");
  }
}

function convexRun<T>(options: Options, component: string, fn: string, args: object): T {
  const result = spawnSync(process.execPath, [convexBin(), 'run', '--component', component, fn, JSON.stringify(args), ...options.convexArgs], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`convex run --component ${component} ${fn} failed:\n${`${result.stdout}\n${result.stderr}`.trim()}`);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`convex run --component ${component} ${fn} didn't print JSON:\n${result.stdout.trim()}`);
  }
}

/**
 * Whether a component is mounted on the deployment. `convex run` against a
 * missing component fails with a generic server error, but `convex data`
 * names the cause.
 */
function componentExists(options: Options, component: string): boolean {
  const result = spawnSync(process.execPath, [convexBin(), 'data', '--component', component, ...options.convexArgs], { encoding: 'utf8' });
  if (result.status === 0) return true;
  const out = `${result.stdout}\n${result.stderr}`;
  if (/Component path '[^']*' not found/.test(out)) return false;
  throw new Error(`convex data --component ${component} failed:\n${out.trim()}`);
}

/** What the deployed release declares, or nothing if the patches component isn't deployed yet. */
function deployedPatches(options: Options): DeclaredPatches | null {
  // A deployment without the component has no records: nothing it runs can need a removed patch.
  if (!componentExists(options, options.patchesComponent)) return null;
  const rows = convexRun<{ workflow: string; declared: string[] }[]>(options, options.patchesComponent, 'runs:deployed', {});
  return Object.fromEntries(rows.map((row) => [row.workflow, row.declared]));
}

/** Every running workflow and its records, a page at a time. */
function runningWorkflows(options: Options): RunInput[] {
  const running: RunInput[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<{ workflowId: string; runResult?: unknown }> = convexRun(options, options.workflowComponent, 'workflow:list', {
      order: 'asc',
      paginationOpts: { cursor, numItems: options.pageSize },
    });
    const ids = page.page.filter((run) => run.runResult === undefined).map((run) => run.workflowId);
    if (ids.length > 0) running.push(...convexRun<RunInput[]>(options, options.patchesComponent, 'runs:lookup', { workflowIds: ids }));
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  return running;
}

function describe(blocker: Blocker): string {
  switch (blocker.reason) {
    case 'skipped':
      return `${blocker.workflowId} (${blocker.workflow}) passed "${blocker.patchId}" without the patch`;
    case 'waiting':
      return `${blocker.workflowId} (${blocker.workflow}) has been waiting since before "${blocker.patchId}" shipped`;
    case 'untracked':
      return `${blocker.workflowId} hasn't run since this package was adopted`;
  }
}

async function check(argv: string[]): Promise<number> {
  const split = argv.indexOf('--');
  const { values } = parseArgs({
    args: split < 0 ? argv : argv.slice(0, split),
    options: {
      'workflow-component': { type: 'string', default: 'workflow' },
      'patches-component': { type: 'string', default: 'workflowPatches' },
      'page-size': { type: 'string', default: '100' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const pageSize = Number(values['page-size']);
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new UsageError('--page-size must be a positive whole number.');
  const options: Options = {
    workflowComponent: values['workflow-component'],
    patchesComponent: values['patches-component'],
    pageSize,
    convexArgs: split < 0 ? [] : argv.slice(split + 1),
  };

  const declared = await collect(process.cwd());
  const deployed = deployedPatches(options);
  if (!deployed) {
    console.log(`The deployment has no ${options.patchesComponent} component yet, so no running workflow can need a removed patch.`);
    return 0;
  }
  const { removed, blockers } = evaluate(declared, deployed, runningWorkflows(options));
  const removals = Object.entries(removed);
  if (removals.length === 0) {
    console.log('This release removes no patches.');
    return 0;
  }
  for (const [workflow, ids] of removals) console.log(`${workflow} removes ${ids.map((id) => `"${id}"`).join(', ')}.`);
  if (blockers.length === 0) {
    console.log('No running workflow needs the removed code.');
    return 0;
  }
  console.log(`${blockers.length} running workflow(s) still need code this release removes:`);
  for (const blocker of blockers) console.log(`  ${describe(blocker)}`);
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  try {
    if (command !== 'check') throw new UsageError(`Unknown command "${command}".`);
    return await check(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) console.error(`\n${USAGE}`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
