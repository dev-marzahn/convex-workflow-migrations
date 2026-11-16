import { vWorkflowId } from '@dev-marzahn/convex-workflow-migrations';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  grabs: defineTable({
    title: v.string(),
    // Which steps have run, in order.
    log: v.array(v.string()),
    // The grab's run, set once it starts.
    workflowId: v.optional(vWorkflowId),
  }),
});
