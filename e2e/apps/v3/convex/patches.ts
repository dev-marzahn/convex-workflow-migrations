// Each workflow's patch ids, by function name and by the step of removing a
// patch each id is at. The predeploy check reads this file. Keep it free of
// imports: the check loads it outside Convex.
export default {
  // "notify-after-grab" is retired: release 3 removed its old branch and its call.
  'pipeline:run': { active: ['prepare-before-publish'], retired: ['notify-after-grab'] },
} as const;
