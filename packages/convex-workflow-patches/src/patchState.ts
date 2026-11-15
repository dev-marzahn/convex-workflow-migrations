import type { ComponentApi } from './component/_generated/component.js';
import { isUnreleased } from './testing.ts';

/** The installed patches component, `components.workflowPatches`. */
export type PatchesComponent = ComponentApi;

/**
 * One workflow's patch ids, by the step of "Removing a patch" each is at:
 * `active` ids are called with `patched()`, `deprecated` ids with
 * `deprecatePatch()`, and `retired` ids are no longer called but stay listed,
 * so the id is never reused and the check knows its old branch is gone.
 */
export type PatchDeclaration = {
  readonly active?: readonly string[];
  readonly deprecated?: readonly string[];
  readonly retired?: readonly string[];
};

/** Each workflow's patch ids, keyed by its function name (`dir/file:export`). The default export of `convex/patches.ts`. */
export type DeclaredPatches = Readonly<Record<string, PatchDeclaration>>;

type Marker = { patchId: string; beforeStepId: string };
type Skip = { patchId: string; atStepId: string };

/** A run's records, as the patches component's `runs:load` returns them. */
export type RunRecords = {
  markers: readonly Marker[];
  skips: readonly Skip[];
  run: { workflow: string; known: readonly string[] } | null;
};

/** What a handler run adds to its records; written by the workflow mutation at the end of the run. */
export type RunUpdate = {
  run: { workflow: string; known: string[] };
  markers: Marker[];
  skips: Skip[];
  unskip: string[];
};

/**
 * Patch decisions for one handler run, created fresh by the workflow mutation
 * each time it replays.
 *
 * Every step call gets a position (`seq`) when it is made. Replay matches step
 * calls to journal entries in order, so the call with position n replays
 * journal entry n. A `patched()` call made after n step calls is at the
 * frontier if there's no entry n: this is the first time the run gets here, so
 * the patch is applied and a marker is written before the next step. Otherwise
 * the run has been past this call before, and the answer is whether it took the
 * patch: a marker for the id names an entry in its journal. A run that replays
 * past the call without one passed it on code without the patch, and that is
 * recorded as a skip, with the entry it was decided at.
 */
export class PatchState {
  private readonly journalIds: readonly string[];
  private readonly journal: ReadonlySet<string>;
  private readonly markers = new Map<string, Set<string>>();
  private readonly skips: ReadonlyMap<string, string>;
  private readonly active: ReadonlySet<string>;
  private readonly deprecated: ReadonlySet<string>;
  private readonly retired: ReadonlySet<string>;
  private readonly known: readonly string[];
  private readonly tracked: boolean;
  private readonly decisions = new Map<string, boolean>();
  private readonly pending: { patchId: string; seq: number }[] = [];
  private readonly newMarkers: Marker[] = [];
  private readonly newSkips = new Map<string, string>();
  private readonly unskip = new Set<string>();
  private seq = 0;

  public constructor(
    journal: readonly { _id: string }[],
    records: RunRecords,
    private readonly workflow: string,
    declaration: PatchDeclaration,
  ) {
    // A copy: the executor consumes the array it was given.
    this.journalIds = journal.map((entry) => entry._id);
    this.journal = new Set(this.journalIds);
    for (const { patchId, beforeStepId } of records.markers) {
      let ids = this.markers.get(patchId);
      if (!ids) this.markers.set(patchId, (ids = new Set()));
      ids.add(beforeStepId);
    }
    this.skips = new Map(records.skips.map((skip) => [skip.patchId, skip.atStepId]));
    // Code from a simulated older release doesn't have the unreleased patches.
    const released = (ids: readonly string[] | undefined) => new Set((ids ?? []).filter((id) => !isUnreleased(id)));
    this.active = released(declaration.active);
    this.deprecated = released(declaration.deprecated);
    this.retired = released(declaration.retired);
    this.tracked = records.run?.workflow === workflow;
    this.known = this.tracked ? records.run!.known : [];
  }

  /** Position of the next step call. Called once per step call, at the call site. */
  public nextSeq(): number {
    return this.seq++;
  }

  public patched(id: string): boolean {
    if (!this.active.has(id) && !isUnreleased(id)) throw this.misuse(id, 'patched');
    return this.decision(id);
  }

  public deprecatePatch(id: string): void {
    if (isUnreleased(id)) {
      throw new Error(`deprecatePatch("${id}"): can't simulate a release without this patch; old releases used patched("${id}").`);
    }
    if (!this.deprecated.has(id)) throw this.misuse(id, 'deprecatePatch');
    if (!this.decision(id)) {
      throw new Error(
        `deprecatePatch("${id}"): this run passed this point before the patch was deployed, ` +
          `so it can't replay on code without the old branch. Keep patched("${id}") until such runs have finished.`,
      );
    }
  }

  /**
   * For a batch of newly recorded steps: each patch decided at the frontier
   * gets a marker naming the step whose call came right after it.
   */
  public takeMarkers(seqs: readonly number[], entryIds: readonly string[]): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const { patchId, seq } = this.pending[i]!;
      const index = seqs.indexOf(seq);
      if (index < 0) continue;
      this.newMarkers.push({ patchId, beforeStepId: entryIds[index]! });
      this.pending.splice(i, 1);
    }
  }

  /** What this handler run adds to the run's records, or nothing if it learned nothing new. */
  public update(): RunUpdate | null {
    const known = [...new Set([...this.known, ...this.active, ...this.deprecated, ...this.retired])].sort();
    const knownChanged = known.length !== this.known.length;
    // Every run gets a row on its first handler run, so the check can tell it
    // from runs that haven't run since the app adopted this package.
    if (this.tracked && !knownChanged && this.newMarkers.length === 0 && this.newSkips.size === 0 && this.unskip.size === 0) return null;
    return {
      run: { workflow: this.workflow, known },
      markers: this.newMarkers,
      skips: [...this.newSkips].map(([patchId, atStepId]) => ({ patchId, atStepId })),
      unskip: [...this.unskip],
    };
  }

  /** Patches this run skipped that the running code no longer calls `patched()` for: it needs code that was removed. */
  public removedSkips(): string[] {
    return [...new Set([...this.skips.keys(), ...this.newSkips.keys()])].filter((id) => !this.active.has(id)).sort();
  }

  private decision(id: string): boolean {
    let decision = this.decisions.get(id);
    if (decision === undefined) {
      decision = this.decide(id);
      this.decisions.set(id, decision);
    }
    return decision;
  }

  private decide(id: string): boolean {
    // Code without the patch has no patched() call, so it takes the old path.
    if (isUnreleased(id)) return false;
    if (this.journalIds[this.seq] === undefined) {
      const skippedAt = this.skips.get(id);
      // The run took the old branch at an earlier call site that is still in its journal.
      if (skippedAt !== undefined && this.journal.has(skippedAt)) return false;
      // Frontier. If no step follows (the handler returns), the run is done and
      // never replays, so the unwritten marker is never needed.
      this.pending.push({ patchId: id, seq: this.seq });
      // A restart from before the point where the run skipped brings it back here.
      if (skippedAt !== undefined) this.unskip.add(id);
      return true;
    }
    for (const stepId of this.markers.get(id) ?? []) if (this.journal.has(stepId)) return true;
    if (!this.skips.has(id)) this.newSkips.set(id, this.journalIds[this.seq]!);
    return false;
  }

  private misuse(id: string, call: 'patched' | 'deprecatePatch'): Error {
    const workflow = this.workflow;
    if (this.retired.has(id))
      return new Error(`Workflow patch "${id}" is retired for ${workflow}: remove the ${call}("${id}") call. A retired id can't be used again.`);
    if (call === 'patched' && this.deprecated.has(id)) {
      return new Error(`Workflow patch "${id}" is deprecated for ${workflow}: call deprecatePatch("${id}") instead of patched().`);
    }
    if (call === 'deprecatePatch' && this.active.has(id)) {
      return new Error(`Workflow patch "${id}" is active for ${workflow}: move it to "deprecated" in convex/patches.ts to call deprecatePatch().`);
    }
    return new Error(`Workflow patch "${id}" isn't declared for ${workflow}. Add it to the workflow's entry in convex/patches.ts.`);
  }
}
