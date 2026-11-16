# Contributing

Bug reports, fixes and pull requests are welcome. For a larger change, open an issue first so we can agree on the approach before you write it.

By sending a pull request, you agree to license your contribution under the [MPL-2.0](LICENSE), the license of this repository. The vendored files in `packages/convex-workflow-migrations/src/vendor/workflow/` stay under upstream's Apache-2.0.

## Setup

You need [Bun](https://bun.sh) 1.4, Node 22.18 or later and, for the end-to-end tests and codegen, Docker.

```sh
bun install
bun run ready   # build, then lint, format check and type check, then unit tests
```

The repo uses [Vite+](https://viteplus.dev): `vp check` runs Oxfmt, Oxlint and the TypeScript 7 type check, and `bunx vp check --fix` formats. CI runs `bun run ready` and the end-to-end tests on every pull request.

## Repository

| Path                                        | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/convex-workflow-migrations`       | The npm package: the `WorkflowManager` (`src/index.ts`); the history view and its edits (`src/history.ts`); migrations and the run's record in a handler run (`src/migrations.ts`); the replay of the handler and the throw rules, which runs and the test helpers share (`src/replay.ts`); the migrations component, with the records, pauses and retries (`src/component`); the vendored `@convex-dev/workflow` client (`src/vendor/workflow`); `/replay` (`src/helpers.ts`) and `/test` (`src/test.ts`); the `histories` CLI (`src/histories.ts`, and the bin `src/cli.ts`). |
| `packages/convex-workflow-migrations/tests` | Unit tests: the history, applying migrations and the throw rules (`history.test.ts`); runs across simulated releases on convex-test, pauses and retries too (`migrations.test.ts`); the replay helpers (`helpers.test.ts`); the `histories` CLI against a fake deployment (`histories.test.ts`); and checks of the vendored copy, the exports and subpaths, and the backend pin (`vendor.test.ts`, `exports.test.ts`, `backend.test.ts`).                                                                                                                                       |
| `examples/basic`                            | An app with a workflow that has three migrations, and its tests: replay tests with `/replay`, and a convex-test test with `/test`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `e2e/`                                      | The fixture apps (below), and the script that deploys them and `examples/basic` over each other on a real backend.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `scripts/`                                  | `codegen.ts` rewrites every `_generated/` folder; `vendor.ts` (`bun run vendor`) re-vendors the upstream client and regenerates `upstream.diff`.                                                                                                                                                                                                                                                                                                                                                                                                                                |

The e2e tests deploy the README's pipeline at its releases. Two are fixture apps in `e2e/apps`: `v1` is release 0, on plain `@convex-dev/workflow` (grab, wait for the download, import, prepare, publish), and `v2-unguarded` is release 2's code without its migrations. Release 3, which adopts the package and lists all three migrations, is `examples/basic`.

## Codegen

The `_generated/` folders are committed. After changing the component's functions or an app's, run `bun run codegen`. Component codegen pulls deployment state, so the script starts a throwaway backend in Docker (`e2e/backend.ts`), and removes it after; nothing is deployed. It runs the component's codegen, then `bun run build`, since the apps import the built package, then every app's codegen.

## End-to-end tests

```sh
bun run e2e                   # all scenarios
bun run e2e skip              # only the named scenarios: skip, unguarded, rollback
```

The script builds the package first. Each scenario starts a fresh backend and deploys an app with a run waiting on `awaitEvent`, `v1` unless it says otherwise:

- `skip` deploys `examples/basic` over it, sends the event, and checks that the run replays through all three migrations, without releases 1 and 2 ever deployed, and that a run started on `examples/basic` has every id applied. It exports the run with the `histories` CLI before the deploy, without the migrations component, and after it finished, with its record, and checks the `--max-scan` stop.
- `unguarded` deploys `v2-unguarded` over it, sends the event, and checks that the run pauses with the mismatch, reported once to `onPause`, with nothing saved; then deploys `examples/basic` and waits for the scheduled retry, about a minute later, to finish the run. That assumes the deploy is live before the first retry; if it isn't, the scenario calls `resume` instead of waiting 10 minutes for the next one.
- `rollback` starts two runs on `examples/basic`, deploys `v2-unguarded`, sends the events, and checks that both pause with `migrations`; then deploys `examples/basic` again and finishes one with `resume`. It deletes the other with upstream's forced `cleanup`, and checks that `resume` returns false and deletes its pause and record (`callHandle`, below).

## Internals

**Records and the overlay.** Each run has a record in the migrations component's `runs` table: the ids of the migrations applied to it, and an overlay of their edits. Upstream's journal is append-only and its component is unchanged, so the edits live in the record, anchored to journal entry ids. The overlay's operations (`vOverlayOp` in `src/component/schema.ts`) are `insert` (a stand-in, after or before a step, with an id `+1`, `+2`, …), `remove`, `rewrite` (a step's name, args or result) and `workflowArgs`. The history is the journal with them applied in order. A stored operation whose step is gone from the journal, because something outside the `WorkflowManager` deleted it (upstream's standalone `restart({ from })`), pauses the run (`record`); it isn't dropped. An `updateArgs`, `updateResult` or `updateWorkflowArgs` that leaves its value as it is stores nothing, and a later `workflowArgs` operation, or rewrite of the same field of a step, replaces the earlier one.

**A handler run.** The vendored workflow mutation reads the record (`loadRecord` in `src/migrations.ts`). If the code lists ids beyond those applied, it builds the history and runs the missing migrations on it, in memory. The handler then replays against the history instead of the raw journal (`replayHandler` in `src/replay.ts`, and the executor's patches in `step.ts`): a stand-in resolves its call without sending anything to upstream, removed steps are skipped, and rewritten steps compare by their new name and args and resolve with their new result. The deterministic `Date.now()` reads the history too: a stand-in sees the time of the step before it. If replay matches, the new ids and overlay are saved in the handler run's transaction, if they changed or the run was paused; saving ends the pause. If it can't replay, it pauses (below). Migrating at the next replay gives the same result as migrating early: a migration changes only recorded data, and replay never runs a finished step again. That's why there's no deploy hook and no drain.

**When a record is written.** A run's history starts in the shape of the code that created it, so the workflow mutation writes its record, with every id the workflow lists, in the transaction that creates the run, with `startAsync` too. A child workflow is created by upstream's component, which doesn't know its migrations, and a run from before adoption has no record either: at its first handler run, `prepareRun` decides. With journal entries, every migration applies. With none, if the args pass the current `args` validator, every id counts as applied; otherwise every migration applies to the empty history, where only `updateWorkflowArgs` does anything. The workflow mutation and the `/replay` helpers both call `prepareRun`, so they choose the same.

**Pauses.** `prepareHistory` throws a `ReplayError` for a run it can't migrate; `replayHandler` returns one instead of `handlerDone` for a mismatch the executor throws, args that don't validate, an early return (`returnedEarly`) and a throw the README's rules pause (`threwEarly`; code comments cite the rules by their README numbers, so renumbering them means updating those). Either way the workflow mutation records the pause and returns normally, so the workpool sees a success; nothing else of the handler run is saved. The executor's `progress()` tells the rules where replay got to, and whether the handler run started, or queued a call to, a step past the history: that step's start, and an inline step's writes and result, commit with the handler run, so a throw after it fails the run (rule 1). Calls are matched in order, and steps past the history start only after its last step, so a pause comes before any step starts, with one exception: the handler can keep calling from another branch of a `Promise.all` while the pause is recorded (and `onPause` awaited). So `replayHandler` sets the executor's `halted` first, and a halted executor starts nothing. The pause is recorded after `setupEnvironment`'s deterministic `Date` and `console` are restored, so `onPause` gets the real ones.

A paused run has a row in `pauses`, apart from its record, so listing and retrying never read an overlay: the workflow's function name (`workflow`, indexed for `paused({ workflow })`), the reason, the detail, the step's position, the attempts, `nextAttemptAt`, `lastError`, the workflow mutation's function handle with the generation it paused at, and `pausedRuns`, how many handler runs paused it. `list` returns the row's `_creationTime` as `at`, when the run first paused. A run paused again keeps its row, so its `at` and its attempts; `onPause` is called when the row is new, or its reason, step or detail changed.

**Write-ahead retries.** The first pause schedules `runs:retry` at `nextAttemptAt`. A retry, in one transaction, counts the attempt, sets `lastError` to say it hasn't completed, schedules the next retry with backoff, and only then schedules `runs:attempt`, which calls the stored handle with `{ workflowId, generationNumber }`, the call upstream's workpool makes after every step, in a transaction of its own. So an attempt that dies, even on a Convex limit, can't lose the chain. An attempt that pauses the run again clears `lastError`; one whose workflow mutation throws records the error, and the run stays paused without `onPause`; one that gets past the pause deletes the row, and the retry scheduled for later finds no row. A retry that isn't due yet (left over from an earlier schedule), and an attempt a later one replaced, do nothing. `resume` calls the handle the same way, in `runs:resume`, without counting an attempt or moving `nextAttemptAt`, and an error the workflow mutation throws is thrown to its caller. Both go through `callHandle`. If the call leaves the row with the same `pausedRuns`, the workflow mutation returned without replaying, because the run has finished (the vendored mutation returns for any result, not only success), for example canceled bypassing the manager (upstream's standalone `cancel`, or a parent's cancel), or is at another generation, and `callHandle` ends the pause. If upstream's `journal.load` throws `Workflow not found` for the run, because upstream deleted it (a child its parent's cleanup removed), `callHandle` deletes the run's record and pause. `resume` returns true only when the run replayed past its pause.

**The test helpers.** `WorkflowManager.define` attaches the definition and migrations to the workflow mutation under a global symbol (`REPLAY`). `expectReplays` prepares the history as the workflow mutation does, with `strict` (each `updateResult` and `updateWorkflowArgs` runs twice), and replays it with `replayHandler` and a `StepExecutor` whose `startSteps` stops the replay at the frontier. Only such a history can have a running step, and the executor's `run()` stops there, comparing the call without resolving it (`checkOnly`). For a history whose `outcome` is `failed` or `canceled`, `replayHandler` takes `recordedOnly`, so only throw rules 1 and 2 apply: the run's own failure came after its last step.

**The `histories` CLI.** `src/cli.ts` only finds the app's `convex` binary and calls `main` in `src/histories.ts`, which does everything through `convex run --component` and `convex data --component` (to tell whether the migrations component is deployed), so the tests drive `main` with a fake `convex`. It pages upstream's `workflow:listByName` newest first, since upstream has no index by status, and keeps the running runs and the first `--recent` finished ones; it asks for at most `--max-scan` + 1 runs, the one extra telling it there are more. For each run it reads the record (`runs:load`), then `journal:load`, then the record again, until two record reads agree, at most 3 times. It reads only what the workflow mutation reads, so it needs no schema change.

## The component across versions

A deployment's `runs` and `pauses` rows, and its scheduled `runs:retry` and `runs:attempt` calls, outlive the version of this package that wrote them: the next release reads the rows and runs the scheduled calls. So from one version to the next:

- keep every field of `runs`, of `pauses` and of the overlay operations readable, adding only optional fields: Convex refuses a schema that existing rows don't match, so the push fails otherwise;
- keep `runs:retry` callable with `{ workflowId }` and `runs:attempt` with `{ workflowId, attempts }`;
- keep calling a stored `pauses.handle` with `{ workflowId, generationNumber }`, upstream's workflow mutation arguments.

## Updating @convex-dev/workflow

The package carries a copy of one upstream release's client code. A weekly job (`.github/workflows/upstream.yml`) fails when a newer upstream release is out. This is the whole procedure to move to it:

1. Set the new version in the root `package.json` catalog and in the package's `peerDependencies`. Check the `@convex-dev/workpool` version the new release depends on, and move the catalog's pin and the peer range if it changed. Then `bun install`.
2. Re-vendor the client as [`VENDORED.md`](packages/convex-workflow-migrations/src/vendor/workflow/VENDORED.md#re-vendoring-a-new-upstream-release) describes: `bun run vendor`, new upstream files, conflicts, and the version and commit at its top.
3. `bun run ready` and `bun run e2e`. `tests/vendor.test.ts` fails until the copy is the installed release plus `upstream.diff`, and the diff is what `bun run vendor diff` writes; `tests/exports.test.ts` fails if upstream added an export this package doesn't re-export or leave out on purpose. A type error usually means the component API changed shape.
4. In README.md, add a row to the versions table and set the new version in the install command. Add a line under "Unreleased" in CHANGELOG.md.
5. Release it with a new first number ([Releasing](#releasing)): users must install the new upstream version with it.

## Backend version

[convex-release](https://github.com/dev-marzahn/convex-release) is the tool this repo's layout follows. Each of its versions pins a Convex backend build, and the e2e tests and codegen run against the same build, which `BACKEND_IMAGE` in [`e2e/backend.ts`](e2e/backend.ts) names. `packages/convex-workflow-migrations/tests/backend.test.ts` reads the pin from the installed `@dev-marzahn/convex-release` (its README) and fails until the two match. To move the pin, bump `@dev-marzahn/convex-release` in the root `package.json` catalog, run `bun install`, set `BACKEND_IMAGE` to the build the test names, then run `bun run e2e`.

## Pull requests

- Run `bun run ready` before you push. Run `bun run e2e` too if you touched the vendored client, the component, `src/index.ts`, `src/history.ts`, `src/migrations.ts` or `src/replay.ts`.
- Add a test for a bug fix or a new option.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for a change users will notice.
- If you change how the package behaves, update [README.md](README.md) in the same pull request. It's the only README: packing the package copies it, and `LICENSE`, into `packages/convex-workflow-migrations`. What's behind the behaviour goes under [Internals](#internals) here.

## Releasing

Maintainers release from `main`:

1. Pick the version by [Epoch SemVer](https://antfu.me/posts/epoch-semver): `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at `100.0.0`. Bump the first number by one for a breaking change, which includes moving to a new `@convex-dev/workflow` version (users have to install that exact version with it), and to the next hundred for a new epoch.
2. Set `version` in `packages/convex-workflow-migrations/package.json`, and move the "Unreleased" changelog entries under the new version.
3. Push a tag `v<version>`. The [release workflow](.github/workflows/release.yml) checks that the tag matches the package version, runs the checks, then stages the package on npm.
4. Approve the staged version with 2FA under **Staged Packages** on npmjs.com, or with `npm stage approve <id>`. It goes live on approval.
