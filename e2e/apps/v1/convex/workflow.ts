// Release 0 runs on plain @convex-dev/workflow; later releases adopt this package.
import { WorkflowManager } from '@convex-dev/workflow';

import { components } from './_generated/api';

export const workflow = new WorkflowManager(components.workflow);
