// Release 1 runs on plain @convex-dev/workflow; release 2 adopts this package.
import { WorkflowManager } from '@convex-dev/workflow';

import { components } from './_generated/api';

export const workflow = new WorkflowManager(components.workflow);
