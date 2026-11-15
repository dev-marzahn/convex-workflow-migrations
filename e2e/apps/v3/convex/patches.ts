// The patch ids each workflow declares, by function name. `step.patched(id)`
// only accepts ids listed here, and `convex-workflow-patches check` compares
// this file with what the deployed release declares. Keep it free of imports:
// the check loads it outside Convex.
export default {
  // "notify-after-grab" is gone: release 3 removed its old branch.
  'pipeline:run': ['prepare-before-publish'],
} satisfies Record<string, readonly string[]>;
