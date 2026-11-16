# convex-workflow-migrations

[![npm](https://img.shields.io/npm/v/@dev-marzahn/convex-workflow-migrations)](https://www.npmjs.com/package/@dev-marzahn/convex-workflow-migrations)
[![CI](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml)
[![License: MPL-2.0 AND Apache-2.0](https://img.shields.io/badge/license-MPL--2.0%20AND%20Apache--2.0-blue)](#license)

Change a released [`@convex-dev/workflow`](https://www.convex.dev/components/workflow) workflow without failing the runs already in flight.

`@convex-dev/workflow` replays a workflow's handler from the start every time a step finishes, and matches each step call to its journal by position. If you add a step before the step a run is waiting at, that run fails with `Journal entry mismatch`. With this package, the handler holds only its current code, and each change comes with a **migration**: a small function that rewrites a run's recorded history into the shape the current code expects.

```ts
// convex/pipeline.ts: one run per download ("grab"): grab it, notify, wait for the download, import, transcode, publish.
import { migration } from '@dev-marzahn/convex-workflow-migrations';

export const run = workflow.define({
  args: { grabId: v.id('grabs') },
  migrations: [
    // Release 1 added notify after grab. Runs already past grab count as notified.
    migration('notify-after-grab', (h) => h.insertAfter(internal.pipeline.grab, internal.pipeline.notify, { result: { at: null } })),
    // Release 2: import takes notifiedAt. Runs that already imported did so without it.
    migration('import-gets-notified-at', (h) =>
      h.updateArgs(internal.pipeline.importFiles, (args) => ({ ...args, notifiedAt: h.result(internal.pipeline.notify)?.at ?? null })),
    ),
    // Release 3: prepare was renamed to transcode. Named by its path, so this compiles once the alias below is gone.
    migration('prepare-becomes-transcode', (h) => h.rename(makeFunctionReference<'mutation'>('pipeline:prepare'), internal.pipeline.transcode)),
  ],
  handler: async (step, { grabId }): Promise<void> => {
    await step.runMutation(internal.pipeline.grab, { grabId });
    const { at } = await step.runMutation(internal.pipeline.notify, { grabId });
    await step.awaitEvent({ name: 'downloadDone' });
    await step.runMutation(internal.pipeline.importFiles, { grabId, notifiedAt: at });
    await step.runMutation(internal.pipeline.transcode, { grabId });
    await step.runMutation(internal.pipeline.publish, { grabId });
  },
});

// notify returns { at: number | null }: null for the runs the migration gives a stand-in.
// importFiles takes notifiedAt as v.optional(...): an import an older release queued runs here without it.
// For a prepare that release 2 or older queued: it runs as transcode.
export const prepare = transcode;
```

Say a run started on release 0 is waiting for its download when release 3 ships. Its journal is `grab, downloadDone`. When the download arrives, the run replays on release 3: the three migrations apply to its history, in order, so it reads `grab, notify (a finished stand-in), downloadDone`. The handler replays against that: `notify` resolves with `{ at: null }` without running, and the run goes on to `importFiles`. Releases 1 and 2 never had to be deployed.

- **Skip releases.** Every release lists every migration, and each run records which ones it has had. A run applies the ones it's missing, in order, the next time it replays. Nothing has to be deployed first, and nothing has to drain.
- **Same API otherwise.** `WorkflowManager` is upstream's, with `migrations` in `define()`. Your workflows, journals and events stay in upstream's component; this package adds a small one with a record per run: the migrations applied to it and their edits.
- **Tests against old histories.** `expectReplays` replays histories of older releases, with the migrations, against the current handler, without a Convex backend.

## Quick start

Install the package with the exact `@convex-dev/workflow` version it was built from ([versions](#convex-devworkflow-versions)):

```sh
npm install --save-exact @dev-marzahn/convex-workflow-migrations @convex-dev/workflow@0.4.10 @convex-dev/workpool convex-helpers
```

Mount both components, and create the manager from this package instead of `@convex-dev/workflow`:

```ts
// convex/convex.config.ts
import workflow from '@convex-dev/workflow/convex.config.js';
import workflowMigrations from '@dev-marzahn/convex-workflow-migrations/convex.config.js';
import { defineApp } from 'convex/server';

const app = defineApp();
app.use(workflow);
app.use(workflowMigrations);
export default app;

// convex/workflow.ts
import { WorkflowManager } from '@dev-marzahn/convex-workflow-migrations';

import { components } from './_generated/api';

export const workflow = new WorkflowManager(components.workflow, { migrationsComponent: components.workflowMigrations });
```

Import the rest from this package too: `vWorkflowId`, `defineEvent`, the types and upstream's other exports are re-exported unchanged. Three are left out: `defineWorkflow` (use `workflow.define`) and the standalone `restart` and `cleanup` (use the manager's). Define every workflow on the `workflow` component with this manager, and start runs with `workflow.start` or upstream's `start`: both go through the workflow mutation, which writes the run's record in the transaction that creates it, with `startAsync` too.

A workflow you already run needs no migrations until you change it. Its runs from before you adopted the package get a record at their next handler run, as runs from before the first migration. [`examples/basic`](https://github.com/dev-marzahn/convex-workflow-patches/tree/main/examples/basic) is the pipeline above, with its tests.

## Writing migrations

**When a change needs one.** A run waits at every step that isn't `inline`: every `runMutation`, `runQuery`, `runAction` and `runWorkflow` call, every `sleep` and every `awaitEvent`. A deploy can land during any of those waits, and the run then replays its recorded steps on the new code. So a change needs a migration if it comes before a step some live run may still be waiting at: adding, removing or reordering steps, renaming one, changing its arguments, changing the shape of what it returns, or changing the workflow's `args` validator so that old runs' args no longer pass. When unsure, write one and [test it](#testing).

**Keep step signatures and event names backward compatible.** A migration edits only the history replay matches against. A step an older release started still runs on the current deployment when it's queued, retried or scheduled, with the name and args that release gave it, and a run waiting on `awaitEvent` doesn't replay while it waits. So, for as long as runs from older releases may have them queued or waiting, which on self-hosted installations that skip releases can be a long time: keep a removed or renamed step function exported as an alias (`export const prepare = transcode`), add new arguments as `v.optional`, and keep sending the old event name.

**Normalize in `updateResult`.** Replay gives the handler the recorded result, so every change to the shape of a step's result needs an `updateResult`. The step a run was waiting at when you deployed finishes on the new code, so its result can already be in the new shape when the migration sees it: write `(r) => ('size' in r ? r : { ...r, size: null })`, not `(r) => ({ ...r, size: null })`, which overwrites a size the new code returned. The test helpers run every `updateResult` a second time on its own output and fail if that changes it.

Add each migration to the end of the workflow's `migrations` list:

- **The id is permanent.** A run stores the ids applied to it, and they must stay the start of the list: never remove, rename or reorder a migration. A duplicate id throws when the module loads, so the push fails.
- **Editing a migration's body changes only the runs still to apply it.** To change a history a migration already edited, add a new one.
- **It's synchronous and pure.** It reads `h` and calls its edit methods; no Convex APIs, database, time or randomness.
- **It must work on any history**, including runs that never reached the steps it edits: an edit whose step isn't in the history does nothing. An insert also does nothing where neither a journal entry nor another stand-in follows its place: the run hasn't got past it, and makes the call for real. Pass `atEnd: true` to insert it there too.
- **It names steps as they were at its release.** Name a step that may be renamed or deleted later with `makeFunctionReference('pipeline:prepare')` rather than through `internal`. A name the history doesn't have makes the edit do nothing; [`expectEdits`](#testing) catches that.

### The history `h`

- `h.steps`: the steps in order, each `{ id, name, kind, args, status, result?, error? }`. `kind` is `function`, `workflow`, `event` or `sleep`; `status` is `done` or `running`; `error` is a failure's message, or `'canceled'`.
- `h.workflowArgs`, `h.has(step)`, and `h.result(step)`: the result of the only step that is `step`, typed from the function reference, or `undefined`.
- **Selecting a step:** a function reference (`internal.pipeline.grab`, which matches `runQuery`, `runMutation`, `runAction` and `runWorkflow` calls of it), `{ workflow: ref }`, `{ event: name }`, `{ sleep: name }`, or a step from `h.steps`. A reference matches at most one step: several throw, none makes the edit do nothing. For repeated steps, pass the step itself from `h.steps`.
- `h.insertAfter(step, ref, { result, args?, name?, atEnd? })` and `h.insertBefore(...)`: insert a finished stand-in. Replay resolves the call with `result`, which must be a value the function could return, and runs nothing. With `args`, the call's args must match; without, only the name and kind are. A reference inserts a function call; use `{ workflow: ref }` for a child workflow.
- `h.remove(step)`: drop a step the code no longer calls.
- `h.rename(step, ref, { name }?)`: the step now counts as a call to `ref`, of the same kind.
- `h.updateArgs(step, (args) => newArgs)`: the args the current code passes, for matching only. Args are compared as JSON, so build them the way the handler does: `{ ...args, notifiedAt }`.
- `h.updateResult(step, (result) => newResult)`: the result replay gives the call. The step must have succeeded.
- `h.updateWorkflowArgs((args) => newArgs)`: the args the handler gets, for example with a new required field. The run keeps its recorded args.

A step a run is waiting at can't be removed, renamed, or given other args or another result; inserting around it is fine. At runtime a migration only sees finished steps, since the workflow mutation doesn't replay while a step runs.

### When a run can't replay

It fails, as upstream fails a run on a mismatch, with a message that says why: the code's call doesn't match the step at that position of the migrated history (a change without a migration, or a wrong one); its args, as the migrations leave them, don't pass the `args` validator; a migration throws; the ids applied to it aren't the start of the code's list (a migration removed or reordered, or a rollback); or its edits would grow past 512 KiB. Nothing of that handler run is saved. Once the code is fixed, `workflow.restart(ctx, workflowId)` replays the run again, with the fixed migrations.

## Testing

The helpers from `@dev-marzahn/convex-workflow-migrations/replay` take the workflow mutation `workflow.define` returned, and need no Convex backend, no convex-test and no Vitest configuration:

```ts
import { expectEdits, expectReplays, history, migrate } from '@dev-marzahn/convex-workflow-migrations/replay';

const release0Waiting = history(
  [
    { step: internal.pipeline.grab, args: { grabId } },
    { event: 'downloadDone', status: 'running' },
  ],
  { args: { grabId } },
);

test('runs from every older release replay on the current code', async () => {
  await expectReplays(run, [release0Waiting /* , ... */]);
});
```

- **`history(steps, { args, applied, workflowId })`** builds a history: `{ step: ref, args, result }` (or `error`, or `canceled: true`), `{ workflow: ref, ... }`, `{ event: name, result }` and `{ sleep: name }`, each with `status: 'running'` if the run is waiting there, and `name` for a custom name. A step without an outcome succeeded with `null`. Without `applied`, it's a run without a record: with steps, every migration applies; with none, its args pick, as at runtime. For a run queued on an older release, pass the ids that release listed.
- **`await expectReplays(workflow, histories)`** replays each history, with the migrations, against the current handler, and throws for each one that doesn't replay: a mismatch, args that don't validate, a migration that can't apply, an `updateResult` that changes its own output, and a handler that throws, unless the history's last step failed and the handler passes that on. Replay stops where the history ends or at a running step, and checks ids only as strings.
- **`await migrate(workflow, history)`** returns the history after the migrations. **`await expectEdits(migrate(...), ids?)`** throws unless each migration it applied, or each of `ids`, changed the history: it catches a migration whose references no longer match.

To run the current code from scratch with convex-test, `@dev-marzahn/convex-workflow-migrations/test` has `register(t)`, which registers both components, and re-exports the replay helpers. It uses `import.meta.glob`, so configure Vitest as for upstream's test helpers: the `edge-runtime` environment, and `convex-test`, `@convex-dev/workflow`, `@convex-dev/workpool` and this package in `server.deps.inline`.

## Limits

- **Migrations are checked by tests, not by the deploy.** A release with a missing or wrong migration fails the runs it can't replay. `expectReplays` is what catches it before the deploy.
- **One linear list.** A migration's input is the history the previous ones left. A rollback below the migrations a run has applied fails that run when it next replays: roll forward instead.
- **Migrations reach only the history.** Queued steps and waiting events need [compatible signatures and names](#writing-migrations).
- **A queued child's args decide.** A child workflow, or a queued run from before adoption, has no record of the migrations its creator knew, so its args pick: if they pass the current validator, no migration applies. A release that changes the meaning of args that still pass, rather than their shape, isn't seen.
- **`restart({ from })`** isn't supported yet on a run whose migrations edited its history: it throws. Without `from`, `restart` replays the whole history.
- **Child workflows' records.** When upstream deletes a run's child workflows, in `cleanup` or `restart({ from })`, their records stay behind in the migrations component. They're only storage.
- **The overlay is one document**, under 512 KiB: keep stand-in results and args small.
- **Matching is by position, name, kind and args**, as upstream's. Workflow function renames aren't supported.

## What's next

- **Pausing (PR 2):** a run that can't replay pauses and retries instead of failing, so a fix can resume it.
- **History export (PR 3):** a CLI that exports running runs' histories from a deployment, for `expectReplays`.
- **Recovery extras (PR 4):** `restart({ from })` on migrated histories, and cleanup of child workflows' records.

## @convex-dev/workflow versions

Upstream's client replays the handler against the raw journal, and its package exports don't include the code that does. So this package ships a copy of that client code, with replay against the migrated history added; the `workflow` component isn't copied, and your data lives in upstream's tables. Each release of this package needs the exact `@convex-dev/workflow` version it copied:

| convex-workflow-migrations | @convex-dev/workflow |
| -------------------------- | -------------------- |
| 100.x.x                    | 0.4.10               |

[`VENDORED.md`](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-migrations/src/vendor/workflow/VENDORED.md) lists the changes to the copy, and a test fails if the copy isn't the installed release plus those changes.

## Versioning, contributing and license

Versions follow [Epoch SemVer](https://antfu.me/posts/epoch-semver), starting at `100.0.0`: a change to the first number can break your app. [CHANGELOG.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CHANGELOG.md) lists the changes, and [CONTRIBUTING.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CONTRIBUTING.md) describes how the package works inside. Report vulnerabilities as [SECURITY.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/SECURITY.md) describes.

[MPL-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/LICENSE). The copy of `@convex-dev/workflow`'s client code in `src/vendor/workflow/` is upstream's, under [Apache-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-migrations/src/vendor/workflow/LICENSE), and is marked as changed where it was changed.
