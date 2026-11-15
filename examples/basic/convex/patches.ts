import { workflow } from './workflow';

// What `npx convex-workflow-patches drain --workflow pipeline:run --patch <id>`
// calls before a deploy that removes a patch's old branch.
export const drain = workflow.drainQuery();
