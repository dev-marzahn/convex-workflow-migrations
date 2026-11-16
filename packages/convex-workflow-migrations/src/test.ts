/// <reference types="vite/client" />
// @dev-marzahn/convex-workflow-migrations/test: `register` for convex-test.
// Through `@convex-dev/workflow/test` and `modules`, it uses
// import.meta.glob, so Vitest has to inline it.
import workflowTest from '@convex-dev/workflow/test';
import type { TestConvex } from 'convex-test';
import type { GenericSchema, SchemaDefinition } from 'convex/server';

import schema from './component/schema.ts';

// Matches the sources when run from src/ and the build when run from dist/.
const modules = import.meta.glob(['./component/**/*.{ts,js}', '!./component/**/*.d.ts']);

/**
 * Registers `@convex-dev/workflow` (with its workpool) and the migrations
 * component with a convex-test instance, under the names `convex.config.ts`
 * gives them.
 */
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  names: { workflow?: string; migrations?: string } = {},
): void {
  workflowTest.register(t, names.workflow ?? 'workflow');
  t.registerComponent(names.migrations ?? 'workflowMigrations', schema, modules);
}

export default { register, schema, modules };
