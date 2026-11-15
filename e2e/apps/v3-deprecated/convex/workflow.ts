import { WorkflowManager } from '@dev-marzahn/convex-workflow-patches';

import { components } from './_generated/api';
import declared from './patches';

export const workflow = new WorkflowManager(components.workflow, {
  patches: components.workflowPatches,
  declared,
});
