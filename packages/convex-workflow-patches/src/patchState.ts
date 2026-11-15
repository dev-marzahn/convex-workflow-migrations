import type { ComponentApi } from './component/_generated/component.js';
import { isUnreleased } from './testing.js';

/** The installed marker component, `components.workflowPatches`. */
export type PatchesComponent = ComponentApi;

type Marker = { patchId: string; beforeStepId: string };

/**
 * Patch decisions for one handler run, created fresh by the workflow mutation
 * each time it replays.
 *
 * Every step call gets a position (`seq`) when it is made. Replay matches step
 * calls to journal entries in order, so the call with position n replays
 * journal entry n. A `patched()` call made after n step calls sits just before
 * entry n: if entry n exists, the run has been here before and the marker
 * decides; if not, this is the frontier and the patch is applied.
 */
export class PatchState {
  private readonly journalIds: readonly string[];
  private readonly markers = new Map<string, Set<string>>();
  private readonly decisions = new Map<string, boolean>();
  private readonly pending: { patchId: string; seq: number }[] = [];
  private seq = 0;

  public constructor(journal: readonly { _id: string }[], markers: readonly Marker[]) {
    // A copy: the executor consumes the array it was given.
    this.journalIds = journal.map((entry) => entry._id);
    for (const { patchId, beforeStepId } of markers) {
      let ids = this.markers.get(patchId);
      if (!ids) this.markers.set(patchId, (ids = new Set()));
      ids.add(beforeStepId);
    }
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
   * Markers to write for a batch of newly recorded steps: each patch decided
   * at the frontier attaches to the step whose call came right after it.
   */
  public takeMarkers(seqs: readonly number[], entryIds: readonly string[]): Marker[] {
    const taken: Marker[] = [];
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const { patchId, seq } = this.pending[i]!;
      const index = seqs.indexOf(seq);
      if (index < 0) continue;
      taken.push({ patchId, beforeStepId: entryIds[index]! });
      this.pending.splice(i, 1);
    }
    return taken;
  }

  private decide(id: string): boolean {
    if (isUnreleased(id)) return false;
    const next = this.journalIds[this.seq];
    if (next === undefined) {
      // Frontier. If no step follows (the handler returns), the run is done and
      // never replays, so the unwritten marker is never needed.
      this.pending.push({ patchId: id, seq: this.seq });
      return true;
    }
    return this.markers.get(id)?.has(next) ?? false;
  }
}
