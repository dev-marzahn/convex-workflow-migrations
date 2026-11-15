import { WorkflowManager } from '@dev-marzahn/convex-workflow-patches';

import { components } from './_generated/api';

export const workflow = new WorkflowManager(components.workflow, {
  patches: components.workflowPatches,
});
