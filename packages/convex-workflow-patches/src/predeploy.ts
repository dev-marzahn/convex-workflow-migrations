// The predeploy check: which running workflows need code the release about to
// be deployed removes.
//
// This file is convex-release's predeploy check module for this package (see
// `convex-release.predeploy` in package.json), and the CLI's `check` command
// runs the same code through `convex run`. convex-release runs it on its own,
// without node_modules, so it must only import `node:` built-ins; type imports
// are erased by the build.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DeclaredPatches } from './patchState.ts';

/** The version of convex-release's check module interface this file implements. */
export const protocol = 1;

/** The `code` a query rejects with when its component isn't deployed. */
export const COMPONENT_NOT_DEPLOYED = 'COMPONENT_NOT_DEPLOYED';

/** Where the two components are mounted. */
export type ComponentPaths = { workflow: string; patches: string };

export const DEFAULT_COMPONENT_PATHS: ComponentPaths = { workflow: 'workflow', patches: 'workflowPatches' };

/** What the release about to be deployed declares: read from its source by `collect`. */
export type Facts = { declared: DeclaredPatches; componentPaths: ComponentPaths };

/**
 * Calls a query on the deployment. Rejects with `code: 'COMPONENT_NOT_DEPLOYED'`
 * when the target component isn't deployed.
 */
export type Query = <T>(target: { componentPath?: string; path: string }, args?: object) => Promise<T>;

/** A running workflow and its records, as the patches component's `runs:lookup` returns them. */
export type RunInput = {
  workflowId: string;
  run: { workflow: string; known: readonly string[] } | null;
  skips: readonly string[];
};

export type Blocker =
  /** The run passed the patch point on code without the patch. */
  | { workflowId: string; workflow: string; patchId: string; reason: 'skipped' }
  /** The run hasn't run on code with the patch since before it shipped, so it may have passed the point without it. */
  | { workflowId: string; workflow: string; patchId: string; reason: 'waiting' }
  /** The run hasn't run since this package was adopted, so nothing is known about it. */
  | { workflowId: string; reason: 'untracked' };

export type CheckResult = {
  /** Per workflow, the patch ids the deployed release declares and the new one doesn't. */
  removed: Record<string, string[]>;
  blockers: Blocker[];
};

// --------------------------------------------------------------- collect ---

/**
 * The release's declarations: the default export of `patches.ts` in its
 * functions folder, and where its optional `componentPaths` export says the
 * components are mounted. No file declares nothing.
 */
export async function collect({ convexDir }: { projectRoot?: string; convexDir: string }): Promise<Facts> {
  const file = ['ts', 'js', 'mjs'].map((ext) => join(convexDir, `patches.${ext}`)).find((path) => existsSync(path));
  if (!file) return { declared: {}, componentPaths: DEFAULT_COMPONENT_PATHS };
  const module = (await import(pathToFileURL(file).href)) as { default?: unknown; componentPaths?: unknown };
  const declared = module.default;
  const validDeclared =
    typeof declared === 'object' &&
    declared !== null &&
    Object.values(declared).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'));
  if (!validDeclared) throw new Error(`${file} must export default an object of workflow names to arrays of patch ids.`);
  const paths = module.componentPaths ?? {};
  const validPaths =
    typeof paths === 'object' &&
    paths !== null &&
    Object.entries(paths).every(([key, value]) => (key === 'workflow' || key === 'patches') && typeof value === 'string' && value !== '');
  if (!validPaths) throw new Error(`${file}'s componentPaths export may only set "workflow" and "patches", each to a component path.`);
  return { declared: declared as DeclaredPatches, componentPaths: { ...DEFAULT_COMPONENT_PATHS, ...(paths as Partial<ComponentPaths>) } };
}

/** The app's functions folder: `functions` in convex.json, or `convex`. */
export function convexDirOf(projectRoot: string): string {
  const config = join(projectRoot, 'convex.json');
  const functions = existsSync(config) ? (JSON.parse(readFileSync(config, 'utf8')) as { functions?: string }).functions : undefined;
  return join(projectRoot, functions ?? 'convex');
}

// ----------------------------------------------------------------- check ---

/**
 * Reads the deployment and decides which running workflows block the release
 * `facts` describe. Null when the patches component isn't deployed yet: then
 * nothing the deployment runs can need a removed patch.
 */
export async function inspect(facts: Facts, query: Query, pageSize = 100): Promise<CheckResult | null> {
  const { workflow, patches } = facts.componentPaths;
  let rows: { workflow: string; declared: string[] }[];
  try {
    rows = await query({ componentPath: patches, path: 'runs:deployed' });
  } catch (error) {
    if ((error as { code?: unknown }).code === COMPONENT_NOT_DEPLOYED) return null;
    throw error;
  }
  const deployed = Object.fromEntries(rows.map((row) => [row.workflow, row.declared]));
  // Nothing removed: skip reading every running workflow.
  if (Object.keys(evaluate(facts.declared, deployed, []).removed).length === 0) return { removed: {}, blockers: [] };

  const running: RunInput[] = [];
  let cursor: string | null = null;
  do {
    type Page = { page: { workflowId: string; runResult?: unknown }[]; isDone: boolean; continueCursor: string };
    const page: Page = await query({ componentPath: workflow, path: 'workflow:list' }, { order: 'asc', paginationOpts: { cursor, numItems: pageSize } });
    const ids = page.page.filter((run) => run.runResult === undefined).map((run) => run.workflowId);
    if (ids.length > 0) running.push(...(await query<RunInput[]>({ componentPath: patches, path: 'runs:lookup' }, { workflowIds: ids })));
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  return evaluate(facts.declared, deployed, running);
}

/**
 * Decides which running workflows block a release.
 *
 * @param declared - What the new release declares (`collect`).
 * @param deployed - What the deployed release declares, as the patches component recorded it the last time it ran each workflow.
 * @param running - The running workflows and their records.
 */
export function evaluate(declared: DeclaredPatches, deployed: DeclaredPatches, running: readonly RunInput[]): CheckResult {
  const removed: Record<string, string[]> = {};
  for (const [workflow, ids] of Object.entries(deployed)) {
    const keep = new Set(declared[workflow] ?? []);
    const gone = ids.filter((id) => !keep.has(id));
    if (gone.length > 0) removed[workflow] = [...gone].sort();
  }
  const anyRemoved = Object.keys(removed).length > 0;
  const blockers: Blocker[] = [];
  for (const { workflowId, run, skips } of running) {
    if (!run) {
      if (anyRemoved) blockers.push({ workflowId, reason: 'untracked' });
      continue;
    }
    for (const patchId of removed[run.workflow] ?? []) {
      if (skips.includes(patchId)) blockers.push({ workflowId, workflow: run.workflow, patchId, reason: 'skipped' });
      else if (!run.known.includes(patchId)) blockers.push({ workflowId, workflow: run.workflow, patchId, reason: 'waiting' });
    }
  }
  return { removed, blockers };
}

// ---------------------------------------------------------------- output ---

/** One line per workflow that loses patches, e.g. `pipeline:run removes "notify".` */
export function describeRemovals(removed: CheckResult['removed']): string[] {
  return Object.entries(removed).map(([workflow, ids]) => `${workflow} removes ${ids.map((id) => `"${id}"`).join(', ')}.`);
}

export function describeBlocker(blocker: Blocker): string {
  switch (blocker.reason) {
    case 'skipped':
      return `${blocker.workflowId} (${blocker.workflow}) passed "${blocker.patchId}" without the patch`;
    case 'waiting':
      return `${blocker.workflowId} (${blocker.workflow}) has been waiting since before "${blocker.patchId}" shipped`;
    case 'untracked':
      return `${blocker.workflowId} hasn't run since this package was adopted`;
  }
}

export const blockedMessage = (blockers: readonly Blocker[]) =>
  `${blockers.length} running workflow${blockers.length === 1 ? '' : 's'} still need${blockers.length === 1 ? 's' : ''} code this release removes`;

/** convex-release's entry point: runs against the deployment before anything is pushed. */
export async function check({
  facts,
  query,
  log,
}: {
  facts: unknown;
  query: Query;
  log: (message: string) => void;
}): Promise<{ ok: true } | { ok: false; message: string; details: string[] }> {
  const result = await inspect(facts as Facts, query);
  if (!result) {
    log(`The deployment has no ${(facts as Facts).componentPaths.patches} component yet, so no running workflow can need a removed patch.`);
    return { ok: true };
  }
  for (const line of describeRemovals(result.removed)) log(line);
  if (result.blockers.length === 0) return { ok: true };
  return { ok: false, message: blockedMessage(result.blockers), details: result.blockers.map(describeBlocker) };
}
