/// <reference types="vite/client" />
import workflowTest from '@convex-dev/workflow/test';
import type { TestConvex } from 'convex-test';
import type { GenericSchema, SchemaDefinition } from 'convex/server';

import schema from './component/schema.ts';

// Matches the sources when run from src/ and the build when run from dist/.
const modules = import.meta.glob(['./component/**/*.{ts,js}', '!./component/**/*.d.ts']);

export { simulateDeploy } from './testing.ts';

/**
 * Registers `@convex-dev/workflow` (with its workpool) and the patch marker
 * component with a convex-test instance, under the names `convex.config.ts`
 * gives them.
 */
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  names: { workflow?: string; patches?: string } = {},
): void {
  workflowTest.register(t, names.workflow ?? 'workflow');
  t.registerComponent(names.patches ?? 'workflowPatches', schema, modules);
}

export default { register, schema, modules };
