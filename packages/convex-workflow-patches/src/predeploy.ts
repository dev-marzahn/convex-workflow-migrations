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

import type { PredeployCheckContext, PredeployCollectContext, PredeployResult } from '@dev-marzahn/convex-release';

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

/** Calls a query on the deployment, as convex-release's `query` does. */
export type Query = PredeployCheckContext['query'];

/** A running workflow and its records, as the patches component's `runs:lookup` returns them. */
export type RunInput = {
  workflowId: string;
  /** The workflow component's name for the run: its function name, or a child workflow's step name. */
  name?: string;
  run: { workflow: string; known: readonly string[] } | null;
  took: readonly string[];
  skips: readonly string[];
};

export type Blocker =
  /** The run passed the patch point on code without the patch. */
  | { workflowId: string; workflow: string; patchId: string; reason: 'skipped' }
  /** The run hasn't run on code that declares the patch, so it may have passed the point without it. */
  | { workflowId: string; workflow: string; patchId: string; reason: 'waiting' }
  /** The run recorded a patch this release doesn't declare: a rollback, or a retired id deleted from patches.ts. */
  | { workflowId: string; workflow: string; patchId: string; reason: 'unknown' }
  /** The run hasn't run since this package was adopted, so nothing is known about it. */
  | { workflowId: string; workflow: string; reason: 'untracked' };

export type CheckResult = {
  /** Per workflow, the ids whose old branch this release no longer has: deprecated and retired. */
  gone: Record<string, string[]>;
  /** Per workflow, ids that runs recorded and this release doesn't declare at all. */
  unknown: Record<string, string[]>;
  blockers: Blocker[];
};

// --------------------------------------------------------------- collect ---

const STATES = ['active', 'deprecated', 'retired'] as const;

/**
 * The release's declarations: the default export of `patches.ts` (or `.js`,
 * `.mjs`) in its functions folder, and where its optional `componentPaths`
 * export says the components are mounted. No file declares nothing.
 */
export async function collect({ convexDir }: Pick<PredeployCollectContext, 'convexDir'> & Partial<PredeployCollectContext>): Promise<Facts> {
  const file = ['ts', 'js', 'mjs'].map((ext) => join(convexDir, `patches.${ext}`)).find((path) => existsSync(path));
  if (!file) return { declared: {}, componentPaths: DEFAULT_COMPONENT_PATHS };
  const module = (await import(pathToFileURL(file).href)) as { default?: unknown; componentPaths?: unknown };
  const declared = module.default;
  const isIds = (ids: unknown) => Array.isArray(ids) && ids.every((id) => typeof id === 'string');
  const validDeclared =
    typeof declared === 'object' &&
    declared !== null &&
    Object.values(declared).every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        Object.entries(entry).every(([state, ids]) => (STATES as readonly string[]).includes(state) && isIds(ids)),
    );
  if (!validDeclared) {
    throw new Error(`${file} must export default an object of workflow names to { active, deprecated, retired } arrays of patch ids.`);
  }
  for (const [workflow, entry] of Object.entries(declared as DeclaredPatches)) {
    const ids = STATES.flatMap((state) => entry[state] ?? []);
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (repeated.length > 0) throw new Error(`${file}: ${workflow} lists ${[...new Set(repeated)].map((id) => `"${id}"`).join(', ')} more than once.`);
  }
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
  let rows: { workflow: string; patchIds: string[] }[];
  try {
    rows = await query({ componentPath: patches, path: 'runs:recorded' });
  } catch (error) {
    if ((error as { code?: unknown }).code === COMPONENT_NOT_DEPLOYED) return null;
    throw error;
  }
  const recorded = Object.fromEntries(rows.map((row) => [row.workflow, row.patchIds]));
  // Nothing gone and nothing unknown: skip reading every running workflow.
  const empty = evaluate(facts.declared, recorded, []);
  if (Object.keys(empty.gone).length === 0 && Object.keys(empty.unknown).length === 0) return empty;

  const running: RunInput[] = [];
  let cursor: string | null = null;
  do {
    type Page = { page: { workflowId: string; name?: string; runResult?: unknown }[]; isDone: boolean; continueCursor: string };
    const page: Page = await query({ componentPath: workflow, path: 'workflow:list' }, { order: 'asc', paginationOpts: { cursor, numItems: pageSize } });
    const unfinished = page.page.filter((run) => run.runResult === undefined);
    if (unfinished.length > 0) {
      const names = new Map(unfinished.map((run) => [run.workflowId, run.name]));
      const found = await query<RunInput[]>({ componentPath: patches, path: 'runs:lookup' }, { workflowIds: [...names.keys()] });
      running.push(...found.map((run) => ({ ...run, name: names.get(run.workflowId) })));
    }
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  return evaluate(facts.declared, recorded, running);
}

/**
 * Decides which running workflows block a release.
 *
 * @param declared - What the new release declares (`collect`).
 * @param recorded - Per workflow, every patch id its runs have taken or skipped.
 * @param running - The unfinished workflows and their records.
 */
export function evaluate(declared: DeclaredPatches, recorded: Readonly<Record<string, readonly string[]>>, running: readonly RunInput[]): CheckResult {
  const gone: Record<string, string[]> = {};
  const unknown: Record<string, string[]> = {};
  for (const [workflow, entry] of Object.entries(declared)) {
    const ids = [...(entry.deprecated ?? []), ...(entry.retired ?? [])];
    if (ids.length > 0) gone[workflow] = [...ids].sort();
  }
  for (const [workflow, ids] of Object.entries(recorded)) {
    const entry = declared[workflow] ?? {};
    const mentioned = new Set(STATES.flatMap((state) => entry[state] ?? []));
    const missing = ids.filter((id) => !mentioned.has(id));
    if (missing.length > 0) unknown[workflow] = [...missing].sort();
  }

  const blockers: Blocker[] = [];
  for (const { workflowId, name, run, took, skips } of running) {
    if (!run) {
      // Only the workflow component's name is known: a function name, unless a parent started it under a custom one.
      if (name !== undefined && (gone[name] || unknown[name])) blockers.push({ workflowId, workflow: name, reason: 'untracked' });
      continue;
    }
    const { workflow } = run;
    for (const patchId of gone[workflow] ?? []) {
      if (skips.includes(patchId)) blockers.push({ workflowId, workflow, patchId, reason: 'skipped' });
      else if (!run.known.includes(patchId)) blockers.push({ workflowId, workflow, patchId, reason: 'waiting' });
    }
    for (const patchId of unknown[workflow] ?? []) {
      if (took.includes(patchId) || skips.includes(patchId)) blockers.push({ workflowId, workflow, patchId, reason: 'unknown' });
    }
  }
  return { gone, unknown, blockers };
}

// ---------------------------------------------------------------- output ---

export function describeBlocker(blocker: Blocker): string {
  const run = `${blocker.workflowId} (${blocker.workflow})`;
  switch (blocker.reason) {
    case 'skipped':
      return `${run} passed "${blocker.patchId}" without the patch`;
    case 'waiting':
      return `${run} has been waiting since before "${blocker.patchId}" shipped`;
    case 'unknown':
      return `${run} recorded "${blocker.patchId}", which this release doesn't declare (a rollback, or a retired id deleted from convex/patches.ts)`;
    case 'untracked':
      return `${run} hasn't run since this package was adopted`;
  }
}

export const blockedMessage = (blockers: readonly Blocker[]) => {
  const runs = new Set(blockers.map((b) => b.workflowId)).size;
  return `${runs} running workflow${runs === 1 ? '' : 's'} still need${runs === 1 ? 's' : ''} code this release removes`;
};

/** convex-release's entry point: runs against the deployment before anything is pushed. */
export async function check(ctx: PredeployCheckContext): Promise<PredeployResult> {
  const facts = ctx.facts as Facts;
  const result = await inspect(facts, (target, args) => ctx.query(target, args));
  if (!result) {
    ctx.log(`The deployment has no ${facts.componentPaths.patches} component yet, so no running workflow can need a removed patch.`);
    return { ok: true };
  }
  if (result.blockers.length === 0) return { ok: true };
  return { ok: false, message: blockedMessage(result.blockers), details: result.blockers.map(describeBlocker) };
}
