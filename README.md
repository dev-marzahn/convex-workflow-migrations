# convex-workflow-patches

[![npm](https://img.shields.io/npm/v/@dev-marzahn/convex-workflow-patches)](https://www.npmjs.com/package/@dev-marzahn/convex-workflow-patches)
[![CI](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml)
[![License: MPL-2.0 AND Apache-2.0](https://img.shields.io/badge/license-MPL--2.0%20AND%20Apache--2.0-blue)](#license)

Change a released [`@convex-dev/workflow`](https://www.convex.dev/components/workflow) workflow without failing the runs already in flight, the way [Temporal's patching](https://docs.temporal.io/develop/typescript/versioning) does.

`@convex-dev/workflow` replays a workflow's handler from the start every time a step finishes, and matches each step call to its journal by position. If you add a step before a step a run is paused at, that run fails with `Journal entry mismatch`. Put the change behind `step.patched()` instead:

```ts
// convex/pipeline.ts: one run per download ("grab"): grab it, wait for the download, then publish.
export const run = workflow.define({
  args: { grabId: v.id('grabs') },
  handler: async (step, { grabId }): Promise<void> => {
    await step.runMutation(internal.pipeline.grab, { grabId });
    if (step.patched('notify-after-grab')) {
      await step.runMutation(internal.pipeline.notify, { grabId });
    }
    await step.awaitEvent({ name: 'downloadDone' });
    if (step.patched('prepare-before-publish')) {
      await step.runAction(internal.pipeline.prepare, { grabId });
    }
    await step.runMutation(internal.pipeline.publish, { grabId });
  },
});
```

Say this ships while a run is waiting for its download. That run passed `notify-after-grab` on the old code, so it gets `false` there on every replay and keeps its recorded path. It reaches `prepare-before-publish` for the first time on the new code, so it gets `true` and runs `prepare`. A run started after the deploy gets `true` at both.

- **Same API otherwise.** `WorkflowManager` is `@convex-dev/workflow`'s, with `patched()` and `deprecatePatch()` on the step context. `start`, `sendEvent`, `restart`, `cancel`, `status` and the rest are upstream's.
- **Upstream's component.** Your workflows, journals and events stay in the `@convex-dev/workflow` component. This package adds a small component for what each run did at its patches.
- **Markers in the same transaction.** A marker is written in the same transaction as the step it precedes, so they're saved together or not at all.
- **A check before you deploy.** A release that removes code a running workflow still needs is refused: by [convex-release](https://github.com/dev-marzahn/convex-release) on every deploy, or by `convex-workflow-patches check` in your deploy script.
- **Tests without a deploy.** `simulateDeploy({ without: [...] })` makes convex-test runs behave like a release that didn't have those patches.

## Contents

- [Quick start](#quick-start)
- [Writing a patch](#writing-a-patch)
- [Removing a patch](#removing-a-patch)
- [Checking before you deploy](#checking-before-you-deploy)
- [Testing](#testing)
- [How it works](#how-it-works)
- [@convex-dev/workflow versions](#convex-devworkflow-versions)
- [API](#api)
- [Limits](#limits)
- [Versioning](#versioning)
- [Contributing](#contributing)
- [License](#license)

## Quick start

Install the package with the exact `@convex-dev/workflow` version it was built from (see [versions](#convex-devworkflow-versions)) and its other peers:

```sh
npm install @dev-marzahn/convex-workflow-patches @convex-dev/workflow@0.4.10 @convex-dev/workpool convex-helpers
```

The check loads `convex/patches.ts` with Node, so it needs Node 22.18 or later (for its TypeScript support), and the file may only use TypeScript that Node can strip: no `enum` or `namespace`.

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

Declare each workflow's patches, keyed by the workflow's function name (`file:export`, or `dir/file:export` in a folder). Each id is `active`, `deprecated` or `retired`, the three steps of [removing a patch](#removing-a-patch):

```ts
// convex/patches.ts
export default {
  'pipeline:run': { active: ['notify-after-grab', 'prepare-before-publish'] },
} as const;
```

Keep this file free of imports: the [check](#checking-before-you-deploy) loads it outside Convex. It may also be `patches.js` or `patches.mjs`, in the functions folder `convex.json` names. With `as const`, `step.patched()` and `step.deprecatePatch()` only accept the ids declared for them, so a typo is a type error. Then create the manager from this package instead of `@convex-dev/workflow`:

```ts
// convex/workflow.ts
import { WorkflowManager } from '@dev-marzahn/convex-workflow-patches';

import { components } from './_generated/api';
import declared from './patches';

export const workflow = new WorkflowManager(components.workflow, {
  patches: components.workflowPatches,
  declared,
});
```

Workflows you already run keep working: a run with no records replays exactly as it did under `@convex-dev/workflow`.

Every workflow on the `workflow` component should be defined with this manager. Runs defined elsewhere, for example with upstream's `defineWorkflow`, have no records, so the check can't tell what they need.

[`examples/basic`](https://github.com/dev-marzahn/convex-workflow-patches/tree/main/examples/basic) is a runnable version of the pipeline above, with its tests: each step logs its name on the grab, it has an `import` step after the download, and `startGrab` and `downloadDone` start and resume it. From the repo root, run `bun install`, `bun run build` (the example imports the built package), then `bun run --cwd examples/basic test`.

## Writing a patch

Put the new code behind `step.patched(id)` and keep the old code in the `else` branch (often: nothing). Add the id to the workflow's `active` list in `convex/patches.ts`.

```ts
if (step.patched('prepare-before-publish')) {
  await step.runAction(internal.pipeline.prepare, { grabId });
}
```

With `as const`, an id that no workflow declares is a type error. The types can't see which workflow a handler belongs to, though, so an id declared for another workflow, or a key in `convex/patches.ts` that doesn't match the function name, gets through. Then `patched()` throws when a run reaches it, and that run fails. Your convex-test tests reach it first.

- **Guard every change that a running workflow could replay.** A run pauses at every step that isn't `inline` until the step finishes: every `runMutation`, `runQuery`, `runAction` and `runWorkflow` call, every `sleep` and every `awaitEvent`. A deploy can land during any of those pauses. Then the run replays its recorded steps on the new code. So a change needs a guard if it comes before a step some live run may still be paused at: adding, removing or reordering steps, renaming a step, or changing a step's arguments. Only a change after the last step any live run could have reached is safe without one. When unsure, guard it. A guard costs nothing.
- **One answer per run.** The first `patched(id)` call in a run decides; later calls with the same id return the same value, even if the run crossed a deploy between them.
- **The decision point may move; the guarded steps may not.** A run that took a patch has a marker on the first step the patch guards, and any `patched(id)` call returns `true` while that step is in its journal. So you can move the call above other code, for example to decide before a parallel batch and branch inside it, as long as the steps it guards stay where they were. What breaks is guarding new steps with a released id _before_ the old guarded ones: runs that took the patch would run them on replay, where they never did. Use a new id for that. A run that skipped the patch keeps `false` even if a later release only calls the id further on.
- **Never reuse an id.** A removed patch's id stays in `convex/patches.ts` as `retired`, and `patched()` refuses it. Records from its old runs would otherwise apply to the new code.
- **Don't rename the workflow function.** Each run stores a handle to it, and patching can't help with that.

## Removing a patch

Removing a patch takes up to three releases:

1. **Ship the patch:** `if (step.patched(id)) { new } else { old }`, with `id` under `active`.
2. **Deprecate it:** replace the branch with `step.deprecatePatch(id); new`, and move `id` to `deprecated`. This release removes the old branch, which running workflows may still need, so the [check](#checking-before-you-deploy) refuses it while they're running. `deprecatePatch` still records the patch for each run, so rolling back to release 1 replays runs started on this one. A run that passed the point without the patch fails with an error naming it.
3. **Retire it:** delete `step.deprecatePatch(id)` and move `id` to `retired`, once you won't roll back to a release that calls `patched(id)`. The check refuses this release on the same terms as step 2. For an installation that upgraded through step 2 it passes, but an installation that jumps straight from release 1 to 3 gets checked.

You can skip step 2 and go straight from 1 to 3 if you don't need to roll back: delete the call and the old branch, and move `id` to `retired`. Keep retired ids listed: the check treats an id that runs recorded and the release doesn't list at all as a rollback.

A run that can't replay ends as `failed`, and your `onComplete` handler runs; see [Limits](#limits).

## Checking before you deploy

The check reads `convex/patches.ts` from the release you're deploying. For each deprecated or retired patch, whose old branch the release no longer has, it lists the running workflows that may still need that branch, and refuses the release if there are any. It needs nothing from the deployed release's code, so it works however many releases you skip.

### With convex-release

[convex-release](https://github.com/dev-marzahn/convex-release) 100.1.0-next.0 or later runs the check by itself, as a [predeploy check](https://github.com/dev-marzahn/convex-release#predeploy-checks): `convex-release dev`, `deploy` and `check`, and both of its images, before they push anything. Installing this package as a direct dependency of your app is enough:

```text
A predeploy check refused this release; nothing was pushed.
@dev-marzahn/convex-workflow-patches: 1 running workflow still needs code this release removes
  - m57d3c1b8e5f2a9... (pipeline:run) passed "notify-after-grab" without the patch
Skip a check with --skip-check <package> only if you've confirmed the release is safe.
```

The images read `convex/patches.ts` when they're built, and check against the deployment when they start. That covers installations that upgrade themselves.

### Without convex-release

`convex-workflow-patches check` runs the same check through `convex run`, and exits 1 if runs block:

```sh
npx convex-workflow-patches check
# 1 running workflow still needs code this release removes:
#   m57d3c1b8e5f2a9... (pipeline:run) passed "notify-after-grab" without the patch
```

Run it from your app's directory, where `convex` is installed, against the deployment you're about to deploy to, for example in your deploy script:

```json
{ "scripts": { "deploy": "convex-workflow-patches check && convex deploy" } }
```

It exits 0 when nothing blocks (including a deployment that doesn't have the patches component yet), 1 when runs block, and 2 on a usage or deployment error. Options after `--` go to every `convex` command the check runs (`convex run` and `convex data`), for example `-- --prod`.

### What blocks a release

A running workflow blocks a release that deprecates or retires one of its workflow's patches when it:

- **passed the patch point without the patch**: it replayed past `patched(id)` and got `false`;
- **has been waiting since before the patch shipped**: it hasn't run on code that declares the patch, so it may have passed the point on older code;
- **hasn't run since this package was adopted**: nothing is recorded about it yet.

It also blocks a release that doesn't list, in any state, a patch the run took or skipped. That's a rollback to before the patch, or a retired id deleted from `convex/patches.ts`, and either way one side of the branch is gone.

Runs that haven't reached a patch point don't block, because they'll take the new path. The last two kinds of the first list stop blocking as soon as the run takes its next step. Every run is recorded on its first step, including runs of workflows without patches. A deployment without the patches component yet passes: nothing it runs can need a removed patch.

- **What it reads.** Every workflow in the workflow component, 100 per query (the CLI's `--page-size` changes that), running or not, because upstream keeps finished workflows until you call `workflow.cleanup` and has no index by status. It only reads them when some workflow has a deprecated, retired or unlisted patch; retired ids stay listed, so after the first removal that's every release. convex-release gives a check 10 minutes. Call `workflow.cleanup` on finished runs, for example from `onComplete`, to keep it fast.
- **Finished runs aren't checked.** After you remove a patch's old branch, restart a finished run only with `from` set before the patch point. A restart without `from` replays the run's history, and a run that passed the point without the patch fails.
- **Untracked child workflows.** A run with no records is matched to a workflow by upstream's name for it, which for a child workflow started with a custom `name` is that name. Such a child that hasn't run since the app adopted this package isn't checked.
- **Components mounted elsewhere.** If you mount the components under other names than `workflow` and `workflowPatches`, say so in `convex/patches.ts`. A wrong `patches` path looks like a deployment without the component, so the check passes; a wrong `workflow` path fails the check with an error.

  ```ts
  export const componentPaths = { workflow: 'workflow', patches: 'wfPatches' };
  ```

## Testing

Register both components with [convex-test](https://docs.convex.dev/testing/convex-test), then switch releases with `simulateDeploy`. This test is from `examples/basic`, whose steps log their names on the grab:

```ts
// convex/pipeline.test.ts
/// <reference types="vite/client" />
import patchesTest, { simulateDeploy } from '@dev-marzahn/convex-workflow-patches/test';
import { convexTest } from 'convex-test';
import { beforeEach, expect, test, vi } from 'vitest';

import { api } from './_generated/api';
import schema from './schema';

beforeEach(() => simulateDeploy());

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

`simulateDeploy({ without })` makes `patched(id)` return `false` and record nothing for those ids, which is what code without the call does. While a patch is in `without`, `deprecatePatch` of that id throws: an older release can't have called it. The switch is process-wide, so reset it before each test and don't run patched-workflow tests concurrently.

`simulateDeploy` only switches guarded code, so it can't show what an unguarded change does to a waiting run. Only two real versions of your app can: deploy the previous release to a throwaway self-hosted backend, start a run and leave it waiting, deploy the new release over it, then let the run finish. This repo's [`e2e/run.ts`](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/e2e/run.ts) does that with its fixture apps; copy `startBackend` from `e2e/backend.ts` and the `deploy` and `until` helpers from `e2e/run.ts`, and point them at two checkouts of your app. [convex-release](https://github.com/dev-marzahn/convex-release)'s `test-upgrade --seed <function>` gets you halfway: it can start workflows on the previous image, but its `--check` runs once on the new one, so it can't wait for them to finish.

Configure Vitest for convex-test: install `convex-test`, `vitest` and `@edge-runtime/vm`, and inline the packages whose test helpers use `import.meta.glob`:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test', '@convex-dev/workflow', '@convex-dev/workpool', '@dev-marzahn/convex-workflow-patches'] } },
  },
});
```

## How it works

Every step call gets a position when it's made: the first call in a handler run is 0, the next 1, and so on. Replay matches step calls to journal entries in that order, so the call at position n replays journal entry n. A `patched(id)` call made after n step calls:

- **at the frontier** (no entry n yet; the first time the run gets here) returns `true`, and a marker for `id` naming the next recorded step is written in the same transaction as that step;
- **on replay** returns `true` if the run has a marker for `id` whose step is still in its journal, otherwise `false`, and then records that the run skipped the patch, with the journal entry it was at.

Each handler run also records which patch ids its code declares (`known`), and the component keeps, per workflow function, every patch id a run took or skipped. [The check](#checking-before-you-deploy) compares those with the release's `convex/patches.ts`. Markers and skips name steps by id, so `restart({ from })` makes those of deleted steps stop counting, and the run decides those patches again when it gets there: restarting from before a patch point puts a run on the new path.

Each handler run reads its records once, before replay, and writes once at the end, in the same transaction, only when something changed. `WorkflowManager.cleanup` deletes them together with the workflow: in the same transaction when called from a mutation, in a second one from an action.

**Why the declarations carry each id's state.** The check has to know which old branches a release removes. An earlier design compared the release's ids with a record of what the deployed release declared, written when its workflows ran. A release deployed while every run was paused never got recorded, so the next one was compared with stale data and passed. With `deprecated` and `retired` in `convex/patches.ts`, the release says what it removes, and nothing depends on what has run.

## @convex-dev/workflow versions

Upstream's client runs the handler without exposing the replay position, and its package exports don't include the code that does. So this package ships a copy of that code, the client half of `@convex-dev/workflow`, with the patch hooks added. The server half, the `workflow` component, isn't copied: your data lives in upstream's tables.

The copy matches one upstream release, so each release of this package needs that exact `@convex-dev/workflow` version:

| convex-workflow-patches | @convex-dev/workflow |
| ----------------------- | -------------------- |
| 100.0.x                 | 0.4.10               |

Fixes to upstream's client code arrive when this package updates its copy. Fixes to the component arrive with the version bump. A new upstream release is noticed within a week; this package follows with a release that copies it. [`VENDORED.md`](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-patches/src/vendor/workflow/VENDORED.md) lists the changes to the copy, and a test fails if the copy isn't the installed release plus those changes.

**Why a copy, and when it goes away.** Upstream has no hook for this yet: [#35](https://github.com/convex/workflow/issues/35) asks for one, and [PR #279](https://github.com/convex/workflow/pull/279) proposes version stamps on journal entries. Other options were weaker. A full fork would move your workflow data into the fork's tables. Pinning a version in each run's arguments decides at start, so a run waiting on a download never gets a fix. If upstream ships patching, this package becomes a thin wrapper over it or is retired. Your workflows, journals and events are already in upstream's tables. Moving off means removing every `patched()` call first (see [Removing a patch](#removing-a-patch)), then swapping `WorkflowManager` back and unmounting `workflowPatches`.

## API

| Export                                                                | What it does                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowManager(component, { patches, declared, workpoolOptions? })` | Upstream's manager. `define()` gives handlers the patched step context, typed by `declared`, and `cleanup()` also deletes the run's records. `workflow.patches` and `workflow.declared` hold the options.                                                                                                                                                                                          |
| `step.patched(id): boolean`                                           | Whether this run takes patch `id`'s new path. `id` must be `active`. See [How it works](#how-it-works).                                                                                                                                                                                                                                                                                            |
| `step.deprecatePatch(id): void`                                       | Records the patch for this run like `patched()`. `id` must be `deprecated`. Throws if this run passed the point without it.                                                                                                                                                                                                                                                                        |
| `convex-workflow-patches check`                                       | The deploy check. See [Checking before you deploy](#checking-before-you-deploy).                                                                                                                                                                                                                                                                                                                   |
| `dist/predeploy.js`                                                   | The same check as convex-release's predeploy check module, declared under `convex-release.predeploy` in this package's `package.json`. convex-release finds and runs it; you don't import it.                                                                                                                                                                                                      |
| `register(t, names?)` from `/test`                                    | Registers `@convex-dev/workflow` (its workpool at `<workflow>/workpool`) and the patches component with convex-test. `names` defaults to `{ workflow: 'workflow', patches: 'workflowPatches' }`; set it if you mounted them under other names.                                                                                                                                                     |
| `simulateDeploy({ without })` from `/test`                            | Makes later handler runs behave like a release without those patches. `simulateDeploy()` restores the current code.                                                                                                                                                                                                                                                                                |
| default export of `/test`                                             | `{ register, schema, modules }`, the shape of upstream's `@convex-dev/workflow/test`, for `patchesTest.register(t)`.                                                                                                                                                                                                                                                                               |
| Types                                                                 | `WorkflowCtx<ActiveId, DeprecatedId>`, `PatchedWorkflowCtx<Declared>`, `WorkflowHandler`, `WorkflowArgs` (this package's), `DeclaredPatches`, `PatchDeclaration`, `PatchesComponent`, and upstream's `WorkflowId`, `EventId`, `WorkflowStep`, `RunResult`, `RunOptions`, `StepDefaults`, `WorkflowComponent`, `WorkflowDefinition`, `WorkflowMutationResult`, `WorkflowStatus`, `CallbackOptions`. |

Upstream's other exports are re-exported unchanged, except `defineWorkflow` (use `workflow.define`) and the standalone `cleanup` (use `workflow.cleanup`, which also deletes the patch records).

### The patches component

`components.workflowPatches` has four tables: `markers` and `skips` (per run and patch id: the run took the patch, or passed without it), `runs` (per run: its workflow function and the patch ids its code declared) and `recorded` (per workflow function: every patch id a run took or skipped). Its functions are internal: the workflow mutation, `WorkflowManager.cleanup` and the check call them. Don't call them yourself.

Records of child workflows that upstream cleans up with their parent are left behind; they're harmless.

## Limits

- **Pinned upstream version.** See [versions](#convex-devworkflow-versions).
- **A run that can't replay ends.** This happens after a rollback below a recorded patch, an unguarded change, or a removed old branch the run still needs. The run is marked `failed` and your `onComplete` handler runs. Temporal, by contrast, keeps retrying until you deploy a fix. `restart()` can resume the run after a fix, but it doesn't undo what `onComplete` did. To treat these differently from real failures, check the error message. It contains:
  - `was removed, but` when the run needs a removed old branch (it also contains `Journal entry mismatch`);
  - `Journal entry mismatch` alone after an unguarded change or a rollback;
  - `deprecatePatch(` when the run passed a deprecated patch's point without it;
  - `isn't declared`, `is deprecated`, `is retired` or `is active` when a call doesn't match `convex/patches.ts`. That's a bug in the code, not a replay problem.
- **Who the check protects.** Deploys through convex-release, and deploys whose script runs `convex-workflow-patches check`. A plain `convex deploy`, or a skipped check, isn't checked: a run that needs a removed old branch then fails with an error naming the patch. `convex-release dev` checks only its first push, not the ones `convex dev` makes while it watches. A rollback from a release that retired a patch to one that still calls `patched(id)` isn't caught either: runs started after the retirement have no marker for it, so the older code sends them down the old path. That's what step 2 of [removing a patch](#removing-a-patch) is for.
- **Unguarded changes** still fail runs. Removing a step followed by an identical call (same name and arguments) still shifts replay silently. Patching is a discipline; the [e2e pattern](#testing) catches what it misses.
- **Workflow function renames** aren't supported.

## Versioning

Versions follow [Epoch SemVer](https://antfu.me/posts/epoch-semver): `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at `100.0.0`. A change to the first number can break your app; minor and patch releases don't. Moving to a new `@convex-dev/workflow` version is a minor release, unless upstream's own change breaks something; then it's a major one. [CHANGELOG.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CHANGELOG.md) lists the changes.

## Contributing

See [CONTRIBUTING.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CONTRIBUTING.md). Report vulnerabilities privately, as [SECURITY.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/SECURITY.md) describes.

## License

[MPL-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/LICENSE). The copy of `@convex-dev/workflow`'s client code in `src/vendor/workflow/` is upstream's, under [Apache-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-patches/src/vendor/workflow/LICENSE), and is marked as changed where it was changed.
