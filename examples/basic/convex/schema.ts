import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  grabs: defineTable({
    title: v.string(),
    // Which steps have run, in order. The UI would read this.
    log: v.array(v.string()),
  }),
});
