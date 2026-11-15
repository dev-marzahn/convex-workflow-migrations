// Each workflow's patch ids, by function name and by the step of removing a
// patch each id is at. The predeploy check reads this file. Keep it free of
// imports: the check loads it outside Convex.
export default {
  // This release makes its changes without patches.
  'pipeline:run': {},
} as const;
