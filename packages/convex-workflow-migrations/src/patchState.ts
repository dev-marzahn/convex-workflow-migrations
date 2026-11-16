import type { ComponentApi } from './component/_generated/component.js';
import { isUnreleased } from './testing.ts';

/** The installed patches component, `components.workflowMigrations`. */
export type PatchesComponent = ComponentApi;

/** The patch ids each workflow declares, keyed by its function name (`dir/file:export`). See `convex/patches.ts`. */
export type DeclaredPatches = Readonly<Record<string, readonly string[]>>;

type Marker = { patchId: string; beforeStepId: string };

/** A run's records, as the patches component's `runs:load` returns them. */
export type RunRecords = {
  markers: readonly Marker[];
  skips: readonly string[];
  run: { workflow: string; known: readonly string[] } | null;
  /** The patch ids declared by the code that ran this workflow function last. */
  deployed: readonly string[] | null;
};

/** What a handler run adds to its records; written by the workflow mutation at the end of the run. */
export type RunUpdate = {
  run: { workflow: string; known: string[] };
  markers: Marker[];
  skips: string[];
  unskip: string[];
  /** Set when the running code declares other patch ids than the code that ran this workflow function last. */
  deployed?: string[];
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
 * recorded as a skip.
 */
export class PatchState {
  private readonly journalIds: readonly string[];
  private readonly journal: ReadonlySet<string>;
  private readonly markers = new Map<string, Set<string>>();
  private readonly skips: ReadonlySet<string>;
  private readonly declared: ReadonlySet<string>;
  private readonly known: readonly string[];
  private readonly deployed: readonly string[] | null;
  private readonly decisions = new Map<string, boolean>();
  private readonly pending: { patchId: string; seq: number }[] = [];
  private readonly newMarkers: Marker[] = [];
  private readonly newSkips = new Set<string>();
  private readonly unskip = new Set<string>();
  private seq = 0;

  public constructor(
    journal: readonly { _id: string }[],
    records: RunRecords,
    private readonly workflow: string,
    declared: readonly string[],
  ) {
    // A copy: the executor consumes the array it was given.
    this.journalIds = journal.map((entry) => entry._id);
    this.journal = new Set(this.journalIds);
    for (const { patchId, beforeStepId } of records.markers) {
      let ids = this.markers.get(patchId);
      if (!ids) this.markers.set(patchId, (ids = new Set()));
      ids.add(beforeStepId);
    }
    this.skips = new Set(records.skips);
    // Code from a simulated older release doesn't have the unreleased patches.
    this.declared = new Set(declared.filter((id) => !isUnreleased(id)));
    this.known = records.run?.workflow === workflow ? records.run.known : [];
    this.deployed = records.deployed;
  }

  /** Position of the next step call. Called once per step call, at the call site. */
  public nextSeq(): number {
    return this.seq++;
  }

  public patched(id: string): boolean {
    let decision = this.decisions.get(id);
    if (decision === undefined) {
      decision = this.decide(id);
      this.decisions.set(id, decision);
    }
    return decision;
  }

  public deprecatePatch(id: string): void {
    if (isUnreleased(id)) {
      throw new Error(`deprecatePatch("${id}"): can't simulate a release without this patch; old releases used patched("${id}").`);
    }
    if (!this.patched(id)) {
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
    const known = [...new Set([...this.known, ...this.declared])].sort();
    const declared = [...this.declared].sort();
    const deployedChanged = this.deployed?.join('\n') !== declared.join('\n');
    const knownChanged = known.length !== this.known.length;
    if (!knownChanged && !deployedChanged && this.newMarkers.length === 0 && this.newSkips.size === 0 && this.unskip.size === 0) return null;
    return {
      run: { workflow: this.workflow, known },
      markers: this.newMarkers,
      skips: [...this.newSkips],
      unskip: [...this.unskip],
      ...(deployedChanged ? { deployed: declared } : {}),
    };
  }

  /** Patches this run skipped that the running code no longer declares: it needs code that was removed. */
  public removedSkips(): string[] {
    return [...new Set([...this.skips, ...this.newSkips])].filter((id) => !this.declared.has(id)).sort();
  }

  private decide(id: string): boolean {
    // Code without the patch has no patched() call, so it takes the old path.
    if (isUnreleased(id)) return false;
    if (!this.declared.has(id)) {
      throw new Error(`Workflow patch "${id}" isn't declared for ${this.workflow}. Add it to the workflow's entry in convex/patches.ts.`);
    }
    if (this.journalIds[this.seq] === undefined) {
      // Frontier. If no step follows (the handler returns), the run is done and
      // never replays, so the unwritten marker is never needed.
      this.pending.push({ patchId: id, seq: this.seq });
      // A restart from before this point can bring a skipped run back here.
      if (this.skips.has(id)) this.unskip.add(id);
      return true;
    }
    for (const stepId of this.markers.get(id) ?? []) if (this.journal.has(stepId)) return true;
    if (!this.skips.has(id)) this.newSkips.add(id);
    return false;
  }
}
