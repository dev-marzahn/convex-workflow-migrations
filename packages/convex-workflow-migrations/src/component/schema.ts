import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// What each workflow run did at its `patched()` calls, and which patches the
// code it ran on knew. Ids are strings because the workflows and their steps
// live in the @convex-dev/workflow component.
export default defineSchema({
  // The run took the patch: it reached `patched(patchId)` for the first time on
  // code with the patch. `beforeStepId` is the journal entry recorded right
  // after that call.
  markers: defineTable({
    workflowId: v.string(),
    patchId: v.string(),
    beforeStepId: v.string(),
  }).index('workflowId', ['workflowId']),
  // The run skipped the patch: it replayed past `patched(patchId)` with no
  // marker, so it passed that point on code without the patch.
  skips: defineTable({
    workflowId: v.string(),
    patchId: v.string(),
  }).index('workflowId', ['workflowId']),
  // One row per run: its workflow function, and every patch id declared by the
  // code it has run on.
  runs: defineTable({
    workflowId: v.string(),
    workflow: v.string(),
    known: v.array(v.string()),
  }).index('workflowId', ['workflowId']),
  // One row per workflow function: the patch ids declared by the code that ran
  // it last, i.e. the deployed release once any of its runs has run.
  workflows: defineTable({
    workflow: v.string(),
    declared: v.array(v.string()),
  }).index('workflow', ['workflow']),
});
