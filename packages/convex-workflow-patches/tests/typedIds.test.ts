// With `as const` declarations, `patched()` and `deprecatePatch()` only accept
// declared ids: the `@ts-expect-error` lines fail the type check if they don't.
import { componentsGeneric } from 'convex/server';
import { expect, test } from 'vite-plus/test';

import { type PatchesComponent, type WorkflowComponent, WorkflowManager } from '../src/index.ts';

const components = componentsGeneric() as unknown as { workflow: WorkflowComponent; workflowPatches: PatchesComponent };
const declared = { 'flows:run': { active: ['notify'], deprecated: ['prepare'], retired: ['old'] } } as const;
const manager = new WorkflowManager(components.workflow, { patches: components.workflowPatches, declared });

manager.define({
  args: {},
  handler: async (step): Promise<void> => {
    step.patched('notify');
    step.deprecatePatch('prepare');
    // @ts-expect-error a typo
    step.patched('notfiy');
    // @ts-expect-error deprecated ids go to deprecatePatch()
    step.patched('prepare');
    // @ts-expect-error retired ids can't be called
    step.patched('old');
    // @ts-expect-error active ids go to patched()
    step.deprecatePatch('notify');
    // @ts-expect-error withOptions keeps the id types
    step.withOptions({}).patched('notfiy');
  },
});

test('the manager keeps the literal declarations', () => {
  expect(manager.declared['flows:run'].active).toEqual(['notify']);
});
