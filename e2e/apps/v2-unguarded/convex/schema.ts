import { vWorkflowId } from '@dev-marzahn/convex-workflow-migrations';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  grabs: defineTable({
    title: v.string(),
    // The steps that ran, in order.
    log: v.array(v.string()),
    workflowId: v.optional(vWorkflowId),
  }),
  alerts: defineTable({ workflowId: v.string(), reason: v.string() }).index('workflowId', ['workflowId']),
});
