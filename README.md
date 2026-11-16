# convex-workflow-migrations

[![npm](https://img.shields.io/npm/v/@dev-marzahn/convex-workflow-migrations)](https://www.npmjs.com/package/@dev-marzahn/convex-workflow-migrations)
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
    await step.runMutation(internal.pipeline.transcode, { grabId });
    await step.runMutation(internal.pipeline.publish, { grabId });
  },
});
```

Say a run started on release 0 is waiting for its download when release 3 ships. Its journal is `grab, downloadDone`. When the download arrives, the run replays on release 3: the three migrations apply to its history in order, so it reads `grab, notify (a finished stand-in), downloadDone`, and the handler replays against that. `notify` resolves with `{ at: null }` without running, and the run goes on to `importFiles`. Releases 1 and 2 never had to be deployed.

- **Skip releases.** Every release lists every migration, and each run records which ones it has had. A run applies the ones it's missing, in order, the next time it replays. Nothing has to be deployed first, and nothing has to drain.
- **Pause instead of fail.** A run whose history doesn't match the code (a change without a migration, a wrong migration, a rollback) is paused, not failed. A pause commits nothing. The run is retried with backoff, so deploying a fix resumes it, and `onPause` tells you it happened.
- **Same API otherwise.** `WorkflowManager` is `@convex-dev/workflow`'s, with `migrations` in `define()` and methods for paused runs. `start`, `sendEvent`, `status`, `listSteps` and the rest are upstream's.
- **Upstream's component.** Your workflows, journals and events stay in the `@convex-dev/workflow` component, unchanged. This package adds a small component with one row per run: the migrations applied to it, their edits, and its pause.
- **Tests against real histories.** `expectReplays` replays recorded histories, with the migrations, against the current handler in convex-test, and `npx convex-workflow-migrations histories` exports them from a deployment.

## Contents

- [Quick start](#quick-start)
- [Terms](#terms)
- [Writing migrations](#writing-migrations)
- [Pausing and recovery](#pausing-and-recovery)
- [Testing](#testing)
- [Goals, non-goals and risks](#goals-non-goals-and-risks)
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
npm install @dev-marzahn/convex-workflow-migrations @convex-dev/workflow@0.4.10 @convex-dev/workpool convex-helpers
```

Mount both components:

```ts
// convex/convex.config.ts
import workflow from '@convex-dev/workflow/convex.config.js';
import workflowMigrations from '@dev-marzahn/convex-workflow-migrations/convex.config.js';
import { defineApp } from 'convex/server';

const app = defineApp();
app.use(workflow);
app.use(workflowMigrations);
export default app;
```

Then create the manager from this package instead of `@convex-dev/workflow`:

```ts
// convex/workflow.ts
import { WorkflowManager } from '@dev-marzahn/convex-workflow-migrations';

import { components } from './_generated/api';

export const workflow = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  // A paused run isn't failed, so nothing else reports it. Alert here.
  onPause: async (ctx, { workflowId, workflow, reason, detail }) => {
    console.error(`Workflow ${workflow} ${workflowId} paused (${reason}): ${detail}`);
  },
});
```

Define workflows with `workflow.define`, as with upstream. A workflow you already run needs no migrations until you change it. Runs it started before you adopted this package replay as they did, and count as runs from before the first migration you add.

Every workflow on the `workflow` component should be defined with this manager. Runs defined elsewhere, for example with upstream's `defineWorkflow`, don't migrate and fail on a mismatch as before.

[`examples/basic`](https://github.com/dev-marzahn/convex-workflow-patches/tree/main/examples/basic) is a runnable version of the pipeline above, with its tests: each step logs its name on the grab, and `startGrab` and `downloadDone` start and resume it. From the repo root, run `bun install`, `bun run build` (the example imports the built package), then `bun run --cwd examples/basic test`.

## Terms

- **Workflow mutation**: the internal mutation `workflow.define` returns. Upstream's component calls it to start a run and again after every step finishes.
- **Handler run**: one call of the workflow mutation. It replays the handler from the start against the run's history, and starts the steps that come after it.
- **History**: the run's journal, the steps upstream recorded, with the edits of its migrations applied. Positions in it count from 0.
- **Generation**: upstream's counter of a run's restarts. A call of the workflow mutation for an older generation does nothing.

## Writing migrations

**When a change needs one.** A run waits at every step that isn't `inline` until the step finishes: every `runMutation`, `runQuery`, `runAction` and `runWorkflow` call, every `sleep` and every `awaitEvent`. A deploy can land during any of those waits, and then the run replays its recorded steps on the new code. So a change needs a migration if it comes before a step some live run may still be waiting at: adding, removing or reordering steps, renaming a step, changing a step's arguments, changing the shape of what a step returns, or changing the workflow's own `args` validator. A change after the last step any live run could have reached needs none. When unsure, write one and [test it](#testing) against histories from the old code.

Add it to the end of the workflow's `migrations` list:

```ts
migration('notify-after-grab', (h) => h.insertAfter(internal.pipeline.grab, internal.pipeline.notify, { result: { at: null } }));
```

- **The id is permanent.** A run stores the ids applied to it, and its applied ids must stay the start of the list. Never remove, rename or reorder a migration, even an old one: a run that has it would [pause](#pausing-and-recovery). Ids only need to be unique within the workflow; an empty id throws, and a duplicate throws when the module loads, so the push fails.
- **Migrations stay.** They're small, and a run from any older release may still need them. There's no retirement yet. A minimum supported release, below which old migrations could be squashed into one, may come later.
- **`migrate(h)` is synchronous and pure.** It reads `h` and calls its edit methods. It can't call Convex APIs, read the database, or use the time or randomness, and it runs again on every attempt until a replay succeeds.
- **It must work on any history.** The same migration runs on runs that stopped at any point of the old code, including runs that never reached the steps it edits. An edit whose step isn't in the history does nothing, so `insertAfter(grab, ...)` on a run that hasn't grabbed yet leaves it alone, and the run calls `notify` for real when it gets there.
- **Each migration sees the history as the previous one left it.** Steps the current code recorded later are already in the current shape, so a migration never has to tell old steps from new ones.
- **It names steps as they were at its own release.** Later code may rename or delete a function, and old migrations must keep compiling and keep matching. Name a step that may change with `makeFunctionReference('pipeline:prepare')` from `convex/server` rather than through `internal`. A reference to a name the history doesn't have makes the edit do nothing, silently; [`expectEdits`](#testing) catches it.

### The history `h`

Reading:

- `h.steps`: the steps in order, each `{ id, name, kind, args, status, result?, error? }`. `kind` is `function`, `workflow`, `event` or `sleep`. `status` is `done` or `running`.
- `h.workflowArgs`: the workflow's arguments.
- `h.has(step)`: whether some step is `step`.
- `h.result(step)`: the result of the only step that is `step`, or `undefined` if there's none or it didn't succeed. Typed from the function reference.

A step is named by a function reference, `{ workflow: ref }` for a `runWorkflow` call, `{ event: name }` for an `awaitEvent` and `{ sleep: name }` for a `sleep`. An `awaitEvent` is named by its `name` option, or by its event id if it has none; a `sleep` without a `name` option is named `'sleep'`. Selecting a step, a function reference (`internal.pipeline.grab`) matches `runQuery`, `runMutation`, `runAction` and `runWorkflow` calls of it; matching ignores which of those it is. A reference matches at most one step: several matches throw, and none makes the edit do nothing. For loops and repeated steps, pass the step itself from `h.steps`; a step an earlier edit of the same migration removed throws.

Editing:

- `h.insertAfter(step, ref, { result })` and `h.insertBefore(...)`: insert a finished stand-in. Replay resolves the call with `result` and runs nothing. `result` is required and typed: it has to be a value the function could return, so declare the function's return type to include it (`at: number | null` above). `args`, if given, are matched against the call; without them only the name and kind are. A function reference inserts a function call: insert a child workflow with `{ workflow: ref }`, and its result is typed from the child's return value. Only stand-ins can be inserted; a migration can't insert a step that runs.
- `h.remove(step)`: drop a step the code no longer calls.
- `h.rename(step, ref)`: the step now counts as a call to `ref`. The kind must stay the same.
- `h.updateArgs(step, (args) => newArgs)`: the args the current code passes. This is for matching only: the step ran with its old args.
- `h.updateResult(step, (result) => newResult)`: the result replay gives the call, for a step whose return value changed shape, or a stand-in whose result was wrong. The step must have succeeded.
- `h.updateWorkflowArgs((args) => newArgs)`: the workflow's arguments as the current `args` validator expects them, for example with a new required field. Replay passes these to the handler; the run keeps its recorded args, so `status` and `list` still show them.

A step called with a custom `name` option is matched by that name: pass `{ name }` in the insert options, and select it from `h.steps`.

**Running steps.** A step a run is waiting at can't be removed, renamed, or given other args or another result: a result will still arrive into it. Inserting before or after it is fine. An edit that breaks this throws, and the run pauses. The workflow mutation doesn't replay while a step runs, so in practice a migration sees a running step only in a test history; see [Limits](#limits).

## Pausing and recovery

A run pauses instead of failing when, with the `reason` it pauses with:

- replay doesn't match its history: a change without a migration, or a missing or wrong one. That includes code that returns before replaying every step of its history (`mismatch`);
- the workflow's arguments don't match its `args` validator and the run has history, for example after a new required field without `updateWorkflowArgs` (`args`). A new run with arguments that don't match is refused when it starts, as upstream's is;
- the handler throws while replaying, before it has reached the run's newest recorded step, or right after a step a migration inserted or changed, or in the handler run in which migrations edited its history (`threw`). Any of these can come from a migration: a stand-in or a result of the wrong shape, for example. A throw after the newest recorded step, when no migration was just applied, is the handler's reaction to that step, and fails the run as before;
- a migration throws, including an edit to a running step (`migration`);
- the ids applied to it aren't the start of the code's list: a migration was removed, renamed or reordered, or the code is older than the code the run ran on (`migrations`). A run whose record a newer version of this package wrote pauses the same way;
- the migrations make the run's overlay bigger than 512 KiB (`overlay`).

A pause commits nothing. A paused run stays `inProgress` in upstream, with no step running, and `onComplete` doesn't run. Calls are matched in order, and a handler run starts new steps only after the last step of the history, so every pause happens before the handler run starts one. The migrations it applied in memory are dropped too, so the next attempt migrates again, possibly with fixed code.

- **Retries.** A paused run is retried after 1 minute, 10 minutes, 1 hour, then every 6 hours, until it gets past the pause. It never gives up on its own; `fail` is explicit. A retry whose workflow mutation throws counts as another failed attempt (reason `error`). Every attempt that pauses logs a warning.
- **Alerting.** `onPause(ctx, { workflowId, workflow, reason, detail })` is called once when a run pauses, in the transaction that pauses it, and not again on retries until the run has got past the pause. An error it throws is logged, the writes it made before are kept, and the run stays paused. Pausing must not be quieter than failing, so set it.

Methods on the manager. Their errors reach the caller.

| Method                                           | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paused(ctx, { workflow?, cursor?, numItems? })` | A page of paused runs, the next one due first: `{ page, isDone, continueCursor }`, 100 runs unless `numItems` says otherwise. `workflow` is a function name, like `pipeline:run`. Each run has `workflowId`, `workflow`, `reason`, `detail`, `step` (for a mismatch or a throw, the position in the history), `at` (when it first paused), `attempts` and `nextAttemptAt`. For a mismatch, `detail` has the call the code made and the step the history has. |
| `resume(ctx, workflowId)`                        | Retries now, for example right after deploying a fix. Returns whether the run got past its pause. Throws if the run isn't paused.                                                                                                                                                                                                                                                                                                                            |
| `resumeAll(ctx, { workflow? })`                  | Schedules a retry, now, of every paused run, or of one workflow's. Each retry is its own transaction, and one that throws counts as a failed attempt.                                                                                                                                                                                                                                                                                                        |
| `restartFrom(ctx, workflowId, step)`             | Removes every step of the history from position `step` on, and retries: those steps run again. Throws, changing nothing, if the run isn't paused or would still pause.                                                                                                                                                                                                                                                                                       |
| `fail(ctx, workflowId)`                          | Completes the run as failed, with why it paused as the error. `onComplete` runs. Throws if the run isn't paused. From an action, ending the pause and failing the run are two transactions.                                                                                                                                                                                                                                                                  |
| `cancel(ctx, workflowId)`                        | Upstream's cancel, which also ends the pause. `onComplete` runs with `canceled`. From an action, those are two transactions.                                                                                                                                                                                                                                                                                                                                 |

The usual fix is code: deploy a release with the missing or corrected migration, then wait for the retry or call `resumeAll`. After a rollback, roll forward: runs that paused with `migrations` resume on code whose list starts with their applied ids.

`resumeAll` and the others need a function to call them from. Expose them as internal functions and run them after a deploy:

```ts
// convex/admin.ts
import { internalMutation } from './_generated/server';
import { workflow } from './workflow';

export const resumePaused = internalMutation({ args: {}, handler: (ctx) => workflow.resumeAll(ctx) });
```

```sh
npx convex deploy && npx convex run admin:resumePaused
```

**What `restartFrom` does.** It keeps the steps before `step` and runs the rest again, on the current code. The removed steps stay in upstream's journal, hidden, so they still count towards its size limit. An `awaitEvent` that runs again waits for a new event: the old one was consumed. A `runWorkflow` that runs again starts a new child; the old one isn't canceled. `step` is a position in the history as the current code migrates it, which `paused` reports: after you deploy another migration, read it from `paused` again.

**Self-hosted installations.** When you ship a product that others run, you can't export histories from their deployments. Test against histories built by hand with `history()`, or record them by running an old release's handler in convex-test and reading the journal with `listSteps`. A fix reaches an installation with its next upgrade, which can skip releases; run `resumeAll` after it, for example from the same script that deploys.

## Testing

Register both components with [convex-test](https://docs.convex.dev/testing/convex-test), then replay histories the older code recorded against the current handler. This test is adapted from `examples/basic`:

```ts
// convex/pipeline.test.ts
/// <reference types="vite/client" />
import migrationsTest, { expectReplays, history } from '@dev-marzahn/convex-workflow-migrations/test';
import { convexTest } from 'convex-test';
import { test } from 'vitest';

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
  migrationsTest.register(t);
  await expectReplays(t, internal.pipeline.run, [release0Waiting /* , ... */]);
});
```

- **`expectReplays(t, workflow, histories)`** replays each history, with the workflow's migrations, against its current handler, by the rules a handler run follows: a mismatch, an early return, a throw that would pause the run, args that don't validate and a migration that throws all fail it. It checks the args without the database, so ids only as strings. It runs no steps: replay stops where the history ends or at a running step. A throw after the history is used up passes, unless the history's `outcome` says the run succeeded; for a run that failed, only a throw before its last recorded step fails. A `truncated` history fails: export it with a larger `--max-steps`. If a history doesn't replay, it throws with the history, the reason, the position, the call the code made and the step the history has there, and the migrated history.
- **`history(steps, { args, applied, workflowId, outcome })`** builds a history by hand: `{ step: ref, args, result }` (or `error`) for a function call, `{ workflow: ref, ... }`, `{ event: name }` and `{ sleep: name }`, each with `status: 'running'` if the run is waiting there. A step without `result`, `error` or `status` succeeded with `null`. Steps get ids `h0`, `h1`, … and start times 0, 1, …. `args` are the workflow's, `{}` by default. Without `applied`, every migration applies, as for a run from before the first one. `workflowId` labels the history in failures, and `outcome` (`success`, `failed` or `canceled`) says how a finished run ended.
- **`migrate(t, workflow, history)`** returns the history after the workflow's migrations, to test a single migration. It throws if they can't be applied.
- **`expectEdits(migrate(...), ids?)`** throws unless each migration that `migrate` applied changed the history, or, with `ids`, unless those ones ran and did. Use it with a history that has the steps the migration edits, to catch a migration whose references no longer match anything.
- **`npx convex-workflow-migrations histories <workflow> [-- <convex options>]`** exports the histories of a workflow's running runs, and of its 10 most recent finished ones, from a deployment, as JSON that `expectReplays` takes. Run it from your app's directory, for example `npx convex-workflow-migrations histories pipeline:run --out convex/histories.json -- --prod`. Runs that have a record include the migrations applied to them, and finished runs their `outcome`. Options:
  - `--recent <n>`: how many finished runs it adds (10);
  - `--max-runs <n>`: how many runs it looks through, newest first (1000);
  - `--max-steps <n>`: how many steps of a run it exports (1000, at least 1; a longer run is marked `truncated`);
  - `--redact <module>`: scrubs the export (below);
  - `--out <file>`: writes to a file instead of stdout;
  - `--workflow-component <name>` and `--migrations-component <name>`: where the components are mounted (`workflow`, `workflowMigrations`);
  - options after `--` go to every `convex` command it runs.

  It reads through upstream's `listSteps` and this package's record, two `convex run` calls per run, so it's slow for many runs.

**Exports hold production data.** Every run's args, and every step's args, result and error, are in the file, and the CLI says so on stderr. Check the file before you commit it, or scrub it: `--redact ./redact.ts` loads a module whose default export takes each step, and each run's args with `kind: 'run'`, as `{ kind, name, args, result?, error? }`, and returns them scrubbed (the type is `Redactable`). Replay compares step args with the calls the handler makes from the workflow's args, so scrub both the same way: a step's args must come out as the handler passes them for the scrubbed workflow args.

A history replays against the handler as a real handler run would, so a test can also run the current code from scratch with convex-test as usual.

Configure Vitest for convex-test: install `convex-test`, `vitest` and `@edge-runtime/vm`, and inline the packages whose test helpers use `import.meta.glob`:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test', '@convex-dev/workflow', '@convex-dev/workpool', '@dev-marzahn/convex-workflow-migrations'] } },
  },
});
```

To see a release replace another on a real backend, start a throwaway self-hosted backend in Docker, deploy the previous release to it with `npx convex deploy`, start a run and leave it waiting, deploy the new release over it, then let the run finish and check what ran. This repo's [`e2e/run.ts`](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/e2e/run.ts) does that with its fixture apps.

## Goals, non-goals and risks

Goals:

- A run from any older release replays on the newest code, given the migrations, without any release in between being deployed first. Self-hosted installations skip releases.
- A wrong or missing migration pauses runs instead of failing them, and a pause commits nothing, so a fix can resume them.
- Workflow data stays in upstream's component.

Non-goals:

- Checking migrations at deploy time. Tests do that; see [Limits](#limits).
- Steps inserted to run for real. Inserted steps are stand-ins.
- Parallel lines of migrations.

Risks, and what to do about them:

- **Workflow args.** Changing the `args` validator pauses every run that has history until a migration gives them args that match (`updateWorkflowArgs`).
- **Throws.** A throw during replay can't always be told apart from the handler's reaction to new input. The rules above pause when a migration could be the cause; a throw in a later handler run, after the migrations were saved, fails the run.
- **Hotfix lines.** [Migrations form one linear list.](#limits)
- **Rollbacks.** [They pause the runs started on newer code.](#limits)
- **Exported data.** [Exports hold production data.](#testing)

## How it works

Each run has a row in the migrations component: the ids of the migrations applied to it, an **overlay** of edits, its pause, if any, and the format of the row. Upstream's journal is append-only and its component is unchanged, so the edits live there, anchored to journal entry ids:

- `insert`, a stand-in, after or before a step, with its name, kind, args and result;
- `remove`, a step;
- `truncate`, a range of journal entries, which `restartFrom` hides in one edit;
- `rewrite`, a step's name, args or result;
- `workflowArgs`, the workflow's arguments.

The run's **history** is its journal with those edits applied in order. At the start of a handler run, the vendored workflow mutation reads the row. If the code lists ids beyond those applied, it builds the history and runs the missing migrations on it, in memory. Then the handler replays against the history instead of the raw journal: a stand-in resolves its call without sending anything to upstream; removed steps are skipped; rewritten steps are compared by their new name and args and resolve with their new result. The deterministic `Date.now()` during replay reads the history too: a stand-in sees the time of the step before it.

If replay matches, the new ids and overlay are saved in the same transaction as the handler run's other writes. If it doesn't, nothing but the pause is saved. A new run starts with every current id applied, so it never migrates; it writes its row once, on its first handler run. Each handler run reads one row and writes it only when something changed.

Migrating early or at the next replay gives the same result: a migration changes only recorded data, and replay never runs a finished step again. That's why there's no deploy hook and no drain.

A pause records the reason and schedules a retry in the migrations component, which calls the workflow mutation through its function handle with the generation the run is at: the call upstream's workpool makes after every step. The mutation returns normally after pausing, so the workpool sees a success and `onComplete` doesn't run. A retry left over from before a restart carries a stale generation, and the mutation ignores it.

`workflow.restart(ctx, workflowId, { from })` is upstream's restart of a finished run, with `from` in the history: a position, or a step name or reference, meaning its last occurrence. The manager works out the journal entry upstream deletes from, the first recorded step at or after that position, and rewrites the overlay so the steps before it stay as they were, re-anchoring stand-ins whose anchor is deleted and dropping the ones from `from` on. So a stand-in at `from` or after runs for real. The history is the one the run's last handler run left; migrations a newer release added apply after the restart. A paused run isn't finished: use `restartFrom`. From an action, the overlay is saved in a transaction before the restart. `WorkflowManager.cleanup` deletes the row with the run: in the same transaction when called from a mutation, in a second one from an action.

## @convex-dev/workflow versions

Upstream's client replays the handler against the raw journal, and its package exports don't include the code that does. So this package ships a copy of that code, the client half of `@convex-dev/workflow`, with replay against the history and pausing added. The server half, the `workflow` component, isn't copied: your data lives in upstream's tables.

The copy matches one upstream release, so each release of this package needs that exact `@convex-dev/workflow` version:

| convex-workflow-migrations | @convex-dev/workflow |
| -------------------------- | -------------------- |
| 100.x.x                    | 0.4.10               |

Moving to a new `@convex-dev/workflow` version changes the exact version you have to install, so it's a release with a new first number. Fixes to upstream's client code arrive when this package updates its copy. Fixes to the component arrive with the version bump. A new upstream release is noticed within a week; this package follows with a release that copies it. [`VENDORED.md`](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-migrations/src/vendor/workflow/VENDORED.md) lists the changes to the copy, and a test fails if the copy isn't the installed release plus those changes.

**Why a copy, and when it goes away.** Upstream has no hook for this yet: [#35](https://github.com/convex/workflow/issues/35) asks for one, and [PR #279](https://github.com/convex/workflow/pull/279) proposes version stamps on journal entries. The alternatives, and their trade-offs:

- **A full fork** would move your workflow data into the fork's tables.
- **Patching in the handler** (`if (step.patched(id))`, as Temporal, Cadence, DBOS and Dapr do it) can serve an installation that skips releases too, if every old branch stays in the handler. Then the handler holds every past shape of the code, and every branch has to keep working against the current steps. Migrations keep that old knowledge outside the handler, as transforms of recorded data, and the handler holds only the current code.
- **Matching steps by identity** (by name, rather than by position) would make inserts free, but a renamed step would run again, and a reordered or removed one couldn't be told from a mismatch, so a mismatch couldn't be detected.
- **Migrating eagerly**, every run at deploy time, gives the same results as migrating at the next replay, and needs a deploy hook and a pass over every run.
- **Versioned handlers**, one per release, chosen per run: a run started on release 0 would never get a fix. Several releases can't run side by side in one deployment, since each deploy replaces the functions.

If upstream ships a hook, this package becomes a thin wrapper over it or is retired. Your workflows, journals and events are already in upstream's tables. Moving off means letting the runs that have migrations or are paused finish first, then swapping `WorkflowManager` back and unmounting `workflowMigrations`.

## API

| Export                                                                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkflowManager(component, { migrationsComponent, onPause?, workpoolOptions? })` | Upstream's manager. `define()` takes `migrations`. `paused`, `resume`, `resumeAll`, `restartFrom` and `fail` act on paused runs (see [Pausing and recovery](#pausing-and-recovery)), `cancel` also ends a pause, `restart` takes a position in the history, and `cleanup` also deletes the run's record. `workflow.migrationsComponent` holds the component.                                                                                                                                                                                                       |
| `migration(id, migrate)`                                                          | A migration for a workflow's `migrations` list. See [Writing migrations](#writing-migrations).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `convex-workflow-migrations histories <workflow>`                                 | Exports run histories from a deployment as JSON. See [Testing](#testing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `register(t, names?)` from `/test`                                                | Registers `@convex-dev/workflow` (its workpool at `<workflow>/workpool`) and the migrations component with convex-test. `names` defaults to `{ workflow: 'workflow', migrations: 'workflowMigrations' }`; set it if you mounted them under other names.                                                                                                                                                                                                                                                                                                            |
| `expectReplays(t, workflow, histories)` from `/test`                              | Replays histories against the current handler, with the migrations. Throws for every history that doesn't replay.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `history(steps, options?)` from `/test`                                           | Builds a history by hand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `migrate(t, workflow, history)` from `/test`                                      | The history after the workflow's migrations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `expectEdits(history, ids?)` from `/test`                                         | Throws unless the migrations `migrate` applied changed the history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| default export of `/test`                                                         | `{ register, schema, modules }`, the shape of upstream's `@convex-dev/workflow/test`, for `migrationsTest.register(t)`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Types                                                                             | `Migration`, `History`, `HistoryStep`, `StepRef`, `StepSelector`, `InsertOptions`, `StepArgs`, `StepResult`, `RecordedHistory`, `RecordedStep`, `OverlayOp`, `PauseReason`, `PauseInfo`, `PausedRun`, `PausedPage`, `Redactable`, `WorkflowManagerOptions`, `MigrationsComponent`, `WorkflowCtx`, `WorkflowHandler`, `WorkflowArgs` (this package's), and upstream's `WorkflowId`, `EventId`, `WorkflowStep`, `RunResult`, `RunOptions`, `StepDefaults`, `WorkflowComponent`, `WorkflowDefinition`, `WorkflowMutationResult`, `WorkflowStatus`, `CallbackOptions`. |

Upstream's other exports are re-exported unchanged, except `defineWorkflow` (use `workflow.define`) and the standalone `cancel`, `restart` and `cleanup` (use the manager's, which end the pause, take a position in the history and delete the run's record).

### The migrations component

`components.workflowMigrations` has one table, `runs`: per run, its workflow function, the migration ids applied to it, its overlay, its pause and the row's format. Its functions are internal: the workflow mutation, the manager and the CLI call them. Don't call them yourself.

Records of child workflows that upstream cleans up with their parent are left behind; they're harmless.

## Limits

- **Pinned upstream version.** See [versions](#convex-devworkflow-versions).
- **Migrations are checked by tests, not by the deploy.** Nothing refuses a release whose migrations are missing or wrong: its runs pause and wait for a fix. `expectReplays` with exported histories is what catches it before the deploy.
- **Migrations form one linear list.** The next migration's input is the history the previous ones left, so they can't apply out of order. A hotfix line may only ship migrations that main has, in the same order: add the migration to main first, then backport it with the ones before it. A migration only a hotfix line has pauses its runs when the installation upgrades to main.
- **A rollback pauses the runs started on newer code.** Their applied ids aren't the start of the older code's list. Trying the replay anyway isn't safe: the older code would record steps in its own shape, and the newer migration, already applied, would never run on them. Rolling forward resumes them, with `resumeAll` or at the next retry.
- **Running steps in test histories.** At runtime the workflow mutation doesn't replay while a step runs, so a migration only ever sees finished steps. A history exported while a run waits at a step has that step as running, and a migration that removes, renames or changes the args of it throws there, though it would apply once the step finished. Test such a migration with the step finished.
- **The overlay is one document** in the migrations component, under Convex's 1 MiB document limit. Migrations that would make it bigger than 512 KiB pause the run (reason `overlay`), naming the migration that added the most. Keep stand-in results and args small; `updateWorkflowArgs` keeps only its latest copy of the args, and `restartFrom` hides the journal in one edit.
- **Matching is by position, name, kind and args.** It ignores whether a function is a query, mutation or action. A migration that's wrong but leaves a call with the same name and args at the same position replays silently. So does removing a step followed by an identical call, without a migration.
- **`restart` reads the history the run's last handler run left.** Migrations a newer release added aren't applied to it yet, so name steps as that run had them.
- **Workflow function renames** aren't supported: each run stores a handle to its function.

## Versioning

Versions follow [Epoch SemVer](https://antfu.me/posts/epoch-semver): `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at `100.0.0`. A change to the first number can break your app; minor and patch releases don't. Moving to a new `@convex-dev/workflow` version changes the first number, because it changes the version you have to install. [CHANGELOG.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CHANGELOG.md) lists the changes.

## Contributing

See [CONTRIBUTING.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CONTRIBUTING.md). Report vulnerabilities privately, as [SECURITY.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/SECURITY.md) describes.

## License

[MPL-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/LICENSE). The copy of `@convex-dev/workflow`'s client code in `src/vendor/workflow/` is upstream's, under [Apache-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-migrations/src/vendor/workflow/LICENSE), and is marked as changed where it was changed.
