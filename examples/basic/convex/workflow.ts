import { WorkflowManager } from '@dev-marzahn/convex-workflow-migrations';

import { components } from './_generated/api';
import declared from './patches';

export const workflow = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  declared,
});
