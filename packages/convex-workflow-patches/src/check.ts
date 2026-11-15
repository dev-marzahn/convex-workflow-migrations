// The predeploy check: which running workflows need code the release about to
// be deployed removes. `collect` reads the release's declarations from the
// checkout; `evaluate` decides from the deployment's records. The CLI's
// `check` command wires them to a deployment; convex-release's predeploy hook
// can use the same two halves.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DeclaredPatches } from './patchState.ts';

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

/** The patch ids the release in `projectRoot` declares: the default export of `convex/patches.ts`, if it has one. */
export async function collect(projectRoot: string): Promise<DeclaredPatches> {
  const file = ['ts', 'js', 'mjs'].map((ext) => join(projectRoot, functionsDir(projectRoot), `patches.${ext}`)).find((path) => existsSync(path));
  if (!file) return {};
  const declared = ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
  const valid =
    typeof declared === 'object' &&
    declared !== null &&
    Object.values(declared).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'));
  if (!valid) throw new Error(`${file} must export default an object of workflow names to arrays of patch ids.`);
  return declared as DeclaredPatches;
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

/** The app's functions directory: `functions` in convex.json, or `convex`. */
function functionsDir(projectRoot: string): string {
  const config = join(projectRoot, 'convex.json');
  if (!existsSync(config)) return 'convex';
  return (JSON.parse(readFileSync(config, 'utf8')) as { functions?: string }).functions ?? 'convex';
}
