import { vWorkflowId } from '@dev-marzahn/convex-workflow-patches';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  grabs: defineTable({
    title: v.string(),
    // The steps that ran, in order.
    log: v.array(v.string()),
    workflowId: v.optional(vWorkflowId),
  }),
  // One row per onPause call.
  pauses: defineTable({ workflowId: vWorkflowId, reason: v.string() }).index('workflowId', ['workflowId']),
});
