import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  // One row per patch decided `true` at the frontier: the run passed
  // `patched(patchId)` with the patch in its code, and `beforeStepId` is the
  // journal entry recorded right after that call. Ids are strings because the
  // workflow and its steps live in the @convex-dev/workflow component.
  markers: defineTable({
    workflowId: v.string(),
    patchId: v.string(),
    beforeStepId: v.string(),
  })
    .index('workflowId', ['workflowId'])
    .index('patchId_workflowId', ['patchId', 'workflowId']),
});
