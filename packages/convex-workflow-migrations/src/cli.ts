#!/usr/bin/env node
// convex-workflow-migrations histories: exports a workflow's run histories from a
// deployment as JSON, for expectReplays() in /test. Run it from the app's
// directory; it reads through `convex run`.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import type { OverlayOp, RecordedHistory, RecordedStep, RunResult, StepKind } from './history.ts';

const USAGE = `Usage: convex-workflow-migrations histories <workflow> [options] [-- <convex options>]

Exports the histories of a workflow's running runs, and of its most recent
finished ones, as JSON: the input for expectReplays() from
@dev-marzahn/convex-workflow-migrations/test. <workflow> is the workflow's
function name, like pipeline:run. Run it from your app's directory.

  --recent <n>                 Finished runs to export too, newest first. Default: 10
  --max-runs <n>               Runs to look through, newest first. Default: 1000
  --max-steps <n>              Steps to export per run. A longer run is
                               exported up to there, with "truncated": true.
                               Default: 1000
  --out <file>                 Write the JSON to <file> instead of stdout.
  --workflow-component <name>  Where @convex-dev/workflow is mounted. Default: workflow
  --migrations-component <name>   Where this package's component is mounted. Default: workflowMigrations

Options after -- go to every \`convex\` command it runs, e.g. -- --prod.
Exit codes: 0 exported, 2 usage or deployment error.`;

class UsageError extends Error {}

/** The app's installed `convex` CLI, so `convex run` uses its deployment config. */
function convexBin(): string {
  try {
    return join(dirname(createRequire(join(process.cwd(), 'package.json')).resolve('convex/package.json')), 'bin', 'main.js');
  } catch {
    throw new Error("The `convex` package isn't installed here. Run this from your app's directory.");
  }
}

function convex(args: string[], convexArgs: string[]) {
  const result = spawnSync(process.execPath, [convexBin(), ...args, ...convexArgs], { encoding: 'utf8', maxBuffer: 256 << 20 });
  return { ok: result.status === 0, stdout: result.stdout, output: `${result.stdout}\n${result.stderr}`.trim() };
}

type Query = <T>(component: string, path: string, args: object) => T;

function cliQuery(convexArgs: string[]): Query {
  return <T>(component: string, path: string, args: object) => {
    const result = convex(['run', '--component', component, path, JSON.stringify(args)], convexArgs);
    if (!result.ok) throw new Error(`convex run --component ${component} ${path} failed:\n${result.output}`);
    try {
      // `convex run` prints nothing for a null result.
      return (result.stdout.trim() ? JSON.parse(result.stdout) : null) as T;
    } catch {
      throw new Error(`convex run --component ${component} ${path} didn't print JSON:\n${result.stdout.trim()}`);
    }
  };
}

/** Whether a component is deployed. `convex run` against a missing one fails with a generic error; `convex data` names the cause. */
function isDeployed(component: string, convexArgs: string[]): boolean {
  const result = convex(['data', '--component', component], convexArgs);
  if (result.ok) return true;
  if (/Component path '[^']*' not found/.test(result.output)) return false;
  throw new Error(`convex data --component ${component} failed:\n${result.output}`);
}

type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type PublicWorkflow = { workflowId: string; name?: string; args: unknown; runResult?: unknown };
type WorkflowStep = { stepId: string; name: string; kind: StepKind; args: unknown; runResult?: RunResult; startedAt: number };
type RunRecord = { applied: string[]; overlay: OverlayOp[] } | null;

const count = (value: string, option: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${option} must be a whole number.`);
  return n;
};

function histories(argv: string[]): number {
  const split = argv.indexOf('--');
  const { values, positionals } = parseArgs({
    args: split < 0 ? argv : argv.slice(0, split),
    allowPositionals: true,
    options: {
      recent: { type: 'string', default: '10' },
      'max-runs': { type: 'string', default: '1000' },
      'max-steps': { type: 'string', default: '1000' },
      out: { type: 'string' },
      'workflow-component': { type: 'string', default: 'workflow' },
      'migrations-component': { type: 'string', default: 'workflowMigrations' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) throw new UsageError('Pass one workflow function name, like pipeline:run.');
  const recent = count(values.recent, 'recent');
  const maxRuns = count(values['max-runs'], 'max-runs');
  const maxSteps = Math.max(1, count(values['max-steps'], 'max-steps'));
  const convexArgs = split < 0 ? [] : argv.slice(split + 1);
  const query = cliQuery(convexArgs);
  const workflowComponent = values['workflow-component'];
  const migrationsComponent = values['migrations-component'];

  // Upstream has no index by status, so this pages through the runs newest first.
  const runs: PublicWorkflow[] = [];
  let finished = 0;
  let scanned = 0;
  let cursor: string | null = null;
  while (scanned < maxRuns) {
    const numItems = Math.min(100, maxRuns - scanned);
    const result: Page<PublicWorkflow> = query(workflowComponent, 'workflow:listByName', { name, order: 'desc', paginationOpts: { numItems, cursor } });
    scanned += result.page.length;
    for (const run of result.page) {
      if (run.runResult === undefined) runs.push(run);
      else if (finished < recent) {
        finished++;
        runs.push(run);
      }
    }
    if (result.isDone) break;
    cursor = result.continueCursor;
  }

  const records = isDeployed(migrationsComponent, convexArgs);
  const exported = runs.map((run): RecordedHistory => {
    const steps: Page<WorkflowStep> = query(workflowComponent, 'workflow:listSteps', {
      workflowId: run.workflowId,
      order: 'asc',
      paginationOpts: { numItems: maxSteps, cursor: null },
    });
    const record: RunRecord = records ? query(migrationsComponent, 'runs:load', { workflowId: run.workflowId }) : null;
    return {
      workflowId: run.workflowId,
      workflow: name,
      args: run.args,
      steps: steps.page.map((step): RecordedStep => ({
        id: step.stepId,
        name: step.name,
        kind: step.kind,
        args: step.args,
        ...(step.runResult ? { runResult: step.runResult } : {}),
        startedAt: step.startedAt,
      })),
      ...(record ? { applied: record.applied, overlay: record.overlay } : {}),
      ...(steps.isDone ? {} : { truncated: true }),
    };
  });
  const json = `${JSON.stringify(exported, null, 2)}\n`;
  if (values.out) {
    writeFileSync(values.out, json);
    console.error(`Wrote ${exported.length} histories of ${name} to ${values.out}.`);
  } else {
    process.stdout.write(json);
  }
  return 0;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  try {
    if (command !== 'histories') throw new UsageError(`Unknown command "${command}".`);
    return histories(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) console.error(`\n${USAGE}`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
