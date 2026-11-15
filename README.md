# convex-workflow-patches

[![npm](https://img.shields.io/npm/v/@dev-marzahn/convex-workflow-patches)](https://www.npmjs.com/package/@dev-marzahn/convex-workflow-patches)
[![CI](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue)](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/LICENSE)

Change a released [`@convex-dev/workflow`](https://www.convex.dev/components/workflow) workflow without failing the runs already in flight, the way [Temporal's patching](https://docs.temporal.io/develop/typescript/versioning) does.

`@convex-dev/workflow` replays a workflow's handler from the start every time a step finishes, and matches each step call to its journal by position. If you add a step before the point a run has reached, that run fails with `Journal entry mismatch`. Put the change behind `step.patched()` instead:

```ts
// convex/pipeline.ts
export const run = workflow.define({
  args: { grabId: v.id('grabs') },
  handler: async (step, { grabId }): Promise<void> => {
    await step.runMutation(internal.pipeline.grab, { grabId });
    if (step.patched('notify-after-grab')) {
      await step.runMutation(internal.pipeline.notify, { grabId });
    }
    await step.awaitEvent({ name: 'downloadDone' });
    // ...
  },
});
```

A run that passed that point before the deploy gets `false` on every replay and keeps its recorded path. A run that reaches it after the deploy gets `true` and runs the new step, including a run that was waiting on `awaitEvent` when the deploy happened.

- **Same API otherwise.** `WorkflowManager` is `@convex-dev/workflow`'s, with `patched()` and `deprecatePatch()` on the step context. `start`, `sendEvent`, `restart`, `cancel`, `status` and the rest are upstream's.
- **Upstream's component.** Your workflows, journals and events stay in the `@convex-dev/workflow` component. This package adds a small component for patch markers.
- **Markers in the same transaction.** A marker is written with the step it precedes. If the handler run fails, both roll back.
- **Tests without a deploy.** `simulateDeploy({ without: [...] })` makes convex-test runs behave like a release that didn't have those patches.

## Contents

- [Quick start](#quick-start)
- [Writing a patch](#writing-a-patch)
- [Removing a patch](#removing-a-patch)
- [Testing](#testing)
- [How it works](#how-it-works)
- [@convex-dev/workflow versions](#convex-devworkflow-versions)
- [API](#api)
- [Limits](#limits)

## Quick start

Install the package with the exact `@convex-dev/workflow` version it was built from (see [versions](#convex-devworkflow-versions)):

```sh
npm install @dev-marzahn/convex-workflow-patches @convex-dev/workflow@0.4.10
```

Mount both components:

```ts
// convex/convex.config.ts
import workflow from '@convex-dev/workflow/convex.config.js';
import workflowPatches from '@dev-marzahn/convex-workflow-patches/convex.config.js';
import { defineApp } from 'convex/server';

const app = defineApp();
app.use(workflow);
app.use(workflowPatches);
export default app;
```

Create the manager from this package instead of `@convex-dev/workflow`:

```ts
// convex/workflow.ts
import { WorkflowManager } from '@dev-marzahn/convex-workflow-patches';

import { components } from './_generated/api';

export const workflow = new WorkflowManager(components.workflow, {
  patches: components.workflowPatches,
});
```

Workflows you already run keep working: a run with no markers replays exactly as it did under `@convex-dev/workflow`.

[`examples/basic`](https://github.com/dev-marzahn/convex-workflow-patches/tree/main/examples/basic) is an app with a patched workflow and its tests.

## Writing a patch

Put the new code behind `step.patched(id)` and keep the old code in the `else` branch (often: nothing). The id is any string, unique within the workflow; name it after the change.

```ts
if (step.patched('prepare-before-publish')) {
  await step.runAction(internal.media.prepare, { grabId });
}
```

- **Guard every change before a point where a live run may be waiting**: adding, removing or reordering steps, renaming a step, or changing a step's arguments. A change after every wait point doesn't need a guard, but a guard costs nothing.
- **One answer per run.** The first `patched(id)` call in a run decides; later calls with the same id return the same value, even if the run crossed a deploy between them.
- **Decide before a parallel batch.** Calling `patched()` while issuing `Promise.all` steps works, but deciding first and branching on the result is easier to read.
- **Don't rename the workflow function.** Each run stores a handle to it, and patching can't help with that.

## Removing a patch

Once every live run has passed the patch point with the patch, the old branch can go. There are two ways:

- **Directly:** delete the `patched()` call and the old branch. Leftover markers are ignored.
- **With a check in between:** replace `if (step.patched(id)) { new }` with `step.deprecatePatch(id); new`. It records a marker like `patched()`, so a rollback to the previous release still replays. A run that passed the point without the patch fails with a message naming the patch, instead of `Journal entry mismatch` a few steps later.

### Checking before you deploy

`convex-workflow-patches drain` lists the running workflows that may still need a patch's old branch, and exits 1 if there are any. Run it against the deployed code, before you deploy code that removes the branch. It calls a query your app exports:

```ts
// convex/patches.ts
import { workflow } from './workflow';

export const drain = workflow.drainQuery();
```

```sh
npx convex-workflow-patches drain --workflow pipeline:run --patch notify-after-grab
# notify-after-grab: 1 running pipeline:run workflow(s) may still need the code path without it:
#   m57d3c1b8e5f2a9...
```

`--patch` can be repeated. `--function` names the query if it isn't `patches:drain`. Options after `--` go to `convex run`, for example `-- --prod`. It exits 0 when nothing is waiting, 1 when runs are, and 2 on a usage or deployment error.

A run is listed when it's still running and has no marker for the patch. That includes runs that haven't reached the patch point yet: those would take the new path, but the check can't tell them apart from runs that passed the point without the patch, so it waits for them too. In code, `workflow.runsWithoutPatch(ctx, internal.pipeline.run, patchId, paginationOpts)` returns the same list one page at a time.

## Testing

Register both components with [convex-test](https://docs.convex.dev/testing/convex-test), then switch releases with `simulateDeploy`:

```ts
// convex/pipeline.test.ts
/// <reference types="vite/client" />
import patchesTest, { simulateDeploy } from '@dev-marzahn/convex-workflow-patches/test';
import { convexTest } from 'convex-test';
import { expect, test, vi } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';

test('a grab waiting for its download when release 2 ships gets prepare but not notify', async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, import.meta.glob('./**/*.ts'));
  patchesTest.register(t);

  simulateDeploy({ without: ['notify-after-grab', 'prepare-before-publish'] }); // release 1
  const { grabId, workflowId } = await t.mutation(api.pipeline.startGrab, { title: 'Some Show S01E01' });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  simulateDeploy(); // release 2
  await t.mutation(api.pipeline.downloadDone, { workflowId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await t.run((ctx) => ctx.db.get('grabs', grabId)))?.log).toEqual(['grab', 'import', 'prepare', 'publish']);
});
```

`simulateDeploy({ without })` makes `patched(id)` return `false` and record nothing for those ids, which is what code without the call does. It can only simulate guarded changes. An unguarded change is exactly what it can't see, so for each release keep a test that replays a run started on the release before.

Configure Vitest for convex-test, and inline the packages that ship TypeScript test helpers:

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test', '@convex-dev/workflow', '@convex-dev/workpool', '@dev-marzahn/convex-workflow-patches'] } },
  },
});
```

## How it works

Every step call gets a position when it's made: the first call in a handler run is 0, the next 1, and so on. Replay matches step calls to journal entries in that order, so the call at position n replays journal entry n. A `patched(id)` call made after n step calls therefore sits right before entry n:

- **Entry n exists:** the run has been past this point. The answer is `true` if there is a marker for `id` naming entry n, otherwise `false`.
- **Entry n doesn't exist:** this is the frontier, the first time the run gets here. The answer is `true`, and the marker for `id` is written next to entry n when the next step is recorded, in the same mutation.

Markers name the journal entry by id, not by position. `restart({ from })` deletes entries, so the markers before deleted entries stop matching, and the run decides those patches again when it gets there. Restarting from before a patch point puts a run on the new path.

Each handler run reads its workflow's markers once, before replay, with one indexed query. `WorkflowManager.cleanup` deletes them together with the workflow.

## @convex-dev/workflow versions

Upstream's client runs the handler without exposing the replay position, and its package exports don't include the code that does. So this package ships a copy of that code, the client half of `@convex-dev/workflow`, with the patch hooks added. The server half, the `workflow` component, isn't copied. Your data lives in upstream's tables, and dropping this package means swapping `WorkflowManager` back and unmounting `workflowPatches`; no workflow data moves.

The copy matches one upstream release, so each release of this package needs that exact `@convex-dev/workflow` version:

| convex-workflow-patches | @convex-dev/workflow |
| ----------------------- | -------------------- |
| 100.0.x                 | 0.4.10               |

Fixes to upstream's client code arrive when this package updates its copy. Fixes to the component arrive with the version bump. [`VENDORED.md`](packages/convex-workflow-patches/src/vendor/workflow/VENDORED.md) lists the changes to the copy, and a test fails if the copy isn't the installed release plus those changes.

## API

| Export                                                              | What it does                                                                                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowManager(component, { patches, workpoolOptions? })`         | Upstream's manager. `define()` gives handlers the patched step context, and `cleanup()` also deletes the run's markers.    |
| `step.patched(id): boolean`                                         | Whether this run takes patch `id`'s new path. See [How it works](#how-it-works).                                           |
| `step.deprecatePatch(id): void`                                     | Records the patch like `patched()`. Throws if this run passed the point without it.                                        |
| `workflow.runsWithoutPatch(ctx, workflow, patchId, paginationOpts)` | One page of running workflows with no marker for `patchId`. See [Checking before you deploy](#checking-before-you-deploy). |
| `workflow.drainQuery()`                                             | An internal query over `runsWithoutPatch`, for the `drain` command.                                                        |
| `convex-workflow-patches drain`                                     | The deploy check. Exits 1 while runs may still need a patch's old branch.                                                  |
| `components.workflowPatches.markers.list`                           | A run's markers: `{ workflowId }` → `{ patchId, beforeStepId }[]`.                                                         |
| `components.workflowPatches.markers.runsWithPatch`                  | The runs that recorded a patch: `{ patchId }` → workflow ids.                                                              |
| `components.workflowPatches.markers.withPatch`                      | Which of the given runs recorded a patch: `{ patchId, workflowIds }` → workflow ids.                                       |
| `components.workflowPatches.markers.cleanup`                        | Deletes a run's markers. `WorkflowManager.cleanup` calls it.                                                               |
| `register(t, names?)` from `/test`                                  | Registers `@convex-dev/workflow`, its workpool and the marker component with convex-test.                                  |
| `simulateDeploy({ without })` from `/test`                          | Makes later handler runs behave like a release without those patches. `simulateDeploy()` restores the current code.        |

Everything else `@convex-dev/workflow` exports is re-exported unchanged.

## Limits

- **Pinned upstream version.** See [versions](#convex-devworkflow-versions).
- **Rollback.** Deploying code without a patch after runs recorded it fails those runs, as in Temporal.
- **Unguarded changes** still fail runs. Removing a step followed by an identical call (same name and arguments) still shifts replay silently. Patching is a discipline; tests catch what it misses.
- **Workflow function renames** aren't supported.
- **More than `maxParallelism` steps in one batch** (default 10) haven't been tested with a `patched()` call in the middle of the batch.
