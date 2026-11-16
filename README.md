# convex-workflow-migrations

[![npm](https://img.shields.io/npm/v/@dev-marzahn/convex-workflow-migrations)](https://www.npmjs.com/package/@dev-marzahn/convex-workflow-migrations)
[![CI](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-marzahn/convex-workflow-patches/actions/workflows/ci.yml)
[![License: MPL-2.0 AND Apache-2.0](https://img.shields.io/badge/license-MPL--2.0%20AND%20Apache--2.0-blue)](#license)

Change a released [`@convex-dev/workflow`](https://www.convex.dev/components/workflow) workflow without failing the runs already in flight.

`@convex-dev/workflow` replays a workflow's handler from the start every time a step finishes, and matches each step call to its journal by position. If you add a step before the step a run is waiting at, that run fails with `Journal entry mismatch`. With this package, the handler holds only its current code, and each change comes with a **migration**: a small function that rewrites a run's recorded history into the shape the current code expects.

```ts
// convex/pipeline.ts: one run per download ("grab"): grab it, notify, wait for the download, import, transcode, publish.
import { migration } from '@dev-marzahn/convex-workflow-migrations';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';

import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';
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
    // Release 3: prepare was renamed to transcode. prepare is gone, so it's named by its path.
    migration('prepare-becomes-transcode', (h) => h.rename(makeFunctionReference<'mutation'>('pipeline:prepare'), internal.pipeline.transcode)),
  ],
  // Annotated: the handler's type would otherwise depend on itself through `internal`, which TypeScript can't infer.
  handler: async (step, { grabId }): Promise<void> => {
    await step.runMutation(internal.pipeline.grab, { grabId });
    const { at } = await step.runMutation(internal.pipeline.notify, { grabId });
    await step.awaitEvent({ name: 'downloadDone' });
    await step.runMutation(internal.pipeline.importFiles, { grabId, notifiedAt: at });
    await step.runMutation(internal.pipeline.transcode, { grabId });
    await step.runMutation(internal.pipeline.publish, { grabId });
  },
});

export const notify = internalMutation({
  args: { grabId: v.id('grabs') },
  // null for the runs the migration gives a stand-in: its result has to be a value notify could return.
  returns: v.object({ at: v.union(v.number(), v.null()) }),
  handler: async (ctx, { grabId }): Promise<{ at: number | null }> => {
    // ... tell the user the download started
    return { at: Date.now() };
  },
});

export const importFiles = internalMutation({
  // Since release 2. null for the runs that got notify's stand-in.
  args: { grabId: v.id('grabs'), notifiedAt: v.union(v.number(), v.null()) },
  handler: async (ctx, { grabId, notifiedAt }) => {
    // ... move the downloaded files into the library
  },
});

// grab, transcode and publish are internal mutations too, with args { grabId }.
```

Say a run started on release 0 is waiting for its download when release 3 ships. Its journal is `grab, downloadDone`. When the download arrives, the run replays on release 3. First the three migrations apply to its history, in order, so the history reads `grab, notify (a finished stand-in), downloadDone`. Then the handler replays against that history: `notify` resolves with `{ at: null }` without running, and the run goes on to `importFiles`. Releases 1 and 2 never had to be deployed.

- **Skip releases.** Every release lists every migration, and each run records which ones it has had. A run applies the ones it's missing, in order, the next time it replays. Nothing has to be deployed first, and nothing has to drain.
- **Pause instead of fail.** A run is paused, not failed, when its recorded steps don't match the code's calls (a step added, removed or changed without a migration, a wrong migration, a rollback), when its args no longer pass the `args` validator, or when a migration throws. A pause commits nothing of the handler run. The run is retried with backoff, so deploying a fix resumes it, and `onPause` tells you it happened. Some throws can't be told from the handler's own failures; [the rules](#pausing-and-recovery) say which pause.
- **Same API otherwise.** `WorkflowManager` is `@convex-dev/workflow`'s, with `migrations` in `define()` and methods for paused runs. `sendEvent`, `status`, `listSteps` and the rest are upstream's, and so is `start`, except that it always goes through the workflow mutation, which writes the run's record.
- **Upstream's component.** Your workflows, journals and events stay in the `@convex-dev/workflow` component, unchanged. This package adds a small component with a record per run, written when the run is created: the migrations applied to it and their edits. A paused run has a row there too.
- **Tests against real histories.** `expectReplays` replays recorded histories, with the migrations, against the current handler, with the same replay a handler run uses and no Convex backend, and `npx convex-workflow-migrations histories` exports them from a deployment.

## Contents

- [Quick start](#quick-start)
- [Terms](#terms)
- [Writing migrations](#writing-migrations)
- [Pausing and recovery](#pausing-and-recovery)
- [Testing](#testing)
- [Goals and non-goals](#goals-and-non-goals)
- [How it works](#how-it-works)
- [@convex-dev/workflow versions](#convex-devworkflow-versions)
- [API](#api)
- [Limits](#limits)
- [Versioning](#versioning)
- [Contributing](#contributing)
- [License](#license)

## Quick start

You need `convex` 1.46 or later and Node 22.18 or later (for the `histories` CLI). Install the package with the exact `@convex-dev/workflow` version it was built from (see [versions](#convex-devworkflow-versions), and [if you're on another version](#if-youre-on-another-upstream-version)) and its other peers:

```sh
npm install --save-exact @dev-marzahn/convex-workflow-migrations @convex-dev/workflow@0.4.10 @convex-dev/workpool convex-helpers
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

`onPause` is required: pausing replaces failing, so it shouldn't be quieter. Pass `onPause: null` to opt out. It runs inside the workflow mutation, so its `ctx` is a mutation context, but typed for any app's tables. To write to yours, cast it: `const db = (ctx as unknown as MutationCtx).db`, with `MutationCtx` from `./_generated/server`.

Import the rest from this package too, where you imported it from `@convex-dev/workflow`: `vWorkflowId`, `start`, `defineEvent`, the types and the rest of upstream's exports are re-exported unchanged. Four are left out, because they bypass the migrations or the run's record: `defineWorkflow` (use `workflow.define`), and the standalone `cancel`, `restart` and `cleanup` (use the manager's methods).

Define workflows with `workflow.define`, as with upstream. A workflow you already run needs no migrations until you change it. The runs it started before you adopted this package replay as they did. They count as runs from before the first migration you add, and they get a record at their next handler run.

Every workflow on the `workflow` component should be defined with this manager. Runs defined elsewhere, for example with upstream's `defineWorkflow`, don't migrate and fail on a mismatch as before.

[`examples/basic`](https://github.com/dev-marzahn/convex-workflow-patches/tree/main/examples/basic) is a runnable version of the pipeline above, with its tests: each step logs its name on the grab, and `startGrab` and `downloadDone` start and resume it. From the repo root, run `bun install`, `bun run build` (the example imports the built package), then `bun run --cwd examples/basic test`.

## Terms

- **Release**: one deploy of your app's code. Each release lists every migration of the releases before it, and may add some.
- **Workflow mutation**: the internal mutation `workflow.define` returns. Upstream's component calls it to start a run and again after every step finishes.
- **Handler run**: one call of the workflow mutation. It replays the handler from the start against the run's history, and starts the steps that come after it.
- **History**: the run's journal, the steps upstream recorded, with the edits of its migrations applied. Positions in it count from 0.
- **Stand-in**: a finished step a migration inserted, with the result the call gets. Replay resolves the call with it and runs nothing.
- **Overlay**: the edits made to a run's history, stored as operations on its journal entries and stand-ins: those its migrations made, and those of `restartFrom` and `restart`, which hide or remove the steps they run again.
- **Record**: a run's row in the migrations component: the migrations applied to it, its overlay, whether it's still running, and, for a child workflow, its parent. It's written when the run is created. See [How it works](#how-it-works).
- **Generation**: upstream's counter of a run's restarts. A call of the workflow mutation for an older generation does nothing.
- **Pause**: a run that can't replay on the current code waits, with a row in the migrations component, instead of failing. It stays `inProgress` in upstream.
- **Retry**: a call of a paused run's workflow mutation that the migrations component makes: scheduled with backoff, or now with `resume`, `resumeAll` or `restartFrom`.
- **Attempt**: what `attempts` counts: the first pause, and every scheduled retry and every retry `resumeAll` schedules, each counted when it starts. `resume` and `restartFrom` don't count.

## Writing migrations

**When a change needs one.** A run waits at every step that isn't `inline` until the step finishes: every `runMutation`, `runQuery`, `runAction` and `runWorkflow` call, every `sleep` and every `awaitEvent`. A deploy can land during any of those waits, and then the run replays its recorded steps on the new code. So a change needs a migration if it comes before a step some live run may still be waiting at: adding, removing or reordering steps, renaming a step, changing a step's arguments, changing the shape of what a step returns, or changing the workflow's own `args` validator so that old runs' args no longer pass it. A change after the last step any live run could have reached needs none. When unsure, write one and [test it](#testing) against histories from the old code.

Every change to the shape of a step's result needs an `updateResult`, even where a mismatch wouldn't show it: replay gives the handler the recorded result. A handler that throws reading the old shape before a recorded step it hasn't replayed pauses the run ([rule 2](#pausing-and-recovery)). One that throws right after the newest recorded steps fails it, as it would without this package, unless migrations edited the history in that handler run (rule 5).

Add it to the end of the workflow's `migrations` list:

```ts
migration('notify-after-grab', (h) => h.insertAfter(internal.pipeline.grab, internal.pipeline.notify, { result: { at: null } }));
```

- **The id is permanent.** A run stores the ids applied to it, and its applied ids must stay the start of the list. Never remove, rename or reorder a migration, even an old one: a run that has it would [pause](#pausing-and-recovery). Ids only need to be unique within the workflow; an empty id throws, and a duplicate throws when the module loads, so the push fails.
- **Editing a migration's body changes only the runs still to apply it.** A run that has saved the id keeps what the old body did to its history; only runs that haven't saved it get the new body. To change a history a migration already edited, add a new migration.
- **Migrations stay.** They're small, and a run from any older release may still need them. There's no retirement yet. A minimum supported release, below which old migrations could be squashed into one, may come later.
- **The migration function is synchronous and pure.** It reads `h` and calls its edit methods. It can't call Convex APIs, read the database, or use the time or randomness, and it runs again on every attempt until a replay succeeds.
- **It must work on any history.** The same migration runs on runs that stopped at any point of the old code, including runs that never reached the steps it edits. An edit whose step isn't in the history does nothing, so `insertAfter(grab, ...)` on a run that hasn't grabbed yet leaves it alone, and the run calls `notify` for real when it gets there. An insert also does nothing where neither a journal entry nor another stand-in follows its place: a run whose `grab` was still running at the deploy hasn't got past it either, and calls `notify` for real once `grab` finishes. For a step old runs must never make, even those, pass `atEnd: true`.
- **Each migration sees the history as the previous one left it.** Steps the current code recorded later are already in the current shape, so a migration never has to tell old steps from new ones.
- **It names steps as they were at its own release.** Later code may rename or delete a function, and old migrations must keep compiling and keep matching. Name a step that may change with `makeFunctionReference('pipeline:prepare')` from `convex/server` rather than through `internal`. A reference to a name the history doesn't have makes the edit do nothing, silently; [`expectEdits`](#testing) catches it.

### The history `h`

Reading:

- `h.steps`: the steps in order, each `{ id, name, kind, args, status, result?, error? }`. `kind` is `function`, `workflow`, `event` or `sleep`. `status` is `done` or `running`. `error` is the failure's message, or `'canceled'` for a canceled step. A stand-in inserted without args has `args: {}`.
- `h.workflowArgs`: the workflow's arguments.
- `h.has(step)`: whether some step is `step`.
- `h.result(step)`: the result of the only step that is `step`, or `undefined` if there's none or it didn't succeed. Typed from the function reference.

A step is named by a function reference, `{ workflow: ref }` for a `runWorkflow` call, `{ event: name }` for an `awaitEvent` and `{ sleep: name }` for a `sleep`. In `h.steps`, a function or workflow call's `name` is its function's name, `module:function` (`pipeline:grab`, or `media/pipeline:grab` for `convex/media/pipeline.ts`), unless the call passed a custom `name` option. An `awaitEvent` is named by its `name` option, or by its event id if it has none; a `sleep` without a `name` option is named `'sleep'`. Selecting a step, a function reference (`internal.pipeline.grab`) matches `runQuery`, `runMutation`, `runAction` and `runWorkflow` calls of it; matching ignores which of those it is. A reference matches at most one step: several matches throw, and none makes the edit do nothing. For loops and repeated steps, pass the step itself from `h.steps`; a step an earlier edit of the same migration removed throws:

```ts
// Every notify call, however many the run made, now takes a channel.
migration('notify-gets-channel', (h) => {
  for (const step of h.steps) if (step.name === 'pipeline:notify') h.updateArgs(step, (args) => ({ ...args, channel: 'default' }));
});
```

Editing:

- `h.insertAfter(step, ref, { result })` and `h.insertBefore(...)`: insert a finished stand-in. Replay resolves the call with `result` and runs nothing. `result` is required and typed: it has to be a value the function could return, so declare the function's return type to include it (`at: number | null` above). `args`, if given, are matched against the call; without them only the name and kind are. A function reference inserts a function call: insert a child workflow with `{ workflow: ref }`, and its result is typed from the child's return value. Only stand-ins can be inserted; a migration can't insert a step that runs. Without `atEnd: true`, an insert does nothing where neither a journal entry, running or finished, nor another stand-in would follow it: the run hasn't got past that point, so it makes the call for real. `insertBefore` a journal entry or a stand-in always has one after it.
- `h.remove(step)`: drop a step the code no longer calls.
- `h.rename(step, ref, { name }?)`: the step now counts as a call to `ref`, or, with `name`, to `ref` called with that custom `name` option. The kind must stay the same.
- `h.updateArgs(step, (args) => newArgs)`: the args the current code passes. This is for matching only: the step ran with its old args.
- `h.updateResult(step, (result) => newResult)`: the result replay gives the call, for a step whose return value changed shape, or a stand-in whose result was wrong. The step must have succeeded.
- `h.updateWorkflowArgs((args) => newArgs)`: the workflow's arguments as the current `args` validator expects them, for example with a new required field. Replay passes these to the handler; the run keeps its recorded args, so `status` and `list` still show them.

**How args are matched.** A call's args and the step's are compared as serialized JSON, so the order of their keys matters. Build new args the way the handler builds its call: spread the old args first, then add the new keys, as in `{ ...args, notifiedAt }` above, for a handler that calls with `{ grabId, notifiedAt }`. A call made with the `unstableArgs` option is matched on its name and kind only.

A step called with a custom `name` option is matched by that name: pass `{ name }` in the insert or rename options, and select it from `h.steps`.

**Running steps.** A step a run is waiting at can't be removed, renamed, or given other args or another result: a result will still arrive into it. Inserting before or after it is fine. An edit that breaks this throws, and the run pauses. The workflow mutation doesn't replay while a step runs, so in practice a migration sees a running step only in a test history; see [Limits](#limits).

**Seeing a run's history.** Upstream's `status` and `listSteps` show the journal: steps by the names they ran with, no stand-ins, and steps `restartFrom` hid. Their positions aren't positions in the history. To see a run's history as the current code migrates it, export the run with the [`histories` CLI](#testing) and call `migrate()` on it in a test.

## Pausing and recovery

A run pauses instead of failing when, with the `reason` it pauses with:

- replay doesn't match its history: a change without a migration, or a missing or wrong one. That includes code that returns before replaying every step of its history (`mismatch`);
- the workflow's arguments, as its migrations leave them, don't match its `args` validator, for example after a new required field without `updateWorkflowArgs` (`args`). Arguments that don't match are refused when a run is created through the workflow mutation, as upstream's are, with `startAsync` too, so these are from older code. That includes a run that was created on an older release and first runs on a newer one. A child workflow's arguments come from its parent's call, which upstream's component doesn't check, so a child whose arguments no migration fixes pauses too;
- the handler throws during replay where a migration may be the cause, by the rules below (`threw`);
- a migration throws, including an edit to a running step, or a migration removed the step `restart` named (`migration`);
- the ids applied to it aren't the start of the code's list: a migration was removed, renamed or reordered, or the code is older than the code the run ran on (`migrations`). A run whose record a newer version of this package wrote pauses the same way, as long as the row still matches this version's schema; if it doesn't, Convex refuses to push this version. The `histories` CLI refuses to export such a record;
- the migrations make the run's overlay bigger than 512 KiB (`overlay`).

**When a throw pauses.** A handler that throws during a handler run, after its args validated, is either reacting to the run, which fails it as upstream would, or tripping over a migration, which should pause it. These rules decide, in this order:

1. The handler run started a step past the history, or queued calls that go past its end (calls made together, as with `Promise.all`): the run fails. That step's writes commit (an `inline` step's, for example), so the throw is the handler's reaction to it.
2. A recorded step is left that the handler hasn't replayed: the run pauses. The run got past that point before, so the code and the history disagree.
3. The last step the handler got is a stand-in, or has a result a migration changed (`updateResult`): the run pauses. A renamed step, or one with other args, doesn't count here.
4. The run fails if one journal entry meets all three conditions:
   - it's among the newest recorded steps: the entries with the journal's latest `startedAt`. That's the time of the last handler run that started steps, which gives every step it starts the same time, so steps started together, as with `Promise.all`, are all newest. The journal is read before migrations, so if a migration removed those entries, the failure that's last only because of it is an older one, which the old code caught, and this rule doesn't apply;
   - it's still in the history, and failed or was canceled;
   - no migration renamed it, or gave it other args or another result.

   The handler is then passing that failure on, even if migrations edited its history in this handler run. For example, a history `grab, downloadDone (failed)` whose handler rethrows the failed download fails, though a migration inserted `notify` after `grab` in this handler run; had a migration renamed `downloadDone`, rule 5 would pause it.

5. Migrations edited the run's history in this handler run: the run pauses.
6. Otherwise, the run fails.

`step` is set for a mismatch (where replay stopped matching), for rule 2 (the first step not replayed) and for rule 3 (the step the handler got last); it isn't for rule 5 or the other reasons. `detail` is always set: why the run paused, cut as [Limits](#limits) says. For a mismatch it has the call the code made and the step the history has there; a mismatch from an early return has no call, only the step.

A pause commits nothing of the handler run. A paused run stays `inProgress` in upstream, with no step running, and `onComplete` doesn't run. Calls are matched in order, and a handler run starts new steps only after the last step of the history, so every pause happens before the handler run starts one. The migrations it applied in memory are dropped too, so the next attempt migrates again, possibly with fixed code.

- **Retries.** A paused run is retried after about 1 minute, 10 minutes, 1 hour, then every 6 hours, each ±20% so runs that paused together don't retry together, until it gets past the pause. It never gives up on its own; `fail` is explicit. A scheduled retry, and each one `resumeAll` schedules, is write-ahead: in one transaction it counts the attempt, sets `lastError` to say the attempt hasn't completed, and schedules the next retry; then the attempt calls the workflow mutation in a transaction of its own. So an attempt that dies, even on a Convex limit such as the execution time, leaves the next retry scheduled. An attempt that pauses the run again clears `lastError`; one that gets past the pause ends it, and the retry scheduled for later finds nothing to do. One whose workflow mutation throws logs a warning, and the run keeps its pause, with its reason, step and detail, and the error in `lastError`. Only scheduled retries and `resumeAll`'s count as attempts; `resume` and `restartFrom` don't, and leave the next retry as it was. Every handler run that pauses logs a warning.
- **Alerting.** `onPause(ctx, { workflowId, workflow, reason, detail, step, attempts, previousReason })` is called when a run pauses, in the transaction that pauses it, and again when a retry pauses it for another reason or at another step than `onPause` was last given, with that reason as `previousReason`. A retry that pauses it the same way, or whose workflow mutation throws, doesn't call it. It runs inside `resume`, `resumeAll`'s retries and `restartFrom` too, and a `restartFrom` that throws undoes what it wrote. An error it throws is logged, the writes it made before are kept, and the run stays paused. It's required, since pausing must not be quieter than failing; `onPause: null` opts out.
- **Privacy.** `detail` can hold a step's args and the call the code made, with its args: it goes to the logs, the run's record, `paused` and `onPause`.

Methods on the manager. Their errors reach the caller.

| Method                                           | Called from                 | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paused(ctx, { workflow?, cursor?, numItems? })` | a query, mutation or action | A page of paused runs, the one that paused first first: `{ page, isDone, continueCursor }`, 100 runs unless `numItems` says otherwise. `workflow` is a function name, like `pipeline:run`. Each run has `workflowId`, `workflow`, `reason`, `detail`, `step` (for a mismatch, rule 2 or rule 3, the position in the history), `at` (when it first paused), `attempts`, `nextAttemptAt` and `lastError` (why the last attempt didn't complete, if it didn't). It reads only the pauses, not the runs' records. |
| `resume(ctx, workflowId)`                        | a mutation or action        | Retries now, for example right after deploying a fix. Returns whether the run got past its pause. Throws if the run isn't paused. One transaction, from an action too.                                                                                                                                                                                                                                                                                                                                        |
| `resumeAll(ctx, { workflow? })`                  | a mutation or action        | Schedules one retry of every run paused when it's called, or of one workflow's, 100 ms apart: runs that pause later aren't included. Each retry is a scheduled retry that's due now. See [Limits](#limits) for the load.                                                                                                                                                                                                                                                                                      |
| `restartFrom(ctx, workflowId, step)`             | a mutation or action        | Removes every step of the history from position `step` on, and retries: those steps run again ([what it does](#what-restartfrom-does)). Throws, changing nothing, if the run isn't paused, if `step` is past the end of the history, if the history changed since the pause (a release added migrations, or another step is at the paused position: `resume`, then read `paused` again), or if the run would still pause. One transaction, from an action too.                                                |
| `fail(ctx, workflowId)`                          | a mutation                  | Completes the run as failed, with why it paused as the error, and ends the pause, in the caller's transaction. `onComplete` runs. Throws, changing nothing, if the run isn't paused.                                                                                                                                                                                                                                                                                                                          |
| `cancel(ctx, workflowId)`                        | a mutation or action        | Upstream's cancel, which also ends the pause. `onComplete` runs with `canceled`. From an action, those are two transactions.                                                                                                                                                                                                                                                                                                                                                                                  |

The usual fix is code: deploy a release with the missing or corrected migration, then wait for the retry or call `resumeAll`. After a rollback, roll forward: runs that paused with `migrations` resume on code whose list starts with their applied ids.

**Child workflows.** A paused child stalls its parent: the parent's `runWorkflow` step stays running until the child finishes. `fail` or `cancel` on the child releases the parent, which gets the child's failure or cancellation as the step's result. Cancelling the parent cancels the child through upstream's component, past the manager, so the child stays listed in `paused` until its next retry, which finds it canceled and ends the pause. A child that's still queued in upstream's workpool when a release changes its args gets them migrated at its first handler run; see [How it works](#how-it-works).

These methods need a function to call them from. Expose them as internal functions, and run them after a deploy, or from the dashboard:

```ts
// convex/admin.ts
import { vWorkflowId } from '@dev-marzahn/convex-workflow-migrations';

import { internalMutation, internalQuery } from './_generated/server';
import { workflow } from './workflow';

export const paused = internalQuery({ args: {}, handler: (ctx) => workflow.paused(ctx) });
export const resumePaused = internalMutation({ args: {}, handler: (ctx) => workflow.resumeAll(ctx) });
export const failPaused = internalMutation({ args: { workflowId: vWorkflowId }, handler: (ctx, { workflowId }) => workflow.fail(ctx, workflowId) });
```

```sh
npx convex deploy && npx convex run --prod admin:resumePaused
```

`convex deploy` deploys to production, and `convex run` runs against the dev deployment unless you pass `--prod`. With `CONVEX_DEPLOY_KEY` set, both commands use the key's deployment; for a self-hosted backend, set `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` instead.

#### What `restartFrom` does

It keeps the steps before `step` and runs the rest again, on the current code. The removed steps stay in upstream's journal, hidden, so they still count towards its size limit: a paused run's tail can't be deleted before it replays. An `awaitEvent` that runs again waits for a new event: the old one was consumed. A `runWorkflow` that runs again starts a new child; the old one isn't canceled. `step` is a position in the history as the current code migrates it, which `paused` reports.

The pause records the step at that position and how many migrations the history had applied, and `restartFrom` checks both before it cuts, so a position read before the history changed throws, as the table says. That catches a release that added migrations, and a changed migration body that moved another step to the position. It can't catch a changed body that leaves the step at the position as it was: a pause without a `step` (a rule 5 throw, `args` and the other reasons) checks only the count, and a stand-in's id is a counter (`+1`, `+2`, …) that a changed body can give to another stand-in. Read `paused` after the deploy you mean to restart on.

**Self-hosted installations.** When you ship a product that others run, you can't export histories from their deployments. Test against histories built by hand with `history()`, or run an old release on a local backend, leave runs waiting, and export them with the `histories` CLI. A fix reaches an installation with its next upgrade, which can skip releases; run `resumeAll` after it, for example from the same script that deploys.

## Testing

Replay histories the older code recorded against the current handler. The helpers take the workflow mutation `workflow.define` returned, and need no Convex backend. This test is adapted from `examples/basic`:

```ts
// convex/pipeline.test.ts
import { expectReplays, history } from '@dev-marzahn/convex-workflow-migrations/test';
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

- **`expectReplays(workflow, histories)`** replays each history, with the workflow's migrations, against its current handler, by the rules a handler run follows: a mismatch, an early return, a throw that would pause the run, args that don't validate and a migration that throws all fail it. It checks the args without the database, so ids only as strings. It runs no steps: replay stops where the history ends or at a running step. A handler run that would fail the run passes, unless the history's `outcome` says the run succeeded; for a run that failed or was canceled, only a throw before its last recorded step fails. A `truncated` history fails: export it with a larger `--max-steps`. So does an `unstable` one: export it again. A pending `restart` applies, as the run's next handler run will apply it. A history without `applied` is treated as the workflow mutation treats a run whose record doesn't say: with steps, every migration applies; with none, it keeps its args if they pass the `args` validator, and otherwise every migration applies (see [How it works](#how-it-works)). If a history doesn't replay, it throws with the history, the reason, the position, the call the code made and the step the history has there, and the migrated history.
- **`history(steps, { args, applied, workflowId, outcome })`** builds a history by hand: `{ step: ref, args, result }` (or `error`, or `canceled: true`) for a function call, `{ workflow: ref, ... }`, `{ event: name, result }` (or `error`) and `{ sleep: name }`, each with `status: 'running'` if the run is waiting there. A function or workflow step called with a custom `name` option takes `name` too. A step without `result`, `error`, `canceled` or `status` succeeded with `null`. Steps get ids `h0`, `h1`, … and start times 0, 1, …; give steps started together the same `startedAt`. `args` are the workflow's, `{}` by default. Without `applied`, it's a run without a record: with steps, a run from before the first migration. For a run queued on an older release, pass the ids that release listed. `workflowId` labels the history in failures, and `outcome` (`success`, `failed` or `canceled`) says how a finished run ended.
- **`await migrate(workflow, history)`** returns the history after the workflow's migrations, to test a single migration. It throws if they can't be applied, or the history is `truncated`.
- **`await expectEdits(migrate(...), ids?)`** throws unless each migration that `migrate` applied changed the history, or, with `ids`, unless those ones ran and did. Without `ids`, it also throws when no migration ran, because the history has them all applied. Use it with a history that has the steps the migration edits, to catch a migration whose references no longer match anything.
- **`npx convex-workflow-migrations histories <workflow> [-- <convex options>]`** exports the histories of a workflow's running runs, and of its 10 most recent finished ones, from a deployment, newest first, as JSON that `expectReplays` takes. Run it from your app's directory, for example `npx convex-workflow-migrations histories pipeline:run --out convex/histories.json -- --prod`. For a self-hosted backend, set `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`, as for `convex deploy`. It lists the running runs from the migrations component, which has a live record of every run started since the app adopted this package, queued ones included, and checks each one's status. Runs from before then may have no record, so it also looks through upstream's runs of the workflow, oldest first, up to the first one this package started. Runs that have a record include the migrations applied to them, their overlay and a pending `restart`, and finished runs their `outcome`. Options:
  - `--recent <n>`: how many finished runs it adds, the newest among the newest 1,000 (10);
  - `--max-runs <n>`: how many runs from before adoption it looks through, oldest first (1000, at least 1). If there are more, it exports nothing, says how far it looked, and exits with 1: running ones among the rest would be missing;
  - `--allow-partial`: export anyway when there are more runs from before adoption than `--max-runs`;
  - `--max-steps <n>`: how many steps of a run it exports (1000, at least 1; a run with more is marked `truncated`);
  - `--redact <module>`: scrubs the export (below);
  - `--out <file>`: writes to a file instead of stdout;
  - `--workflow-component <name>` and `--migrations-component <name>`: where the components are mounted (`workflow`, `workflowMigrations`);
  - options after `--` go to every `convex` command it runs.

  For each run it reads the record, then the journal, raw, with upstream's `journal.load`, then the record again. If the two reads of the record differ, it reads both again; if they never agree in three tries, the run's history is marked `unstable`. That's three `convex run` calls per run, so it's slow for many runs. A record that a newer version of this package wrote stops the export: install the version the deployment runs. It exits with 0 when it exported, 1 when there are more runs from before adoption than `--max-runs`, and 2 for a usage error, a failed `convex` command or a record from a newer version.

The export is an array of `RecordedHistory`: `{ workflowId, workflow, args, steps, applied?, overlay?, restart?, outcome?, truncated?, unstable? }`, where each step is a `RecordedStep`, `{ id, name, kind, args, runResult?, startedAt }`, with upstream's `RunResult`. Load it into a typed test with a cast, with `resolveJsonModule` in your `tsconfig.json`:

```ts
import type { RecordedHistory } from '@dev-marzahn/convex-workflow-migrations/test';

import raw from './histories.json';

const histories = raw as RecordedHistory[];
```

Without `resolveJsonModule`, read it: `JSON.parse(readFileSync(new URL('./histories.json', import.meta.url), 'utf8')) as RecordedHistory[]`, with `readFileSync` from `node:fs`.

**Exports hold production data.** Every run's args, every step's args, result and error, and each record's overlay are in the file, and the CLI says so on stderr. The overlay holds stand-ins' args and results, rewritten args and results, and the workflow args `updateWorkflowArgs` gave the run. Check the file before you commit it, or scrub it: `--redact ./redact.ts` loads a module whose default export takes each step, each run's args with `kind: 'run'`, and the overlay's data, as `{ kind, name, args, result?, error? }`, and returns them scrubbed (the type is `Redactable`). It gets a stand-in with its args (`{}` if it has none) and result, a rewritten step by the name the current code calls it, and the migrated workflow args with `kind: 'run'`. The CLI loads the module with `import()`, so a `.ts` module works on Node's built-in type stripping (Node 22.18 or later), as long as it uses only erasable syntax: no `enum`s or parameter properties.

- **The redactor's contract.** It may be async. It returns the whole value: the CLI takes `args` and, for a step that has them, `result` and `error` from what it returns, so a returned value without `result` stores `null` as the result, and one without `error` an empty error. Spread the input (`{ ...value, args }`) and change only what it scrubs.
- **Scrub every value the handler builds call args from, the same way wherever it appears.** Replay compares each step's args with the call the handler makes, and the handler builds them from the workflow's args and from earlier steps' results. In the pipeline above, `importFiles`'s `notifiedAt` is `notify`'s result: a redactor that scrubs `at` in `notify`'s result must scrub `notifiedAt` in `importFiles`'s args to the same value, or the export no longer replays. This repo's e2e module does that:

```ts
// redact.ts
import type { Redactable } from '@dev-marzahn/convex-workflow-migrations';

export default function redact(value: Redactable): Redactable {
  const args = { ...(value.args as Record<string, unknown>) };
  if ('grabId' in args) args.grabId = 'redacted';
  if ('notifiedAt' in args) args.notifiedAt = 0;
  const result = value.result;
  const scrubbed = typeof result === 'object' && result !== null && 'at' in result ? { ...result, at: 0 } : result;
  return { ...value, args, ...(value.result === undefined ? {} : { result: scrubbed }) };
}
```

A history replays against the handler as a real handler run would, so a test can also run the current code from scratch with convex-test as usual: register both components with `register(t)` (or `migrationsTest.register(t)` from the default export), as `examples/basic` does.

Configure Vitest: inline the packages whose test helpers use `import.meta.glob`, this one's `/test` among them, even for the replay helpers alone. The `edge-runtime` environment is for convex-test only, with `convex-test` and `@edge-runtime/vm` installed; the replay helpers run in Vitest's default `node` environment too:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // For convex-test.
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test', '@convex-dev/workflow', '@convex-dev/workpool', '@dev-marzahn/convex-workflow-migrations'] } },
  },
});
```

**A testing loop.** With every change to a workflow:

1. Export the histories of the running runs from production, with `--redact` if they hold data you won't commit, and check the file: `npx convex-workflow-migrations histories pipeline:run --redact ./redact.ts --out convex/histories/pipeline.json -- --prod`.
2. Commit the export, and keep the earlier ones: a run on an older shape may still be in flight somewhere, for example on a self-hosted installation that skips releases.
3. For the shapes no deployment has right now, build histories by hand with `history()`: a run waiting at each step of each past release, and one queued before its first handler run, with the `applied` ids that release listed.
4. Write the migration, with `migrate()` and `expectEdits()` tests for it.
5. Run `expectReplays` over all of them in CI, before the deploy.

To see a release replace another on a real backend, start a throwaway self-hosted backend in Docker, deploy the previous release to it with `npx convex deploy`, start a run and leave it waiting, deploy the new release over it, then let the run finish and check what ran. This repo's [`e2e/run.ts`](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/e2e/run.ts) does that with its fixture apps.

## Goals and non-goals

Goals:

- A run from any older release replays on the newest code, given the migrations, without any release in between being deployed first. Self-hosted installations skip releases.
- A wrong or missing migration pauses runs instead of failing them, and a pause commits nothing, so a fix can resume them.
- Workflow data stays in upstream's component.

Non-goals:

- Checking migrations at deploy time. Tests do that; see [Limits](#limits).
- Steps inserted to run for real. Inserted steps are stand-ins.
- Parallel lines of migrations.

What can still go wrong, and what to do about it, is under [Limits](#limits).

## How it works

Each run has a record in the migrations component: the ids of the migrations applied to it, an **overlay** of edits, whether it's still running (`live`), who created the record, the parent of a child workflow, and the format of the row. A paused run also has a row in a separate table, so listing, resuming and retrying paused runs never read an overlay. Upstream's journal is append-only and its component is unchanged, so the edits live in the record, anchored to journal entry ids:

- `insert`, a stand-in, after or before a step, with its name, kind, args and result;
- `remove`, a step;
- `truncate`, a range of journal entries, which `restartFrom` hides in one edit, with a `remove` for each stand-in in the part it cuts (`restart` adds only those `remove`s, since upstream deletes the entries);
- `rewrite`, a step's name, args or result;
- `workflowArgs`, the workflow's arguments.

The run's **history** is its journal with those edits applied in order. At the start of a handler run, the vendored workflow mutation reads the record. If the code lists ids beyond those applied, it builds the history and runs the missing migrations on it, in memory. Then the handler replays against the history instead of the raw journal. A stand-in resolves its call without sending anything to upstream, removed steps are skipped, and rewritten steps are compared by their new name and args and resolve with their new result. The deterministic `Date.now()` during replay reads the history too: a stand-in sees the time of the step before it, and a stand-in before every recorded step sees the first recorded step's time, or the time the handler run started if the history has no recorded step.

If replay matches, the new ids and overlay are saved in the same transaction as the handler run's other writes, and so is whether the handler run completed the run. If it doesn't, nothing but the pause is saved. Each handler run reads one record, and its pause, and writes the record only when something changed.

**When a record is written.** A run's history starts in the shape of the code that created it, so its record has to say which ids that code listed:

- The workflow mutation writes it with every id the workflow lists, in the transaction that creates the run, with `startAsync` too. The manager's `start` always goes through the workflow mutation, and so does upstream's standalone `start`. A run queued in upstream's workpool across a deploy therefore migrates from the ids it started with at its first handler run, `updateWorkflowArgs` included.
- A `runWorkflow` step's child is created by upstream's component, which doesn't know the child's migrations. So the parent's handler run writes the child's record, linked to the parent, without applied ids. At the child's first handler run, its args are all its history has: if they pass the current `args` validator, it starts with every id applied, as a run this code started would; otherwise every migration applies to the empty history, where only `updateWorkflowArgs` does anything. If the args still don't pass, it pauses with `args`. `expectReplays` makes the same choice for an empty history without `applied`.
- A run from before the app adopted this package gets its record at its first handler run, or its first pause, after adoption, with nothing applied if it has journal entries. A queued one with an empty journal makes the same choice as a child. `restart` of a run without a record writes one with nothing applied, so a restart that empties the journal still migrates the run's old args.

Migrating early or at the next replay gives the same result: a migration changes only recorded data, and replay never runs a finished step again. That's why there's no deploy hook and no drain.

**Pauses and retries.** A pause records the reason, and its first pause schedules a retry in the migrations component. A retry starts its attempt write-ahead, as [Pausing and recovery](#pausing-and-recovery) describes, then calls the workflow mutation through its function handle, with the generation the pause recorded: the call upstream's workpool makes after every step. The mutation returns normally after pausing, so the workpool sees a success and `onComplete` doesn't run. A retry that finds the workflow mutation returned without replaying ends the pause: the run has finished, or is at another generation, for example after upstream's component completed or restarted it past the manager. A run whose workflow is gone, for example a child workflow upstream deleted when it cleaned up the parent, loses its record and pause at its next retry, and its children's records after it.

**`restart`.** `workflow.restart(ctx, workflowId, { from })` is upstream's restart of a finished run, with `from` in the history: a position, or a step name or reference, meaning its last occurrence. The manager finds that step in the history the run's last handler run left, without the migrations a newer release added, and stores it, by id, on the run's record. Then it calls upstream's restart with the step number of the first journal entry at or after that step, so upstream deletes the entries from there on, their events, and the child workflows they started; the manager deletes those children's records. A finished run can also have a journal entry still marked running: a canceled run that was waiting on an event keeps its wait that way, and the run would wait on it forever. Upstream deletes from that entry instead, if it comes first, with `from` or without. Without `from` and without such an entry, nothing is deleted, and the run replays its whole history.

The restarted run's first handler run applies the migrations a newer release added, to the steps that are left; they never see the deleted ones. Then it removes the stand-ins from the stored step on, and the steps from there run again, on the current code: stand-ins become real calls. Repeated restarts don't grow the journal. It throws if the run is still running (a paused run isn't finished: use `restartFrom`), if `from` is past the end of the history or names no step, if the journal is too big to load whole, or if a newer version of this package wrote the record. From an action, the records are updated in transactions before the restart.

**`cleanup`.** `WorkflowManager.cleanup` deletes the run and its record, and the records of the child workflows upstream deletes with it, and of theirs. It finds them by the links their records have to their parents, in batches that schedule themselves before a transaction gets near Convex's limits. A run from before adoption has no links to its children, so for such a run, and for each of its descendants that has none either, the batch reads the run's journal with upstream's `journal.load`, before the run's own record goes. From a mutation, the run's record goes in its transaction; the descendants' in the batches after it. For a workflow that's already gone, it deletes the record.

## @convex-dev/workflow versions

Upstream's client replays the handler against the raw journal, and its package exports don't include the code that does. So this package ships a copy of that code, the client half of `@convex-dev/workflow`, with replay against the history and pausing added. The server half, the `workflow` component, isn't copied: your data lives in upstream's tables.

The copy matches one upstream release, so each release of this package needs that exact `@convex-dev/workflow` version:

| convex-workflow-migrations | @convex-dev/workflow |
| -------------------------- | -------------------- |
| 100.x.x                    | 0.4.10               |

Moving to a new `@convex-dev/workflow` version is a release with a new first number ([Versioning](#versioning)). Fixes to upstream's client code arrive when this package updates its copy. Fixes to the component arrive with the version bump. A new upstream release is noticed within a week; this package follows with a release that copies it. [`VENDORED.md`](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-migrations/src/vendor/workflow/VENDORED.md) lists the changes to the copy, and a test fails if the copy isn't the installed release plus those changes.

### If you're on another upstream version

Move your app to the pinned `@convex-dev/workflow` version first, then adopt this package: in a deploy of its own, or in the same deploy as the adoption. Before you do, read upstream's changelog between your version and the pinned one, for what happens to runs in flight: a change to how upstream's client replays the journal, or to its component's tables, applies to them at their next handler run. An older component that moves to the pinned one gets the pinned one's schema, which Convex checks against the existing rows when you push; if it doesn't match, the push fails and nothing changes. If you're on a newer version than the pin, wait for the release of this package that copies it, rather than moving back: a component that goes back a version can fail its push the same way, and runs that ran on the newer client may not replay on the older one.

**Why a copy, and when it goes away.** Upstream has no hook for this yet: [#35](https://github.com/convex/workflow/issues/35) asks for one, and [PR #279](https://github.com/convex/workflow/pull/279) proposes version stamps on journal entries. The alternatives, and their trade-offs:

- **A full fork** would move your workflow data into the fork's tables.
- **Patching in the handler** (`if (step.patched(id))`, as Temporal, Cadence, DBOS and Dapr do it) can serve an installation that skips releases too, if every old branch stays in the handler. Then the handler holds every past shape of the code, and every branch has to keep working against the current steps. Migrations keep that old knowledge outside the handler, as transforms of recorded data, and the handler holds only the current code.
- **Substituting `journal.load`**, handing upstream's own client the migrated history without copying it, could edit the history but not pause: a mismatch throws inside upstream's executor, which fails the run before any code of this package could catch it.
- **Matching steps by identity** (by name, rather than by position) would make inserts free, but a renamed step would run again, and a reordered or removed one couldn't be told from a mismatch, so a mismatch couldn't be detected.
- **Migrating eagerly**, every run at deploy time, gives the same results as migrating at the next replay, and needs a deploy hook and a pass over every run.
- **A dry run in the deployment**, replaying every live run's history against the deployed code without committing, could check more runs than an export does. But it can only check code that's already deployed, so it would find a wrong migration after the deploy, when the runs it breaks pause anyway. It doesn't replace testing exported histories before the deploy.
- **Versioned handlers**, one per release, with each run replaying on the handler it started on. Every old handler, and every function it calls, would have to stay in the code and keep compiling, and keep working against today's tables and APIs. A fix, for a bug or a schema change, would have to be applied to every live version. And a run started on release 0 would finish on release 0's logic, however old.

If upstream ships a hook, this package becomes a thin wrapper over it or is retired. Your workflows, journals and events are already in upstream's tables. Moving off means letting the runs that have migrations or are paused finish first, then swapping `WorkflowManager` back and unmounting `workflowMigrations`. To find them, export each workflow with the `histories` CLI, which lists every running run: the ones to wait for have a non-empty `overlay`, or `applied` ids that don't include every migration the code lists, or show up in `paused`.

## API

| Export                                                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkflowManager(component, { migrationsComponent, onPause, workpoolOptions? })` | Upstream's manager. `onPause` is required; `null` opts out. `define()` takes `migrations`, and `start` writes the run's record with it. `paused`, `resume`, `resumeAll`, `restartFrom` and `fail` act on paused runs (see [Pausing and recovery](#pausing-and-recovery)), `cancel` also ends a pause, `restart` takes a position, a step name or a step reference in the history, and `cleanup` also deletes the records of the run and of the child workflows deleted with it ([How it works](#how-it-works)).                                                    |
| `migration(id, migrate)`                                                         | A migration for a workflow's `migrations` list. See [Writing migrations](#writing-migrations).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `convex-workflow-migrations histories <workflow>`                                | Exports run histories from a deployment as JSON. See [Testing](#testing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `register(t, names?)` from `/test`                                               | Registers `@convex-dev/workflow` (its workpool at `<workflow>/workpool`) and the migrations component with convex-test. `names` defaults to `{ workflow: 'workflow', migrations: 'workflowMigrations' }`; set it if you mounted them under other names.                                                                                                                                                                                                                                                                                                            |
| `expectReplays(workflow, histories)` from `/test`                                | Replays histories against the current handler of the workflow mutation `define` returned, with the migrations, without Convex. Throws for every history that doesn't replay.                                                                                                                                                                                                                                                                                                                                                                                       |
| `history(steps, options?)` from `/test`                                          | Builds a history by hand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `migrate(workflow, history)` from `/test`                                        | The history after the workflow's migrations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `expectEdits(history, ids?)` from `/test`                                        | Throws unless the migrations `migrate` applied changed the history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| default export of `/test`                                                        | `{ register, schema, modules }`, the shape of upstream's `@convex-dev/workflow/test`, for `migrationsTest.register(t)`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Types                                                                            | `Migration`, `History`, `HistoryStep`, `StepRef`, `StepSelector`, `InsertOptions`, `StepArgs`, `StepResult`, `RecordedHistory`, `RecordedStep`, `OverlayOp`, `PauseReason`, `PauseInfo`, `PausedRun`, `PausedPage`, `Redactable`, `WorkflowManagerOptions`, `MigrationsComponent`, `WorkflowCtx`, `WorkflowHandler`, `WorkflowArgs` (this package's), and upstream's `WorkflowId`, `EventId`, `WorkflowStep`, `RunResult`, `RunOptions`, `StepDefaults`, `WorkflowComponent`, `WorkflowDefinition`, `WorkflowMutationResult`, `WorkflowStatus`, `CallbackOptions`. |

Upstream's other exports are re-exported unchanged, except `defineWorkflow` (use `workflow.define`) and the standalone `cancel`, `restart` and `cleanup` (use the manager's, which end the pause, take a position in the history and delete the run's record).

### The migrations component

`components.workflowMigrations` has two tables. `runs` has at most one row per run, written when the run is created (or, for a run from before adoption, at its first handler run): its workflow function, the migration ids applied to it, its overlay, a pending `restart`, whether it's live, who created the record, its parent, and the row's format. `pauses` has a row per paused run, deleted when the pause ends. The component's functions are internal: the workflow mutation, the manager and the CLI call them. Don't call them yourself.

Upstream deletes a run's child workflows, and theirs, when it cleans up the run, and when its restart deletes the journal entries that started them. `WorkflowManager.cleanup` and `restart` delete those children's records too. If a child is deleted some other way, for example by calling upstream's component directly, its record goes at its next retry if it was paused, and otherwise when you call `cleanup` with its id.

## Limits

- **Pinned upstream version.** See [versions](#convex-devworkflow-versions).
- **Migrations are checked by tests, not by the deploy.** Nothing refuses a release whose migrations are missing or wrong: its runs pause and wait for a fix. `expectReplays` with exported histories is what catches it before the deploy.
- **Migrations form one linear list.** The next migration's input is the history the previous ones left, so they can't apply out of order. A hotfix line may only ship migrations that main has, in the same order: add the migration to main first, then backport it with the ones before it. A migration only a hotfix line has pauses its runs when the installation upgrades to main.
- **A rollback pauses the runs started on newer code.** Their applied ids aren't the start of the older code's list. Trying the replay anyway isn't safe: the older code would record steps in its own shape, and the newer migration, already applied, would never run on them. Rolling forward resumes them, with `resumeAll` or at the next retry.
- **Workflow args.** A change to the `args` validator that a run's args don't pass pauses every such run, queued ones included, until a migration gives them args that match (`updateWorkflowArgs`). Args that still pass need no migration.
- **A queued child's old args.** A child workflow's record doesn't say which migrations its parent's release knew of, so at its first handler run its args decide: if they pass the current validator, no migration applies to it. A child queued across a release whose `updateWorkflowArgs` changes the meaning of args that still pass, rather than their shape, keeps the old meaning. Give such a change a new arg, or a new shape, that old args don't pass.
- **Throws.** A throw during replay can't always be told apart from the handler's reaction to new input. [The rules](#pausing-and-recovery) pause when a migration could be the cause; a throw in a later handler run, after the migrations were saved, can fail the run.
- **Running steps in test histories.** At runtime the workflow mutation doesn't replay while a step runs, so a migration only ever sees finished steps. A history exported while a run waits at a step has that step as running, and a migration that removes, renames or changes the args of it throws there, though it would apply once the step finished. Test such a migration with the step finished.
- **The overlay is one document** in the migrations component, under Convex's 1 MiB document limit. Migrations that would make it bigger than 512 KiB pause the run (reason `overlay`), naming the migrations, and the restart, that added to it in that handler run. Keep stand-in results and args small; `updateWorkflowArgs` keeps only its latest copy of the args, `restartFrom` hides the journal in one edit, and both it and `restart` add one per stand-in they cut.
- **Pause details are cut** to 8,192 characters, and each call of a mismatch to 8,192, so a mismatch's detail is at most about 16 KiB, and the stored detail at most 24,576 characters: huge args or error messages can't make a pause too big to store. `lastError` is cut to 8,192 characters. A cut never splits a character.
- **Matching is by position, name, kind and args.** It ignores whether a function is a query, mutation or action. A migration that's wrong but leaves a call with the same name and args at the same position replays silently. So does removing a step followed by an identical call, without a migration.
- **`resumeAll` load.** It reads 100 paused runs per transaction, in the order they paused, schedules a retry of each 100 ms apart, and reads the next 100 after those retries, until it has read every run that was paused when it was called. Each retry replays the run's handler once, so resuming many runs is one replay per paused run, about 10 a second. Scheduled retries don't go through upstream's workpool, so its `maxParallelism` doesn't limit them.
- **`histories` and runs from before adoption.** The running runs come from the migrations component's records, but runs from before the app adopted this package may have none, and upstream has no index by status. So the CLI pages through upstream's runs of the workflow, oldest first, up to the first one this package started: at most `--max-runs` of them, refusing to export with more unless `--allow-partial`. Once those runs have finished, or been cleaned up, that scan reads one page.
- **`live` can stay set.** A record is marked finished when a handler run completes the run, and when the manager fails or cancels it. A run upstream's component finishes past the manager, for example a child canceled with its parent, or one that fails because its journal is too big to load, stays marked live; the CLI checks each live run's status, and leaves out the finished ones.
- **`cleanup` and `restart` work in batches.** Deleting a tree of records reads each record, and its children's, and deletes them, rescheduling itself before a transaction gets near Convex's limits, so it can take several scheduled transactions after the call. For runs from before adoption, which have no links, each batch reads the run's journal, up to 8 MiB. Those reads can race upstream's own cleanup, which deletes a cleaned-up run's children through its workpool: if upstream deletes a child of a run from before adoption first, the records of that child's own children from before adoption are left. The workflow mutation never runs them; they're only storage.
- **`restart` reads the history the run's last handler run left.** Migrations a newer release added aren't applied to it yet, so name steps, and count positions, as that run had them. The step it names keeps its place when they apply, and the steps upstream deletes from there on are gone before they do.
- **Workflow function renames** aren't supported: each run stores a handle to its function.
- **Exported data.** [Exports hold production data.](#testing)

## Versioning

Versions follow [Epoch SemVer](https://antfu.me/posts/epoch-semver): `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at `100.0.0`. A change to the first number can break your app; minor and patch releases don't. Moving to a new `@convex-dev/workflow` version changes the first number, because it changes the version you have to install. [CHANGELOG.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CHANGELOG.md) lists the changes.

## Contributing

See [CONTRIBUTING.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/CONTRIBUTING.md). Report vulnerabilities privately, as [SECURITY.md](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/SECURITY.md) describes.

## License

[MPL-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/LICENSE). The copy of `@convex-dev/workflow`'s client code in `src/vendor/workflow/` is upstream's, under [Apache-2.0](https://github.com/dev-marzahn/convex-workflow-patches/blob/main/packages/convex-workflow-migrations/src/vendor/workflow/LICENSE), and is marked as changed where it was changed.
