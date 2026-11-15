// Each workflow's patch ids, by function name and by the step of removing a
// patch each id is at: `active` ids are called with `step.patched(id)`,
// `deprecated` ids with `step.deprecatePatch(id)`, and `retired` ids are no
// longer called but stay listed. The predeploy check reads this file to find
// which old branches a release removes. Keep it free of imports: the check
// loads it outside Convex. `as const` lets `patched()` reject unknown ids.
export default {
  'pipeline:run': { active: ['notify-after-grab', 'prepare-before-publish'] },
} as const;
