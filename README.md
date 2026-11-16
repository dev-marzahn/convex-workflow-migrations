# convex-workflow-patches

[![npm](https://img.shields.io/npm/v/@dev-marzahn/convex-workflow-patches)](https://www.npmjs.com/package/@dev-marzahn/convex-workflow-patches)
[![CI](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml)
[![License: MPL-2.0 AND Apache-2.0](https://img.shields.io/badge/license-MPL--2.0%20AND%20Apache--2.0-blue)](#license)

Change a released [`@convex-dev/workflow`](https://www.convex.dev/components/workflow) workflow without failing the runs already in flight.

`@convex-dev/workflow` replays a workflow's handler from the start every time a step finishes, and matches each step call to its journal by position. If you add a step before the step a run is waiting at, that run fails with `Journal entry mismatch`. With this package, the handler holds only its current code, and each change comes with a **migration**: a small function that rewrites a run's recorded history into the shape the current code expects.

```ts
// convex/pipeline.ts: one run per download ("grab"): grab it, notify, wait for the download, import, transcode, publish.
export const run = workflow.define({
  args: { grabId: v.id('grabs') },
  migrations: [
    // Release 1 added notify after grab. Runs already past grab count as notified.
    migration('notify-after-grab', (h) => h.insertAfter(internal.pipeline.grab, internal.pipeline.notify, { result: { at: null } })),
    // Release 2: import takes notifiedAt. Runs that already imported did so without it.
    migration('import-gets-notified-at', (h) =>
      h.updateArgs(internal.pipeline.importFiles, (args) => ({ ...args, notifiedAt: h.result(internal.pipeline.notify)?.at ?? null })),
    ),
    // Release 3: prepare was renamed to transcode. prepare is gone, so it's named by its path.
    migration('prepare-becomes-transcode', (h) => h.rename(makeFunctionReference('pipeline:prepare'), internal.pipeline.transcode)),
  ],
  handler: async (step, { grabId }) => {
    await step.runMutation(internal.pipeline.grab, { grabId });
    const { at } = await step.runMutation(internal.pipeline.notify, { grabId });
    await step.awaitEvent({ name: 'downloadDone' });
    await step.runMutation(internal.pipeline.importFiles, { grabId, notifiedAt: at });
    await step.runAction(internal.pipeline.transcode, { grabId });
    await step.runMutation(internal.pipeline.publish, { grabId });
  },
});
```

Say a run started on release 0 is waiting for its download when release 3 ships. Its journal is `grab, downloadDone`. When the download arrives, the run replays on release 3: the three migrations apply to its history in order, so it reads `grab, notify (a finished stand-in), downloadDone`, and the handler replays against that. `notify` resolves with `{ at: null }` without running, and the run goes on to `importFiles`. Releases 1 and 2 never had to be deployed.

- **Skip releases.** Every release lists every migration, and each run records which ones it has had. A run applies the ones it's missing, in order, the next time it replays. Nothing has to be deployed first, and nothing has to drain.
- **Pause instead of fail.** A run whose history still doesn't match the code (a change without a migration, a wrong migration, a rollback) is paused, not failed. It's retried with backoff, so deploying a fix resumes it, and `onPause` tells you it happened.
- **Same API otherwise.** `WorkflowManager` is `@convex-dev/workflow`'s, with `migrations` in `define()` and actions for paused runs. `start`, `sendEvent`, `restart`, `cancel`, `status` and the rest are upstream's.
- **Upstream's component.** Your workflows, journals and events stay in the `@convex-dev/workflow` component, unchanged. This package adds a small component with one row per run: the migrations applied to it, their edits, and its pause.
- **Tests against real histories.** `expectReplays` replays recorded histories, with the migrations, against the current handler in convex-test, and `npx convex-workflow-patches histories` exports them from a deployment.

## Contents

- [Quick start](#quick-start)
- [Writing migrations](#writing-migrations)
- [Pausing and recovery](#pausing-and-recovery)
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

Then create the manager from this package instead of `@convex-dev/workflow`:

```ts
// convex/workflow.ts
import { WorkflowManager } from '@dev-marzahn/convex-workflow-patches';

import { components } from './_generated/api';

export const workflow = new WorkflowManager(components.workflow, {
  patches: components.workflowPatches,
  // A paused run isn't failed, so nothing else reports it. Alert here.
  onPause: async (ctx, { workflowId, workflow, reason, detail }) => {
    console.error(`Workflow ${workflow} ${workflowId} paused (${reason}): ${detail}`);
  },
});
```

Define workflows with `workflow.define`, as with upstream. A workflow you already run needs no migrations until you change it. Runs it started before you adopted this package replay as they did, and count as runs from before the first migration you add.

Every workflow on the `workflow` component should be defined with this manager. Runs defined elsewhere, for example with upstream's `defineWorkflow`, don't migrate and fail on a mismatch as before.

[`examples/basic`](https://github.com/dev-marzahn/convex-workflow-patches/tree/main/examples/basic) is a runnable version of the pipeline above, with its tests: each step logs its name on the grab, and `startGrab` and `downloadDone` start and resume it. From the repo root, run `bun install`, `bun run build` (the example imports the built package), then `bun run --cwd examples/basic test`.

## Writing migrations

**When a change needs one.** A run waits at every step that isn't `inline` until the step finishes: every `runMutation`, `runQuery`, `runAction` and `runWorkflow` call, every `sleep` and every `awaitEvent`. A deploy can land during any of those waits, and then the run replays its recorded steps on the new code. So a change needs a migration if it comes before a step some live run may still be waiting at: adding, removing or reordering steps, renaming a step, or changing a step's arguments. A change after the last step any live run could have reached needs none. When unsure, write one and [test it](#testing) against histories from the old code.

Add it to the end of the workflow's `migrations` list:

```ts
migration('notify-after-grab', (h) => h.insertAfter(internal.pipeline.grab, internal.pipeline.notify, { result: { at: null } }));
```

- **The id is permanent.** A run stores the ids applied to it, and its applied ids must stay the start of the list. Never remove, rename or reorder a migration, even an old one: a run that has it would [pause](#pausing-and-recovery). Ids only need to be unique within the workflow; a duplicate throws when the module loads, so the push fails.
- **`migrate(h)` is synchronous and pure.** It reads `h` and calls its edit methods. It can't call Convex APIs, read the database, or use the time or randomness, and it runs again on every attempt until a replay succeeds.
- **It must work on any history.** The same migration runs on runs that stopped at any point of the old code, including runs that never reached the steps it edits. An edit whose step isn't in the history does nothing, so `insertAfter(grab, ...)` on a run that hasn't grabbed yet leaves it alone, and the run calls `notify` for real when it gets there.
- **Each migration sees the history as the previous one left it.** Steps the current code recorded later are already in the current shape, so a migration never has to tell old steps from new ones.

### The history `h`

Reading:

- `h.steps`: the steps in order, each `{ id, name, kind, args, status, result?, error? }`. `kind` is `function`, `workflow`, `event` or `sleep`. `status` is `done`, `running`, or `pending` for a step inserted with `runLate` that hasn't run.
- `h.has(step)`: whether some step is `step`.
- `h.result(step)`: the result of the only step that is `step`, or `undefined` if there's none or it didn't succeed. Typed from the function reference.

A step is named by a function reference (`internal.pipeline.grab`, matching `runQuery`, `runMutation`, `runAction` and `runWorkflow` calls of it), `{ workflow: ref }` for a `runWorkflow` call, `{ event: name }` for an `awaitEvent` and `{ sleep: name }` for a `sleep` (one without a `name` option is named `'sleep'`). A reference must match exactly one step, or the edit throws; for loops and repeated steps, pass the step itself from `h.steps`. A function the code no longer has can't be referenced through `internal`; name it with `makeFunctionReference('pipeline:prepare')` from `convex/server`.

Editing:

- `h.insertAfter(step, ref, { result })` and `h.insertBefore(...)`: insert a finished stand-in. Replay resolves the call with `result` and runs nothing. `result` is required and typed: it has to be a value the function could return, so declare the function's return type to include it (`at: number | null` above). `args`, if given, are matched against the call; without them only the name and kind are.
- `h.insertAfter(step, ref, { runLate: true, args })`: insert a step that runs, for real, when replay reaches it, and gives the call its real result.
- `h.remove(step)`: drop a step the code no longer calls.
- `h.rename(step, ref)`: the step now counts as a call to `ref`. The kind must stay the same.
- `h.updateArgs(step, (args) => newArgs)`: the args the current code passes. This is for matching only: the step ran with its old args.

A step called with a custom `name` option is matched by that name: pass `{ name }` in the insert options, and select it from `h.steps`.

**Stand-in or `runLate`?** A stand-in records what the run would have got, and runs nothing. Use it when the step's effect doesn't matter for a run that's past that point, or when you can say what it would have returned. `runLate` is opt-in. It suits a step whose real result later code needs, or one that just has to happen eventually, like a backfill or an audit record. It doesn't suit a step whose order matters: it runs when the run next replays, after everything the run already did past that point.

**Running steps.** A step a run is waiting at can't be removed, renamed or given other args: a result will still arrive into it. Inserting before or after it is fine. An edit that breaks this throws, and the run pauses. The workflow mutation doesn't replay while a step runs, so in practice a migration sees a running step only in a test history; see [Limits](#limits).

## Pausing and recovery

A run pauses instead of failing when:

- replay doesn't match its history: a change without a migration, or a missing or wrong one (reason `mismatch`);
- a migration throws, including an edit to a running step (reason `migration`);
- the ids applied to it aren't the start of the code's list: a migration was removed, renamed or reordered, or the code is older than the code the run ran on, after a rollback (reason `migrations`).

A paused run stays `inProgress` in upstream, with no step running, and `onComplete` doesn't run. Nothing partial is saved: a mismatch is found before the handler run starts any new step, and the migrations it applied in memory are dropped, so the next attempt migrates again, possibly with fixed code. (The one exception is a `runLate` step that ran in that handler run, which is kept with the migrations that inserted it.)

- **Retries.** A paused run is retried after 1 minute, 10 minutes, 1 hour, then every 6 hours, until it gets past the pause. It never gives up on its own; `fail` is explicit. A retry whose workflow mutation throws counts as another failed attempt (reason `error`).
- **Alerting.** `onPause(ctx, { workflowId, workflow, reason, detail })` is called once when a run pauses, in the transaction that pauses it, and not again on retries until the run has got past the pause. An error it throws is logged; the run stays paused. Pausing must not be quieter than failing, so set it.

On the manager:

| Action                               | Effect                                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paused(ctx, { limit? })`            | Lists paused runs, the next one due first: `workflowId`, `workflow`, `reason`, `detail`, `step` (for a mismatch, the position in the history), `at`, `attempts`, `nextAttemptAt`. For a mismatch, `detail` has the call the code made and the step the history has. |
| `resume(ctx, workflowId)`            | Retries now, for example right after deploying a fix. Returns whether the run got past its pause.                                                                                                                                                                   |
| `restartFrom(ctx, workflowId, step)` | Removes every step of the history from position `step` on, and retries: those steps run again. Throws, changing nothing, if the run would still pause.                                                                                                              |
| `cancel(ctx, workflowId)`            | Upstream's cancel, which also ends the pause. `onComplete` runs with `canceled`.                                                                                                                                                                                    |
| `fail(ctx, workflowId)`              | Completes the run as failed, with why it paused as the error. `onComplete` runs.                                                                                                                                                                                    |

The usual fix is code: deploy a release with the missing or corrected migration, then wait for the retry or call `resume`. After a rollback, roll forward: runs that paused with `migrations` resume on code whose list starts with their applied ids.

## Testing

Register both components with [convex-test](https://docs.convex.dev/testing/convex-test), then replay histories the older code recorded against the current handler. This test is from `examples/basic`:

```ts
// convex/pipeline.test.ts
/// <reference types="vite/client" />
import patchesTest, { expectReplays, history, migrate } from '@dev-marzahn/convex-workflow-patches/test';
import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';

import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import schema from './schema';

const grabId = 'k57' as Id<'grabs'>;
const release0Waiting = history(
  [
    { step: internal.pipeline.grab, args: { grabId } },
    { event: 'downloadDone', status: 'running' },
  ],
  { args: { grabId } },
);

test('runs from every older release replay on the current code', async () => {
  const t = convexTest(schema, import.meta.glob('./**/*.ts'));
  patchesTest.register(t);
  await expectReplays(t, internal.pipeline.run, [release0Waiting /* , ... */]);
});
```

- **`expectReplays(t, workflow, histories)`** replays each history, with the workflow's migrations, against its current handler. It runs no steps: replay stops where the history ends, at a running step, or at a step inserted with `runLate`. If a history doesn't replay, it throws with the history, the position, the call the code made and the step the history has there, and the migrated history.
- **`history(steps, { args, applied })`** builds a history by hand: `{ step: ref, args, result }` (or `error`) for a function call, `{ workflow: ref, ... }`, `{ event: name }` and `{ sleep: name }`, each with `status: 'running'` if the run is waiting there. `args` are the workflow's. Without `applied`, every migration applies, as for a run from before the first one.
- **`migrate(t, workflow, history)`** returns the history after the workflow's migrations, to test a single migration.
- **`npx convex-workflow-patches histories <workflow> [-- <convex options>]`** exports the histories of a workflow's running runs, and of its 10 most recent finished ones, from a deployment, as JSON that `expectReplays` takes. Run it from your app's directory, for example `npx convex-workflow-patches histories pipeline:run --out convex/histories.json -- --prod`, and commit the file next to the test. Runs that have a record include the migrations applied to them. `--recent <n>` changes how many finished runs it adds, `--max-runs <n>` how many runs it looks through (1000), and `--max-steps <n>` how many steps of a run it exports (1000; a longer run is marked `truncated`). It reads through upstream's `listSteps`, one `convex run` per run, so it's slow for many runs.

A history replays against the handler as a real handler run would, so a test can also run the current code from scratch with convex-test as usual.

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

To see a release replace another on a real backend, deploy the previous release to a throwaway self-hosted backend, start a run and leave it waiting, deploy the new release over it, then let the run finish. This repo's [`e2e/run.ts`](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/e2e/run.ts) does that with its fixture apps; copy `startBackend` from `e2e/backend.ts` and the `deploy` and `until` helpers from `e2e/run.ts`, and point them at two checkouts of your app.

## How it works

Each run has a row in the patches component: the ids of the migrations applied to it, an **overlay** of edits, and its pause, if any. Upstream's journal is append-only and its component is unchanged, so the edits live there, anchored to journal entry ids:

- `insert`, a stand-in, after or before a step, with its name, kind, args and result;
- `insertLate`, a `runLate` step, with `executedAs` set to its journal entry once it has run;
- `remove`, a step;
- `rewrite`, a step's name or args.

The run's **history** is its journal with those edits applied in order. At the start of a handler run, the vendored workflow mutation reads the row. If the code lists ids beyond those applied, it builds the history and runs the missing migrations on it, in memory. Then the handler replays against the history instead of the raw journal: a stand-in resolves its call without sending anything to upstream; a `runLate` step that hasn't run is started for real when replay reaches it, and upstream appends its entry, which takes the step's place from then on; removed steps are skipped; rewritten steps are compared by their new name and args. The deterministic `Date.now()` during replay reads the history too: a stand-in sees the time of the step before it.

If replay matches, the new ids and overlay are saved in the same transaction as the handler run's other writes. If it doesn't, nothing but the pause is saved. A new run starts with every current id applied, so it never migrates; it writes its row once, on its first handler run. Each handler run reads one row and writes it only when something changed.

Migrating early or at the next replay gives the same result: a migration changes only recorded data, and replay never runs a finished step again. That's why there's no deploy hook and no drain.

A pause records the reason and schedules a retry in the patches component, which calls the workflow mutation through its function handle with the generation the run is at: the call upstream's workpool makes after every step. The mutation returns normally after pausing, so the workpool sees a success and `onComplete` doesn't run. A retry left over from before a `restart` carries a stale generation, and the mutation ignores it.

`restart({ from })` deletes journal entries from a step on; edits anchored to deleted entries are dropped, and the ids applied stay applied, so the run replays its kept steps as before and runs the rest on the current code. `WorkflowManager.cleanup` deletes the row with the run: in the same transaction when called from a mutation, in a second one from an action.

## @convex-dev/workflow versions

Upstream's client replays the handler against the raw journal, and its package exports don't include the code that does. So this package ships a copy of that code, the client half of `@convex-dev/workflow`, with replay against the history and pausing added. The server half, the `workflow` component, isn't copied: your data lives in upstream's tables.

The copy matches one upstream release, so each release of this package needs that exact `@convex-dev/workflow` version:

| convex-workflow-patches | @convex-dev/workflow |
| ----------------------- | -------------------- |
| 100.0.x                 | 0.4.10               |

Fixes to upstream's client code arrive when this package updates its copy. Fixes to the component arrive with the version bump. A new upstream release is noticed within a week; this package follows with a release that copies it. [`VENDORED.md`](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-patches/src/vendor/workflow/VENDORED.md) lists the changes to the copy, and a test fails if the copy isn't the installed release plus those changes.

**Why a copy, and when it goes away.** Upstream has no hook for this yet: [#35](https://github.com/convex/workflow/issues/35) asks for one, and [PR #279](https://github.com/convex/workflow/pull/279) proposes version stamps on journal entries. Other options were weaker. A full fork would move your workflow data into the fork's tables. Pinning a version in each run's arguments decides at start, so a run waiting on a download never gets a fix. Patching in the handler (`if (step.patched(id))`, as Temporal, Cadence, DBOS and Dapr do it) keeps the old path in the code until every run that may need it is gone, so an installation that skips releases can't be served. If upstream ships a hook, this package becomes a thin wrapper over it or is retired. Your workflows, journals and events are already in upstream's tables. Moving off means letting the runs that have migrations or are paused finish first, then swapping `WorkflowManager` back and unmounting `workflowPatches`.

## API

| Export                                                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowManager(component, { patches, onPause?, workpoolOptions? })` | Upstream's manager. `define()` takes `migrations`. `paused`, `resume`, `restartFrom` and `fail` act on paused runs (see [Pausing and recovery](#pausing-and-recovery)), `cancel` also ends a pause, and `cleanup` also deletes the run's record. `workflow.patches` holds the component.                                                                                                                                                                                                                                            |
| `migration(id, migrate)`                                              | A migration for a workflow's `migrations` list. See [Writing migrations](#writing-migrations).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `convex-workflow-patches histories <workflow>`                        | Exports run histories from a deployment as JSON. See [Testing](#testing).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `register(t, names?)` from `/test`                                    | Registers `@convex-dev/workflow` (its workpool at `<workflow>/workpool`) and the patches component with convex-test. `names` defaults to `{ workflow: 'workflow', patches: 'workflowPatches' }`; set it if you mounted them under other names.                                                                                                                                                                                                                                                                                      |
| `expectReplays(t, workflow, histories)` from `/test`                  | Replays histories against the current handler, with the migrations. Throws on the first position that doesn't match, for each history that doesn't.                                                                                                                                                                                                                                                                                                                                                                                 |
| `history(steps, options?)` from `/test`                               | Builds a history by hand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `migrate(t, workflow, history)` from `/test`                          | The history after the workflow's migrations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| default export of `/test`                                             | `{ register, schema, modules }`, the shape of upstream's `@convex-dev/workflow/test`, for `patchesTest.register(t)`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Types                                                                 | `Migration`, `History`, `HistoryStep`, `StepRef`, `StepSelector`, `InsertOptions`, `StepArgs`, `StepResult`, `RecordedHistory`, `RecordedStep`, `OverlayOp`, `PauseReason`, `PauseInfo`, `PausedRun`, `WorkflowManagerOptions`, `PatchesComponent`, `WorkflowCtx`, `WorkflowHandler`, `WorkflowArgs` (this package's), and upstream's `WorkflowId`, `EventId`, `WorkflowStep`, `RunResult`, `RunOptions`, `StepDefaults`, `WorkflowComponent`, `WorkflowDefinition`, `WorkflowMutationResult`, `WorkflowStatus`, `CallbackOptions`. |

Upstream's other exports are re-exported unchanged, except `defineWorkflow` (use `workflow.define`) and the standalone `cleanup` (use `workflow.cleanup`, which also deletes the run's record).

### The patches component

`components.workflowPatches` has one table, `runs`: per run, its workflow function, the migration ids applied to it, its overlay and its pause. Its functions are internal: the workflow mutation, the manager and the CLI call them. Don't call them yourself.

Records of child workflows that upstream cleans up with their parent are left behind; they're harmless.

## Limits

- **Pinned upstream version.** See [versions](#convex-devworkflow-versions).
- **Migrations are checked by tests, not by the deploy.** Nothing refuses a release whose migrations are missing or wrong: its runs pause and wait for a fix. `expectReplays` with exported histories is what catches it before the deploy.
- **Running steps in test histories.** At runtime the workflow mutation doesn't replay while a step runs, so a migration only ever sees finished steps. A history exported while a run waits at a step has that step as running, and a migration that removes, renames or changes the args of it throws there, though it would apply once the step finished. Test such a migration with the step finished.
- **`runLate` steps run out of order**, after the steps the run already did past their position. If a later step of the same handler run then doesn't match, the run pauses but keeps the step and the migrations that inserted it, so a fix needs a new migration rather than a corrected one.
- **The overlay is one document** in the patches component, under Convex's 1 MiB document limit. Keep stand-in results small.
- **Matching is by position, name and args.** A migration that's wrong but leaves a call with the same name and args at the same position replays silently. So does removing a step followed by an identical call, without a migration.
- **Workflow function renames** aren't supported: each run stores a handle to its function.

## Versioning

Versions follow [Epoch SemVer](https://antfu.me/posts/epoch-semver): `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at `100.0.0`. A change to the first number can break your app; minor and patch releases don't. Moving to a new `@convex-dev/workflow` version is a minor release, unless upstream's own change breaks something; then it's a major one. [CHANGELOG.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CHANGELOG.md) lists the changes.

## Contributing

See [CONTRIBUTING.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CONTRIBUTING.md). Report vulnerabilities privately, as [SECURITY.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/SECURITY.md) describes.

## License

[MPL-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/LICENSE). The copy of `@convex-dev/workflow`'s client code in `src/vendor/workflow/` is upstream's, under [Apache-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-patches/src/vendor/workflow/LICENSE), and is marked as changed where it was changed.
