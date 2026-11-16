// What the `histories` CLI reads from a deployment, through a `convex run`
// per query: which runs to export, and each run's history. Kept apart from
// src/cli.ts, which runs on import, so tests can drive it with a fake query.
import { FORMAT, isWorkflowNotFound } from './component/schema.ts';
import type { OverlayOp, RecordedHistory } from './history.ts';
import { recordedStep } from './migrations.ts';
import type { JournalEntry, RunResult } from './vendor/workflow/types.ts';

/** Runs a query of a component and returns its result. */
export type Query = <T>(component: string, path: string, args: object) => T;

/** Where the components are mounted; `migrations` is left out when this package's isn't deployed. */
export type Components = { workflow: string; migrations?: string };

type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
export type PublicWorkflow = { workflowId: string; name?: string; args: unknown; runResult?: RunResult };
type RunRecord = { applied?: string[]; overlay: OverlayOp[]; restart?: string; format: number } | null;
type Journal = { workflow: { _creationTime: number; args: unknown; runResult?: RunResult }; journalEntries: JournalEntry[]; ok: boolean };

/** How many of a workflow's newest runs `collectRuns` looks through for its finished ones. */
export const RECENT_SCAN = 1000;
/** How many times `runHistory` reads a run whose record keeps changing before it marks the export `unstable`. */
export const READS = 3;
/** The default of `--max-runs`: how many running runs from before adoption the export takes. */
export const MAX_RUNS = 1000;
/** The default of `--max-scan`: how many runs from before adoption, finished ones included, the export reads. */
export const MAX_SCAN = 10_000;

export type Collected = {
  /** The runs that were running when it looked: every live run with a record, and the running runs from before adoption among the ones it scanned. */
  running: string[];
  /** The runs the migrations component listed as live, all among `running`. */
  live: string[];
  /** The newest `recent` finished runs. */
  finished: string[];
  /** How many runs from before adoption it read, oldest first, finished ones included. */
  scanned: number;
  /**
   * Which limit stopped the scan of runs from before adoption before the
   * first run this package started, if one did: `max-runs`, more of them are
   * running than `maxRuns`; `max-scan`, there are more of them than
   * `maxScan`. Running ones among the rest are missing.
   */
  stopped?: 'max-runs' | 'max-scan';
  /** The newest run from before adoption it read. */
  last?: string;
};

/**
 * The runs of workflow `name` to export. The running ones come from the
 * migrations component, which marks every run this package started as live
 * until it finishes. Runs from before the app adopted this package may have
 * no record, so it also scans upstream's runs oldest first, up to the first
 * one this package started: it takes at most `maxRuns` running ones, and
 * reads at most `maxScan` runs, finished ones included. Exactly as many as a
 * limit isn't more: it reads one more run to tell. The finished ones are the
 * newest `recent` among the newest `RECENT_SCAN` runs.
 */
export function collectRuns(
  query: Query,
  components: Components,
  name: string,
  { maxRuns, maxScan = MAX_SCAN, recent }: { maxRuns: number; maxScan?: number; recent: number },
): Collected {
  const running = new Set<string>();
  if (components.migrations !== undefined) {
    for (let cursor: string | null = null; ;) {
      const page: Page<string> = query(components.migrations, 'runs:live', { workflow: name, paginationOpts: { numItems: 100, cursor } });
      for (const workflowId of page.page) running.add(workflowId);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  const live = [...running];

  // Upstream has no index by status, so this pages through the runs from before adoption.
  let scanned = 0;
  let runningBefore = 0;
  let stopped: Collected['stopped'];
  let last: string | undefined;
  scan: for (let cursor: string | null = null; ;) {
    const numItems = Math.min(100, maxScan + 1 - scanned);
    const page: Page<PublicWorkflow> = query(components.workflow, 'workflow:listByName', { name, order: 'asc', paginationOpts: { numItems, cursor } });
    const ids = page.page.map((run) => run.workflowId);
    const origins: { workflowId: string; origin: string }[] =
      components.migrations === undefined || ids.length === 0 ? [] : query(components.migrations, 'runs:origins', { workflowIds: ids });
    const started = new Set(origins.filter((o) => o.origin !== 'adopted').map((o) => o.workflowId));
    for (const run of page.page) {
      // The first run this package started: every later one has a record.
      if (started.has(run.workflowId)) break scan;
      if (scanned === maxScan) {
        stopped = 'max-scan';
        break scan;
      }
      if (run.runResult === undefined) {
        if (runningBefore === maxRuns) {
          stopped = 'max-runs';
          break scan;
        }
        runningBefore++;
        running.add(run.workflowId);
      }
      scanned++;
      last = run.workflowId;
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }

  const finished: string[] = [];
  for (let cursor: string | null = null, looked = 0; finished.length < recent && looked < RECENT_SCAN;) {
    const numItems = Math.min(100, RECENT_SCAN - looked);
    const page: Page<PublicWorkflow> = query(components.workflow, 'workflow:listByName', { name, order: 'desc', paginationOpts: { numItems, cursor } });
    looked += page.page.length;
    for (const run of page.page) if (run.runResult !== undefined && finished.length < recent) finished.push(run.workflowId);
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return { running: [...running], live, finished, scanned, ...(stopped ? { stopped } : {}), ...(last === undefined ? {} : { last }) };
}

/** What `runHistory` read: the history, when the run was created, and whether it has finished. */
export type ReadRun = { history: RecordedHistory; createdAt: number; finished: boolean };

const exported = (record: RunRecord) => JSON.stringify(record && [record.applied, record.overlay, record.restart, record.format]);

/**
 * A run's history: its first `maxSteps` journal entries, read raw with
 * upstream's `journal.load`, marked `truncated` if it has more, and, if its
 * record says, the migrations applied to it, its overlay and a pending
 * `restart`. It reads the record before and after the journal, and again if
 * they differ, up to `READS` times; if they never agree, the history is
 * marked `unstable`. Undefined if the workflow is gone. Throws for a record
 * from a newer version.
 */
export function runHistory(query: Query, components: Components, name: string, workflowId: string, maxSteps: number): ReadRun | undefined {
  const load = (): RunRecord => (components.migrations === undefined ? null : query(components.migrations, 'runs:load', { workflowId }));
  let journal: Journal;
  let record = load();
  let stable = false;
  for (let read = 0; read < READS && !stable; read++) {
    try {
      journal = query(components.workflow, 'journal:load', { workflowId });
    } catch (error) {
      if (isWorkflowNotFound(error, workflowId)) return undefined;
      throw error;
    }
    const after = load();
    stable = exported(after) === exported(record);
    record = after;
  }
  if (record && record.format > FORMAT) {
    throw new Error(
      `Run ${workflowId}'s record has format ${record.format}, from a newer version of @dev-marzahn/convex-workflow-migrations than this one, which reads format ${FORMAT}. Install the version the deployment runs.`,
    );
  }
  const { workflow, journalEntries, ok } = journal!;
  const history: RecordedHistory = {
    workflowId,
    workflow: name,
    args: workflow.args,
    steps: journalEntries.slice(0, maxSteps).map(recordedStep),
    ...(record?.applied === undefined ? {} : { applied: record.applied }),
    ...(record ? { overlay: record.overlay } : {}),
    ...(record?.restart === undefined ? {} : { restart: record.restart }),
    ...(workflow.runResult ? { outcome: workflow.runResult.kind } : {}),
    // The journal is too big to load whole, so there's more of it.
    ...(journalEntries.length > maxSteps || !ok ? { truncated: true } : {}),
    ...(stable ? {} : { unstable: true }),
  };
  return { history, createdAt: workflow._creationTime, finished: workflow.runResult !== undefined };
}

/**
 * The histories to export, newest first: those of the running runs, and of
 * the recent finished ones, each read by `runHistory`. A run listed as
 * running that has finished since is left out unless it's among the recent
 * ones. `finishedLive` counts the runs the migrations component listed as
 * live that had finished: upstream's component finished them past the
 * manager.
 */
export function readRuns(
  query: Query,
  components: Components,
  name: string,
  collected: Pick<Collected, 'running' | 'live' | 'finished'>,
  maxSteps: number,
): { histories: RecordedHistory[]; finishedLive: number } {
  const read: ReadRun[] = [];
  const recent = new Set(collected.finished);
  const live = new Set(collected.live);
  let finishedLive = 0;
  for (const workflowId of new Set([...collected.running, ...collected.finished])) {
    // Three `convex run`s per run: its record, its journal, and its record again.
    const run = runHistory(query, components, name, workflowId, maxSteps);
    if (run?.finished && live.has(workflowId)) finishedLive++;
    // Gone, or listed as running but finished since and not among the recent ones.
    if (run && (!run.finished || recent.has(workflowId))) read.push(run);
  }
  return { histories: read.sort((a, b) => b.createdAt - a.createdAt).map((run) => run.history), finishedLive };
}
