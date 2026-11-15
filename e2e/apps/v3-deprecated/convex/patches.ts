// Each workflow's patch ids, by function name and by the step of removing a
// patch each id is at. The predeploy check reads this file. Keep it free of
// imports: the check loads it outside Convex.
export default {
  // "notify-after-grab" is deprecated: its old branch is gone, its call is deprecatePatch().
  'pipeline:run': { active: ['prepare-before-publish'], deprecated: ['notify-after-grab'] },
} as const;
