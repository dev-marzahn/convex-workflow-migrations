# convex-workflow-migrations

[![npm](https://img.shields.io/npm/v/@dev-marzahn/convex-workflow-migrations)](https://www.npmjs.com/package/@dev-marzahn/convex-workflow-migrations)
[![CI](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml)
[![License: MPL-2.0 AND Apache-2.0](https://img.shields.io/badge/license-MPL--2.0%20AND%20Apache--2.0-blue)](#license)

Change a released [`@convex-dev/workflow`](https://www.convex.dev/components/workflow) workflow without failing the runs already in flight.

`@convex-dev/workflow` replays a workflow's handler from the start every time a step finishes (a **handler run**), and matches each step call to its journal by position. If you add a step before the step a run is waiting at, that run fails with `Journal entry mismatch`. With this package, the handler holds only its current code, and each change comes with a **migration**: a small function that rewrites a run's recorded history into the shape the current code expects.

```ts
// convex/pipeline.ts: one run per download ("grab"): grab it, notify, wait for the download, import, transcode, publish.
import { migration } from '@dev-marzahn/convex-workflow-migrations';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';

import { internal } from './_generated/api';
import { workflow } from './workflow';

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

// The step functions, internal mutations, are left out here (examples/basic has them).
// notify returns { at: number | null }: null for the runs the migration gives a stand-in.
// importFiles takes notifiedAt as v.optional(...): an import an older release queued runs here without it.
// For a prepare that release 2 or older queued: it runs as transcode.
export const prepare = transcode;
```

Say a run started on release 0 is waiting for its download when release 3 ships. Its journal is `grab, downloadDone`. When the download arrives, the run replays on release 3: the three migrations apply to its history, in order, so it reads `grab, notify (a finished stand-in), downloadDone`. The handler replays against that: `notify` resolves with `{ at: null }` without running, and the run goes on to `importFiles`. Releases 1 and 2 never had to be deployed.

- **Skip releases.** Every release lists every migration, and each run records which ones it has had. A run applies the ones it's missing, in order, the next time it replays. Nothing has to be deployed first, and nothing has to drain.
- **Same API otherwise.** `WorkflowManager` is upstream's, with `migrations` in `define()`. Your workflows, journals and events stay in upstream's component; this package adds a small one with a record per run: the migrations applied to it and their edits (the **overlay**).
- **Pause, don't fail.** A run that can't replay on the current code, because a migration is missing or wrong, pauses and is retried, so deploying the fix resumes it ([Pausing and recovery](#pausing-and-recovery)).
- **Tests against old histories.** `expectReplays` replays histories of older releases, built by hand or [exported from a deployment](#exporting-histories), with the migrations, against the current handler, without a Convex backend.

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

export const workflow = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  // Told when a run pauses instead of failing ("Pausing and recovery"). Required; null opts out.
  onPause: (_ctx, { workflowId, reason, detail }) => console.error(`Workflow ${workflowId} paused (${reason}): ${detail}`),
});
```

Import the rest from this package too: `vWorkflowId`, `defineEvent`, the types and upstream's other exports are re-exported unchanged. Three are left out: `defineWorkflow` (use `workflow.define`) and the standalone `restart` and `cleanup` (use the manager's). Upstream's standalone `cancel` is re-exported, but doesn't end a pause: use `workflow.cancel`. Define every workflow on the `workflow` component with this manager, and start runs with `workflow.start` or upstream's `start`: both go through the workflow mutation, which writes the run's record in the transaction that creates it, with `startAsync` too.

A workflow you already run needs no migrations until you change it. Its runs from before you adopted the package get a record at their next handler run, as runs from before the first migration. [`examples/basic`](https://github.com/dev-marzahn/convex-workflow-patches/tree/main/examples/basic) is the pipeline above, with its tests.

## Writing migrations

**When a change needs one.** A run waits at every step that isn't `inline`: every `runMutation`, `runQuery`, `runAction` and `runWorkflow` call, every `sleep` and every `awaitEvent`. A deploy can land during any of those waits, and the run then replays its recorded steps on the new code. So a change needs a migration if it comes before a step some live run may still be waiting at: adding, removing or reordering steps, renaming one, changing its arguments, changing the shape of what it returns, or changing the workflow's `args` validator so that old runs' args no longer pass. When unsure, write one and [test it](#testing).

**Keep step signatures and event names backward compatible.** A migration edits only the history replay matches against. A step an older release started still runs on the current deployment when it's queued, retried or scheduled, with the name and args that release gave it, and a run waiting on `awaitEvent` doesn't replay while it waits. So, for as long as runs from older releases may have them queued or waiting, which on self-hosted installations that skip releases can be a long time: keep a removed or renamed step function exported as an alias (`export const prepare = transcode`), add new arguments as `v.optional`, and keep sending the old event name.

**Normalize in `updateResult`.** Replay gives the handler the recorded result, so every change to the shape of a step's result needs an `updateResult`. The step a run was waiting at when you deployed finishes on the new code, so its result can already be in the new shape when the migration sees it: write `(r) => ('size' in r ? r : { ...r, size: null })`, not `(r) => ({ ...r, size: null })`, which overwrites a size the new code returned. The test helpers run every `updateResult` and `updateWorkflowArgs` a second time on its own output and fail if that changes it.

Add each migration to the end of the workflow's `migrations` list:

- **The id is permanent.** A run stores the ids applied to it, and they must stay the start of the list: never remove, rename or reorder a migration. A duplicate id throws when the module loads, so the push fails.
- **Editing a migration's body changes only the runs still to apply it.** To change a history a migration already edited, add a new one.
- **It's synchronous and pure.** It reads `h` and calls its edit methods; no Convex APIs, database, time or randomness.
- **It must work on any history**, including runs that never reached the steps it edits: an edit whose step isn't in the history does nothing. An insert also does nothing where neither a journal entry nor another stand-in follows its place: the run hasn't got past it, and makes the call for real. Pass `atEnd: true` to insert it there too.
- **It names steps as they were at its release.** Name a step that may be renamed or deleted later with `makeFunctionReference('pipeline:prepare')` rather than through `internal`. A name the history doesn't have makes the edit do nothing; [`expectReplays`](#testing) catches that on a history that has the step.

### The history `h`

- `h.steps`: the steps in order, each `{ id, name, kind, args, status, result?, error? }`. `kind` is `function`, `workflow`, `event` or `sleep`; `status` is `done` or `running`; `error` is a failure's message, or `'canceled'`.
- `h.workflowArgs`, `h.has(step)`, and `h.result(step)`: the result of the only step that is `step`, typed from the function reference, or `undefined`.
- **Selecting a step:** a function reference (`internal.pipeline.grab`, which matches `runQuery`, `runMutation`, `runAction` and `runWorkflow` calls of it), `{ workflow: ref }`, `{ event: name }`, `{ sleep: name }` (an unnamed sleep is named `"sleep"`), or a step from `h.steps`. A reference matches at most one step: several throw, none makes the edit do nothing. For repeated steps, pass the step itself from `h.steps`.
- `h.insertAfter(step, ref, { result, args?, name?, atEnd? })` and `h.insertBefore(...)`: insert a finished stand-in. Replay resolves the call with `result`, which must be a value the function could return, and runs nothing. With `args`, the call's args must match; without, only the name and kind are. A reference inserts a function call; use `{ workflow: ref }` for a child workflow. A stand-in for `{ event: name }` carries the value `awaitEvent` returns, which `sendEvent` sent; one for `{ sleep: name }` carries `null`.
- `h.remove(step)`: drop a step the code no longer calls.
- `h.rename(step, ref, { name }?)`: the step now counts as a call to `ref`, of the same kind. Across kinds it throws.
- `h.updateArgs(step, (args) => newArgs)`: the args the current code passes, for matching only. Args are compared as JSON, so build them the way the handler does: `{ ...args, notifiedAt }`.
- `h.updateResult(step, (result) => newResult)`: the result replay gives the call. On a failed or canceled step it throws, which pauses the run: if the handler can continue past that failure, guard it with `if (h.result(ref) !== undefined)`.
- `h.updateWorkflowArgs((args) => newArgs)`: the args the handler gets, for example with a new required field. The run keeps its recorded args.

At runtime a migration only sees finished steps: the workflow mutation doesn't replay while a step runs. A test history can have a running step, where the run waits: `remove`, `rename` and `updateArgs` edit it as they edit a finished one, and `updateResult` does nothing to it. Inserting before it works; after it, as the last step, only with `atEnd: true`.

## Pausing and recovery

A run that can't replay on the current code pauses instead of failing, with the `reason`:

- `mismatch`: a call doesn't match the step at its position of the migrated history, or the code returns before it has called every step: a change without a migration, or a wrong one;
- `args`: the workflow's args, as the migrations leave them, don't pass its `args` validator;
- `threw`: the handler threw where a migration may be the cause (below);
- `migration`: a migration threw;
- `migrations`: the ids applied to the run aren't the start of the code's list: a migration was removed, renamed or reordered, or the code was rolled back;
- `record`: the run's record edits a journal entry that something outside the `WorkflowManager` deleted, such as upstream's standalone `restart({ from })`.

The pause commits nothing of the handler run: no step starts, and the migrations it applied in memory are dropped, so the next attempt migrates again on whatever code is deployed then. `onComplete` doesn't run, and `workflow.status` shows the run as `inProgress`. To find one run's pause, page through `paused` with `workflow` set and look for its `workflowId`, as `examples/basic` does. What `onPause` records, like that example's `alerts` table, says that the run paused, not that it still is.

**When a throw pauses.** A handler that throws is either reacting to the run, which fails it as upstream would, or tripping over a migration, which pauses it. These rules decide, in order:

1. The handler run started, or queued a call to, a step past the history: the run fails. That step's start, and an inline step's writes and result, commit with the handler run, so the throw is the handler's reaction to new work.
2. A recorded step is left that the handler hasn't replayed: it pauses.
3. The last step the handler got is a stand-in, or has a result a migration changed: it pauses.
4. The newest recorded steps (those the last handler run that started any started together) include one that failed or was canceled, and that no migration removed: the run fails, even if migrations edited the history in this handler run. The handler is passing that failure on, also when a migration renamed the step or gave it new args.
5. Migrations edited the history in this handler run: it pauses.
6. Otherwise, the run fails.

A `threw` pause's detail names its rule. Rules 3 and 5 can't tell a deliberate throw from one a migration caused: a handler that throws on purpose on a last result a migration changed correctly, or in the handler run where migrations first apply, pauses, and again at every retry, since a pause saves nothing. `fail` the run to recover.

**Retries.** A paused run is retried after about 1 minute, 10 minutes, 1 hour, then every 6 hours, each ±20%, until it gets past its pause; it never gives up on its own. An attempt that dies, even on a Convex limit, still leaves the next retry scheduled, with `lastError` saying it didn't complete. When the workflow mutation throws during a scheduled retry, for example on a save over the document size limit, the run stays paused, with the error in `lastError`, and `onPause` isn't called. Every handler run that pauses logs a warning, shown at the workflow component's log level `WARN` or lower.

**`onPause`** is a required option of the manager, since nothing else reports a paused run; `null` opts out. It's called with `{ workflowId, reason, detail, step?, attempts }` in the transaction that pauses the run, and again when a retry or `resume` pauses it with another reason, step or detail. `ctx` is the workflow mutation's: cast it to your `MutationCtx`. Its writes commit with the pause, even those made before an error it throws, which is logged while the run stays paused; to make them all-or-nothing, make them in a `ctx.runMutation`.

- `detail` says why, naming the throw rule for `threw`, and can hold step args. It's cut to 24,576 characters, and a mismatch's call and step to 8,192 each.
- `step` is the 0-based position in the migrated history, for a mismatch and the throw rules 2 and 3.
- `attempts` is 1 at the first pause, plus 1 per scheduled retry; `resume` doesn't count.

The manager's methods for paused runs:

- **`paused(ctx, { workflow?, cursor?, numItems? })`**, from a query: a page of paused runs, `{ page, isDone, continueCursor }`, the one that paused first first. `workflow` is the workflow's function name as Convex names it, like `'pipeline:run'` for `export const run` in `convex/pipeline.ts`; a wrong name returns an empty page. `numItems` defaults to 100; pass `continueCursor` as `cursor` for the next page. Each run has `workflowId`, `workflow`, `reason`, `detail`, `step`, `at` (when it first paused, in ms), `attempts`, `nextAttemptAt` (in ms) and `lastError`.
- **`resume(ctx, workflowId)`** retries the run now, in one transaction, without counting an attempt or moving the next retry. It returns `true` only when the run replayed past its pause, and `false` when it paused again, or when the pause ended without a replay: the run finished, was canceled bypassing the manager (upstream's standalone `cancel`, or a parent's cancel), is at another generation, or is gone. It throws if the run isn't paused, and passes on an error from the workflow mutation.
- **`fail(ctx, workflowId, reason?)`**, from a mutation: completes the run as failed and ends the pause, in the caller's transaction, and `onComplete` runs with the failure. The error is `reason`, or else `Paused (<reason>): <detail>`. For a run upstream already finished, it only ends the pause. It throws if the run isn't paused.
- **`cancel(ctx, workflowId)`**: upstream's cancel, which also ends the pause. `cleanup` deletes the pause with the record.

The usual fix is code: deploy a release with the missing or corrected migration, then wait for the retry, or resume the run. After a rollback, roll forward. Expose the methods as internal functions to call them after a deploy, or from the dashboard:

```ts
// convex/admin.ts
import { vWorkflowId } from '@dev-marzahn/convex-workflow-migrations';
import { v } from 'convex/values';

import { internalMutation } from './_generated/server';
import { workflow } from './workflow';

export const resume = internalMutation({
  args: { workflowId: vWorkflowId },
  returns: v.boolean(),
  handler: (ctx, { workflowId }) => workflow.resume(ctx, workflowId),
});
```

```sh
npx convex deploy && npx convex run --prod admin:resume '{"workflowId": "..."}'
```

## Testing

The helpers from `@dev-marzahn/convex-workflow-migrations/replay` take the workflow mutation `workflow.define` returned, and need no Convex backend, no convex-test and no Vitest configuration:

```ts
// convex/pipeline.test.ts
import { expectReplays, history } from '@dev-marzahn/convex-workflow-migrations/replay';
import { test } from 'vitest';

import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { run } from './pipeline';

const grabId = 'k57' as Id<'grabs'>;
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

- **`history(steps, { args, applied, workflowId })`** builds a history: `{ step: ref, args, result }` (or `error`, or `canceled: true`), `{ workflow: ref, ... }`, `{ event: name, result }` and `{ sleep: name }`, each with `status: 'running'` if the run is waiting there ([what migrations do to it](#the-history-h)), `startedAt` for its start time (default: its position), and `name` for a custom name. An `awaitEvent({ id })` step records `{ eventId }` as its args, so give it `args: { eventId }`; without a `name`, it's named by its id. A step without an outcome succeeded with `null`.
- **`applied`**: for a run started on a release that already used this package, pass the ids that release listed, whether or not the run has steps yet. Leave it out only for a run from before adoption and for a child workflow, which have no record: with steps, every migration applies; with none, the args decide: if they pass the current validator, no migration applies; otherwise all do.
- **`await expectReplays(workflow, histories)`** replays each history, with the migrations, against the current handler, and throws for each one that doesn't replay, with the reason the run would pause, as at runtime, or `(fails)` for a handler that throws and would fail the run; for a throw, the report names the throw rule. A handler passing on a failure (rule 4) replays. A return value that fails the `returns` validator, which fails the run, is reported as `(returns)`, even after a failure. An `updateResult` or `updateWorkflowArgs` that changes its own output fails too. Replay stops where the history ends or at a running step, and checks ids only as strings.
- **`migrate(workflow, history)`** returns the history `h` after the migrations, to check what they did. It throws if they can't be applied, or the history is `truncated` or `unstable` ([exported](#exporting-histories)).

To run the current code from scratch with convex-test, `@dev-marzahn/convex-workflow-migrations/test` has `register(t)`, which registers both components; the helpers above come from `/replay`. It uses `import.meta.glob`, so configure Vitest as for upstream's test helpers: the `edge-runtime` environment, and `convex-test`, `@convex-dev/workflow`, `@convex-dev/workpool` and this package in `server.deps.inline`.

## Exporting histories

The package's `histories` CLI exports a workflow's runs from a deployment as JSON `RecordedHistory[]`, for `expectReplays`: every running run, paused ones included, and the newest that succeeded. Run it from your app's directory: it runs your app's `convex` CLI, which picks the deployment as usual (`.env.local`, `CONVEX_DEPLOY_KEY`, `CONVEX_SELF_HOSTED_*`). Options after `--` go to every `convex` command it runs, so pass only ones that select the deployment: `--prod`, `--deployment-name`, `--env-file`, or `--url` with `--admin-key`.

```sh
npx convex-workflow-migrations histories pipeline:run --out convex/histories/pipeline.json -- --prod
```

The workflow is named by its function path, `pipeline:run`; upstream lists runs by the name it stored, so `internal.pipeline.run` finds none.

- `--recent <n>`: the newest runs that succeeded to export too, by creation time (default 10). Failed and canceled runs never replay, so they're left out.
- `--max-scan <n>`: how many runs to read, newest first, finished ones included (default 10,000). Upstream has no index by status, so this is how it finds the running ones. If the workflow has more, older running runs may be missing: it says how many it read, exports nothing and exits with 1, unless you pass `--allow-partial`. A partial export isn't marked in the file.
- `--max-steps <n>`: the steps to export per run (default 1,000). A longer run is cut there and marked `truncated`. A run whose journal is over 8 MiB, too big to load, is left out, with a note naming it.
- `--out <file>`: write the JSON there, creating its directory, which is checked before the scan. Without it, the JSON goes to stdout, so in CI it can end up in logs.
- `--before-adoption`: the app has no migrations component yet, so every run is exported without `applied`, as a run from before adoption. The CLI exits with 2 when the component is missing without this option, or deployed with it. `--workflow-component` and `--migrations-component` name the components if you mounted them under other names.

Each history has the run's `workflowId`, `args` and `steps`, from upstream's journal; `applied` and `overlay`, from its record; `encoding: 'json'`, so that `/replay` decodes the int64s, bytes and special floats `convex run` printed; `truncated`; and `unstable` if its record changed each of the 3 times the CLI read the journal, so the two may not match. `expectReplays` and `migrate` fail a `truncated` or `unstable` history, and `expectReplays` throws on an empty list. The CLI exits with:

- 0 when it exported, also a partial export with `--allow-partial`;
- 1 when `--max-scan` stopped it, without `--allow-partial`;
- 2 on a usage, deployment or file-write error, or when there are no runs of that name.

A paused run is exported with the migrations applied before it paused, so `expectReplays` on it confirms a fix before you deploy it. A succeeded run covers the full path, so migrations that edit later steps get exercised: if one fails on it, a running run that reaches that point would hit the same problem. Export before each release, and keep the older exports: their `applied` stays the start of the growing list, so they stay valid as histories of older releases.

To import the file, enable `resolveJsonModule` in `convex/tsconfig.json`:

```ts
// convex/pipeline.test.ts
import { expectReplays, type RecordedHistory } from '@dev-marzahn/convex-workflow-migrations/replay';
import { test } from 'vitest';

import exported from './histories/pipeline.json';
import { run } from './pipeline';

test('exported runs replay on the current code', async () => {
  await expectReplays(run, exported as RecordedHistory[]);
});
```

**The export holds production data:** every run's args, every step's args, result and error, and the overlay's values. Check it before you commit it. Removing a whole history is safe. Editing a value changes what's replayed: a step's args must stay what the handler computes from the run's args and earlier results, and a result must stay a value the function could return. Or export from a staging deployment.

## Limits

- **Migrations are checked by tests, not by the deploy.** A release with a missing or wrong migration pauses the runs it can't replay, until a fix is deployed. `expectReplays` is what catches it before the deploy.
- **One linear list.** A migration's input is the history the previous ones left. A rollback below the migrations a run has applied pauses that run when it next replays: roll forward instead.
- **A paused child stalls its parent**, whose `runWorkflow` step runs until the child finishes; `fail` or `cancel` on the child releases it. A child whose args still fail its validator after every migration pauses with `args`, where upstream would fail it, and stalls its parent too: `fail` on the child is the recovery. A paused run canceled bypassing the manager (upstream's standalone `cancel`, or a parent's cancel) keeps its pause until its next retry, which ends it.
- **A deliberate throw can pause.** A handler that throws on purpose in the handler run where migrations first apply (throw rule 5), or on a last step's result a migration changed correctly (rule 3), pauses, and again at every retry, since a pause saves nothing. The detail names the rule; `fail` is the recovery.
- **Migrations reach only the history.** Queued steps and waiting events need [compatible signatures and names](#writing-migrations).
- **A queued child's args decide.** A child workflow, or a queued run from before adoption, has no record of the migrations its creator knew, so its args pick: if they pass the current validator, no migration applies; otherwise every one does, so an `updateWorkflowArgs` must leave args already in a later shape unchanged. A release that changes the meaning of args that still pass, rather than their shape, isn't seen.
- **`restart({ from })`** isn't supported yet on a run whose migrations edited its history: it throws. Without `from`, `restart` replays the whole history.
- **Child workflows' records.** When upstream deletes a run's child workflows, in `cleanup` or `restart({ from })`, their records stay behind in the migrations component. They're only storage.
- **The record is one document.** The overlay stores every stand-in result and every migrated result or args value, so together they must fit Convex's document size limit. A save over it fails the run in a handler run the workpool started; in a scheduled retry, the run stays paused with the error in `lastError`, and `resume` throws it. Keep them small.
- **Matching is by position, name, kind and args**, as upstream's. Workflow function renames aren't supported.
- **The export lists runs by name.** Each page of upstream's listing holds 100 full workflow documents, with their args and results, so very large ones can hit Convex's read limits, and the CLI exits with 2. Upstream names a child workflow after its `runWorkflow` step, so a child started with a custom `name` isn't listed under its function name.

## What's next

- **Scrubbing exports:** a `--redact` option for the `histories` CLI, to scrub production data before it's committed.
- **More recovery methods:** `resumeAll` after a deploy, `restartFrom` a position of a paused run's history, `restart({ from })` on migrated histories, and cleanup of child workflows' records.

## @convex-dev/workflow versions

Upstream's client replays the handler against the raw journal, and its package exports don't include the code that does. So this package ships a copy of that client code, with replay against the migrated history added; the `workflow` component isn't copied, and your data lives in upstream's tables. Each release of this package needs the exact `@convex-dev/workflow` version it copied:

| convex-workflow-migrations | @convex-dev/workflow |
| -------------------------- | -------------------- |
| 100.x.x                    | 0.4.10               |

[`VENDORED.md`](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-migrations/src/vendor/workflow/VENDORED.md) lists the changes to the copy, and a test fails if the copy isn't the installed release plus those changes.

## Versioning, contributing and license

Versions follow [Epoch SemVer](https://antfu.me/posts/epoch-semver), starting at `100.0.0`: a change to the first number can break your app. [CHANGELOG.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CHANGELOG.md) lists the changes, and [CONTRIBUTING.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CONTRIBUTING.md) describes how the package works inside. Report vulnerabilities as [SECURITY.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/SECURITY.md) describes.

[MPL-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/LICENSE). The copy of `@convex-dev/workflow`'s client code in `src/vendor/workflow/` is upstream's, under [Apache-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-migrations/src/vendor/workflow/LICENSE), and is marked as changed where it was changed.
