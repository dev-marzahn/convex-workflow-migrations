// The CLI's `histories` command (the bin is src/cli.ts): exports a workflow's
// run histories from a deployment as JSON, for `expectReplays`. It reads
// through the app's `convex run`, which `main` takes as `io.convex`, so tests
// drive it with a fake deployment.
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import type { OverlayOp, RecordedHistory } from './history.ts';
import { recordedStep } from './migrations.ts';
import type { JournalEntry, RunResult } from './vendor/workflow/types.ts';

/** Runs the app's `convex` CLI with `args`: whether it exited with 0, its stdout, and stdout and stderr for an error. */
export type Convex = (args: string[]) => { ok: boolean; stdout: string; output: string };
/** Runs a query of a component and returns its result. */
type Query = <T>(component: string, path: string, args: object) => T;
/** Where the components are mounted; `migrations` is left out when this package's component isn't deployed. */
type Components = { workflow: string; migrations?: string };

type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type RunRecord = { applied: string[]; overlay: OverlayOp[] } | null;
type Journal = { workflow: { args: unknown }; journalEntries: JournalEntry[]; ok: boolean };

/** How many times `runHistory` reads a run whose record keeps changing before it marks the history `unstable`. */
export const READS = 3;

/** The runs to export, newest first, and how many runs the scan read. `stopped`: it read `maxScan` and there were more; `oldest` is the last it read. */
type Collected = { workflowIds: string[]; scanned: number; stopped: boolean; oldest?: string };

/**
 * The runs of workflow `name` to export: every running one, and the newest
 * `recent` that succeeded. A run that failed or was canceled never replays
 * again, and its history may not replay on the current handler. Upstream has
 * no index by status, so it pages through the workflow's runs newest first,
 * reading at most `maxScan`. Exactly `maxScan` runs isn't more: it asks for
 * one more to tell.
 */
function collectRuns(query: Query, component: string, name: string, { recent, maxScan }: { recent: number; maxScan: number }): Collected {
  const workflowIds: string[] = [];
  let [scanned, succeeded, oldest] = [0, 0, undefined as string | undefined];
  for (let cursor: string | null = null; ;) {
    const paginationOpts = { numItems: Math.min(100, maxScan + 1 - scanned), cursor };
    const page: Page<{ workflowId: string; runResult?: RunResult }> = query(component, 'workflow:listByName', { name, order: 'desc', paginationOpts });
    for (const run of page.page) {
      if (scanned === maxScan) return { workflowIds, scanned, stopped: true, ...(oldest ? { oldest } : {}) };
      [scanned, oldest] = [scanned + 1, run.workflowId];
      if (run.runResult === undefined) workflowIds.push(run.workflowId);
      else if (run.runResult.kind === 'success' && succeeded++ < recent) workflowIds.push(run.workflowId);
    }
    if (page.isDone) return { workflowIds, scanned, stopped: false, ...(oldest ? { oldest } : {}) };
    cursor = page.continueCursor;
  }
}

/** Whether `error` is upstream's for a run that's gone, as `convex run` reports it. */
const isNotFound = (error: unknown, workflowId: string) => error instanceof Error && error.message.includes(`Workflow not found: ${workflowId}`);

const sameRecord = (a: RunRecord, b: RunRecord) => JSON.stringify(a && [a.applied, a.overlay]) === JSON.stringify(b && [b.applied, b.overlay]);

/**
 * A run's history: its first `maxSteps` journal entries, read raw with
 * upstream's `journal.load`, marked `truncated` if there are more, and its
 * record's `applied` and `overlay` if it has one. The record is read before
 * and after the journal, up to `READS` times until the two reads agree; if
 * they never do, the history is `unstable`.
 * `gone` if the run is gone, and `tooBig` if its journal is too big to load
 * (over 8 MiB), which upstream fails at the run's next handler run.
 */
function runHistory(query: Query, components: Components, workflowId: string, maxSteps: number): RecordedHistory | 'gone' | 'tooBig' {
  const load = (): RunRecord => (components.migrations === undefined ? null : query(components.migrations, 'runs:load', { workflowId }));
  let [record, stable, journal] = [load(), false, undefined as Journal | undefined];
  for (let read = 0; read < READS && !stable; read++) {
    try {
      journal = query(components.workflow, 'journal:load', { workflowId });
    } catch (error) {
      if (isNotFound(error, workflowId)) return 'gone';
      throw error;
    }
    if (!journal!.ok) return 'tooBig';
    const after = load();
    [stable, record] = [sameRecord(record, after), after];
  }
  const { workflow, journalEntries } = journal!;
  return {
    workflowId,
    args: workflow.args,
    steps: journalEntries.slice(0, maxSteps).map(recordedStep),
    ...(record ? { applied: record.applied, overlay: record.overlay } : {}),
    ...(journalEntries.length > maxSteps ? { truncated: true } : {}),
    ...(stable ? {} : { unstable: true }),
  };
}

const USAGE = `Usage: convex-workflow-migrations histories <workflow> [options] [-- <convex options>]

Exports the histories of a workflow's running runs, paused ones included, and
of its newest succeeded ones, as JSON RecordedHistory[]: the input for
expectReplays() from @dev-marzahn/convex-workflow-migrations/replay.
<workflow> is the workflow's function path, like pipeline:run (not
internal.pipeline.run). Run it from your app's directory: it runs the app's
\`convex\` CLI, so the usual environment (.env.local, CONVEX_DEPLOY_KEY,
CONVEX_SELF_HOSTED_*) picks the deployment. Options after -- go to every
\`convex\` command it runs, \`convex run\` and \`convex data\`: pass only ones
that select the deployment (--prod, --deployment, --deployment-name,
--preview-name, --env-file, --url with --admin-key).

  --recent <n>        Succeeded runs to export too, the newest by creation
                      time. Failed and canceled runs never replay, so it
                      leaves them out. Default: 10
  --max-scan <n>      Runs to read, newest first, finished ones included, at
                      least 1. If there are more, running runs older than
                      those may be missing: it exports nothing and exits
                      with 1. Default: 10000
  --allow-partial     Export anyway when --max-scan stopped the scan. The
                      file doesn't say the export is partial.
  --max-steps <n>     Steps to export per run, at least 1. A longer run is cut
                      there and marked "truncated". Default: 1000
  --out <file>        Write the JSON to <file> instead of stdout, creating
                      its directory, which is checked before the scan.
  --workflow-component <name>    Default: workflow
  --migrations-component <name>  Default: workflowMigrations. If it isn't
                      deployed, it exits with 2, unless --before-adoption.
  --before-adoption   The app hasn't adopted this package yet, so there's no
                      migrations component: every run is exported without
                      "applied", as a run from before adoption. If the
                      component is deployed, it exits with 2.

It runs a few \`convex run\` commands per exported run, so it's slow for many.
A run whose journal is too big to load (over 8 MiB) is left out, with a note.

Exit codes:
  0  exported, also a partial export with --allow-partial
  1  stopped by --max-scan, without --allow-partial
  2  a usage, deployment or file-write error, or no runs of that name`;

const WARNING =
  "The export holds production data: every run's args, and every step's args, result and error, and each record's overlay. Check it before you commit it.";

class UsageError extends Error {}

const count = (value: string, option: string, min: number) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${option} must be a whole number, at least ${min}.`);
  return n;
};

/**
 * `convex run` as a `Query`. Its JSON output encodes Convex values as
 * `convexToJson` does (an int64 as `{ $integer }`), and the result isn't
 * decoded: the export keeps that encoding, marked `encoding: 'json'`, and
 * `/replay` decodes it.
 */
function cliQuery(convex: Convex): Query {
  return <T>(component: string, path: string, args: object) => {
    const result = convex(['run', '--component', component, path, JSON.stringify(args)]);
    if (!result.ok) throw new Error(`convex run --component ${component} ${path} failed:\n${result.output}`);
    // `convex run` prints nothing for a null result.
    return (result.stdout.trim() ? JSON.parse(result.stdout) : null) as T;
  };
}

/** Whether a component is deployed. `convex run` against a missing one fails with a generic error; `convex data` names the cause. */
function isDeployed(convex: Convex, component: string): boolean {
  const result = convex(['data', '--component', component]);
  if (result.ok) return true;
  if (/Component path '[^']*' not found/.test(result.output)) return false;
  throw new Error(`convex data --component ${component} failed:\n${result.output}`);
}

function histories(argv: string[], io: Io): number {
  const split = argv.indexOf('--');
  const { values, positionals } = parseArgs({
    args: split < 0 ? argv : argv.slice(0, split),
    allowPositionals: true,
    options: {
      recent: { type: 'string', default: '10' },
      'max-scan': { type: 'string', default: '10000' },
      'allow-partial': { type: 'boolean', default: false },
      'max-steps': { type: 'string', default: '1000' },
      out: { type: 'string' },
      'workflow-component': { type: 'string', default: 'workflow' },
      'migrations-component': { type: 'string', default: 'workflowMigrations' },
      'before-adoption': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) throw new UsageError('Pass one workflow function name, like pipeline:run.');
  const [recent, maxScan, maxSteps] = [count(values.recent, 'recent', 0), count(values['max-scan'], 'max-scan', 1), count(values['max-steps'], 'max-steps', 1)];
  const convexArgs = split < 0 ? [] : argv.slice(split + 1);
  const convex: Convex = (args) => io.convex([...args, ...convexArgs]);
  const query = cliQuery(convex);

  if (values.out !== undefined) {
    // Now, not after the scan.
    mkdirSync(dirname(values.out), { recursive: true });
    accessSync(dirname(values.out), constants.W_OK);
  }

  const components: Components = { workflow: values['workflow-component'] };
  const migrations = values['migrations-component'];
  const deployed = isDeployed(convex, migrations);
  if (deployed && values['before-adoption'])
    throw new Error(`The ${migrations} component is deployed, so the app has adopted this package: drop --before-adoption.`);
  if (deployed) components.migrations = migrations;
  else if (values['before-adoption'])
    io.stderr(`The ${migrations} component isn't deployed: every run is exported without "applied", as a run from before the app adopted this package.`);
  else
    throw new Error(
      `The ${migrations} component isn't deployed. If this package's component is mounted under another name, pass --migrations-component <name>; if the app hasn't adopted this package yet, pass --before-adoption.`,
    );

  const collected = collectRuns(query, components.workflow, name, { recent, maxScan });
  if (collected.scanned === 0) throw new Error(`No runs named ${name}; the name is the function's path, e.g. \`pipeline:run\`.`);
  if (collected.stopped) {
    let created = '';
    try {
      const status = query<{ workflow: { _creationTime: number } }>(components.workflow, 'workflow:getStatus', { workflowId: collected.oldest });
      created = `, the oldest created ${new Date(status.workflow._creationTime).toISOString()}`;
    } catch (error) {
      // Cleaned up since the scan read it.
      if (!isNotFound(error, collected.oldest!)) throw error;
    }
    io.stderr(
      `${name} has more than --max-scan ${maxScan} runs. The export read the newest ${collected.scanned}${created}, so older running runs may be missing.`,
    );
    if (!values['allow-partial']) {
      io.stderr('Nothing was exported. Raise --max-scan, or pass --allow-partial to export these anyway.');
      return 1;
    }
  }
  const [exported, tooBig] = [[] as RecordedHistory[], [] as string[]];
  for (const workflowId of collected.workflowIds) {
    const history = runHistory(query, components, workflowId, maxSteps);
    if (history === 'tooBig') tooBig.push(workflowId);
    else if (history !== 'gone') exported.push({ ...history, encoding: 'json' });
  }
  if (tooBig.length > 0)
    io.stderr(
      `Skipped ${tooBig.length} runs whose journal is over 8 MiB, too big to load; upstream fails a running one at its next handler run: ${tooBig.join(', ')}.`,
    );
  const json = `${JSON.stringify(exported, null, 2)}\n`;
  if (values.out === undefined) io.stdout(json);
  else writeFileSync(values.out, json);
  io.stderr(`Exported ${exported.length} histories of ${name}${values.out === undefined ? '' : ` to ${values.out}`}.`);
  io.stderr(WARNING);
  return 0;
}

/** What the CLI reads and writes through: the app's `convex` CLI, stdout, and a line of stderr. */
export type Io = { convex: Convex; stdout: (text: string) => void; stderr: (line: string) => void };

/** Runs the CLI with `argv` (without node and the script) and returns its exit code. */
export function main(argv: string[], io: Io): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  try {
    if (command !== 'histories') throw new UsageError(`Unknown command "${command}".`);
    return histories(rest, io);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) io.stderr(`\n${USAGE}`);
    return 2;
  }
}
