#!/usr/bin/env node
// convex-workflow-migrations histories: exports a workflow's run histories
// from a deployment as JSON, for expectReplays() in /test. Run it from the
// app's directory; it reads through `convex run`.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { collectRuns, type Components, MAX_RUNS, MAX_SCAN, type Query, readRuns } from './histories.ts';
import type { RecordedHistory } from './history.ts';
import { type Redact, redactHistory } from './redact.ts';

const USAGE = `Usage: convex-workflow-migrations histories <workflow> [options] [-- <convex options>]

Exports the histories of a workflow's running runs, and of its most recent
finished ones, as JSON: the input for expectReplays() from
@dev-marzahn/convex-workflow-migrations/test. <workflow> is the workflow's
function name, like pipeline:run. Run it from your app's directory.

The export holds production data: every run's args, every step's args,
result and error, and each record's overlay (stand-ins' args and results,
rewritten args and results, migrated workflow args). Check it, or scrub it
with --redact, before you commit it.

It lists the running runs from this package's component, which has a record
of every run started since the app adopted the package. Runs from before
then may have none, so it also looks through those, oldest first, finished
ones included. Without the component deployed, every run is from before.

  --recent <n>                     Finished runs to export too, the newest among
                                   the newest 1000 runs. Default: 10
  --max-runs <n>                   Running runs from before the app adopted the
                                   package to export, oldest first, at least 1.
                                   If more are running, it exports nothing and
                                   exits with 1. Default: ${MAX_RUNS}
  --max-scan <n>                   Runs from before the app adopted the package
                                   to read, finished ones included, at least 1.
                                   If there are more, it exports nothing and
                                   exits with 1: clean up the finished ones, or
                                   raise it. Default: ${MAX_SCAN}
  --allow-partial                  Export anyway when --max-runs or --max-scan
                                   stopped it: newer running runs from before
                                   then are missing.
  --max-steps <n>                  Steps to export per run, at least 1. A longer
                                   run is exported up to there, with
                                   "truncated": true. Default: 1000
  --redact <module>                A module whose default export takes each step,
                                   each run's args and the overlay's data,
                                   { kind, name, args, result?, error? }, and
                                   returns them scrubbed. kind is "run" for a
                                   run's args. It's loaded with import(), so a
                                   .ts module works on Node's type stripping
                                   (erasable syntax only).
  --out <file>                     Write the JSON to <file> instead of stdout.
  --workflow-component <name>      Where @convex-dev/workflow is mounted. Default: workflow
  --migrations-component <name>    Where this package's component is mounted. Default: workflowMigrations

Options after -- go to every \`convex\` command it runs, e.g. -- --prod. It
runs three \`convex run\` commands per exported run, so it's slow for many runs.
A record that a newer version of this package wrote stops the export.
Exit codes: 0 exported, 1 stopped by --max-runs or --max-scan, 2 usage or
deployment error, or a record from a newer version.`;

const WARNING =
  "The export holds production data: every run's args, every step's args, result and error, and each record's overlay (stand-ins, rewritten args and results, migrated workflow args). Check it before you commit it, or scrub it with --redact.";

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

const count = (value: string, option: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${option} must be a whole number.`);
  return n;
};

async function loadRedact(path: string): Promise<Redact> {
  const module = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown };
  if (typeof module.default !== 'function') throw new UsageError(`--redact ${path}: the module's default export must be a function.`);
  return module.default as Redact;
}

async function histories(argv: string[]): Promise<number> {
  const split = argv.indexOf('--');
  const { values, positionals } = parseArgs({
    args: split < 0 ? argv : argv.slice(0, split),
    allowPositionals: true,
    options: {
      recent: { type: 'string', default: '10' },
      'max-runs': { type: 'string', default: String(MAX_RUNS) },
      'max-scan': { type: 'string', default: String(MAX_SCAN) },
      'allow-partial': { type: 'boolean', default: false },
      'max-steps': { type: 'string', default: '1000' },
      redact: { type: 'string' },
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
  if (maxRuns < 1) throw new UsageError('--max-runs must be at least 1.');
  const maxScan = count(values['max-scan'], 'max-scan');
  if (maxScan < 1) throw new UsageError('--max-scan must be at least 1.');
  const maxSteps = count(values['max-steps'], 'max-steps');
  if (maxSteps < 1) throw new UsageError('--max-steps must be at least 1.');
  const redact = values.redact === undefined ? undefined : await loadRedact(values.redact);
  const convexArgs = split < 0 ? [] : argv.slice(split + 1);
  const query = cliQuery(convexArgs);
  const workflowComponent = values['workflow-component'];
  const migrationsComponent = values['migrations-component'];

  const deployed = isDeployed(migrationsComponent, convexArgs);
  if (!deployed) console.error(`The ${migrationsComponent} component isn't deployed: every run counts as one from before the app adopted this package.`);
  const components: Components = { workflow: workflowComponent, ...(deployed ? { migrations: migrationsComponent } : {}) };
  const collected = collectRuns(query, components, name, { maxRuns, maxScan, recent });
  const { scanned, stopped, last } = collected;
  if (stopped) {
    const created =
      last && query<{ workflow: { _creationTime: number } }>(workflowComponent, 'workflow:getStatus', { workflowId: last }).workflow._creationTime;
    const until = created ? `, up to one created ${new Date(created).toISOString()}` : '';
    console.error(
      stopped === 'max-runs'
        ? `${name} has more running runs from before the app adopted this package than --max-runs ${maxRuns}. The export looked at the oldest ${scanned}${until}, so newer running runs from before then are missing.`
        : `${name} has more runs from before the app adopted this package than --max-scan ${maxScan}, finished ones included. The export looked at the oldest ${scanned}${until}, so running runs among newer ones from before then may be missing. Cleaning up the finished ones (workflow.cleanup) makes the scan shorter.`,
    );
    if (!values['allow-partial']) {
      console.error(`Nothing was exported. Raise --${stopped}, or pass --allow-partial to export these anyway.`);
      return 1;
    }
  }

  const { histories: read, finishedLive } = readRuns(query, components, name, collected, maxSteps);
  if (finishedLive > 0) {
    console.error(
      `${finishedLive} of the runs the ${migrationsComponent} component lists as running had finished: upstream's component finished them past the manager. Each cost this export three reads; finished runs are exported only among the --recent ones.`,
    );
  }
  const exported: RecordedHistory[] = [];
  for (const history of read) exported.push(redact ? await redactHistory(history, redact) : history);
  const json = `${JSON.stringify(exported, null, 2)}\n`;
  if (values.out) {
    writeFileSync(values.out, json);
    console.error(`Wrote ${exported.length} histories of ${name} to ${values.out}.`);
  } else {
    process.stdout.write(json);
  }
  console.error(redact ? `Scrubbed with ${values.redact}. Check the export before you commit it.` : WARNING);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  try {
    if (command !== 'histories') throw new UsageError(`Unknown command "${command}".`);
    return await histories(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) console.error(`\n${USAGE}`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
