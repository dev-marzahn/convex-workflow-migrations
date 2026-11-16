# Contributing

Bug reports, fixes and pull requests are welcome. For a larger change, open an issue first so we can agree on the approach before you write it.

By sending a pull request, you agree to license your contribution under the [MPL-2.0](LICENSE), the license of this repository. The vendored files in `packages/convex-workflow-migrations/src/vendor/workflow/` stay under upstream's Apache-2.0.

## Setup

You need [Bun](https://bun.sh) 1.4, Node 22.18 or later and, for the end-to-end tests and codegen, Docker.

```sh
bun install
bun run ready   # build, then lint, format check and type check, then unit tests

# one test file, or the tests whose names match, from the package's directory
cd packages/convex-workflow-migrations && bunx vp test tests/history.test.ts -t "restartFrom"
```

The repo uses [Vite+](https://viteplus.dev): `vp check` runs Oxfmt, Oxlint and the TypeScript 7 type check, and `bunx vp check --fix` formats. CI runs `bun run ready` and the end-to-end tests on every pull request.

## Repository

| Path                                        | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/convex-workflow-migrations`       | The npm package: the `WorkflowManager` (`src/index.ts`); the history view and its edits (`src/history.ts`); migrations and what a handler run does with a run's record (`src/migrations.ts`); the replay of the handler and the pause rules, which runs and `expectReplays` share (`src/replay.ts`); the migrations component (`src/component`); the vendored `@convex-dev/workflow` client (`src/vendor/workflow`); the `histories` CLI (`src/cli.ts`, with its reads in `src/histories.ts` and `--redact` in `src/redact.ts`); the replay helpers of `/replay` (`src/helpers.ts`, with the replay they run without Convex in `src/testing.ts`), and `/test`, which adds `register` for convex-test (`src/test.ts`). |
| `packages/convex-workflow-migrations/tests` | The unit tests: the history and pause rules (`history.test.ts`); runs across simulated releases on convex-test (`migrations.test.ts`), with child workflows and canceled runs in `children.test.ts`; the replay helpers (`testHelpers.test.ts`); the CLI's reads (`histories.test.ts`); and the checks of the vendored copy, the exports and subpaths, and the backend pin (`vendor.test.ts`, `exports.test.ts`, `backend.test.ts`).                                                                                                                                                                                                                                                                                  |
| `examples/basic`                            | An app with a workflow that has three migrations, and its tests: replay tests with `/replay`, and a convex-test test with `/test`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `e2e/`                                      | The fixture apps (below); the `--redact` module the scenarios use; and the script that deploys the apps over each other on a real backend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `scripts/`                                  | `codegen.ts` rewrites every `_generated/` folder; `vendor.ts` (`bun run vendor`) re-vendors the upstream client and regenerates `upstream.diff`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The e2e fixture apps are the README's pipeline at its releases: release 0 is `v1`, releases 1 and 2 are `v2`, release 3 is `v3` and release 4 is `v4`. Release 4 exists only here: the README's pipeline stops at release 3. From release 2 on, the step functions follow the README's rule for queued steps: new arguments are optional, and a renamed function stays as an alias.

- `v1`: release 0, plain `@convex-dev/workflow`: grab, wait for the download, import, prepare, publish.
- `v2`: releases 1 and 2: adopts the package, and adds notify (`notify-after-grab`) and import's `notifiedAt` (`import-gets-notified-at`).
- `v3`: release 3: renames prepare to transcode (`prepare-becomes-transcode`), and lists all three migrations.
- `v4`: release 4: a new required workflow arg, `channel` (`channel-arg`, with `updateWorkflowArgs`), which grab (`grab-gets-channel`) and publish get as an optional argument. Grab and publish log the channel they got.
- `v3` and `v4` also have `queued.ts`, for the `queued` and `queued-step` scenarios: a workflow whose action holds upstream's workpool, set to one job at a time, and a parent workflow that runs the pipeline as a child, which passes the channel from v4 on (`child-gets-channel`).
- `v2-unguarded` and `v4-unguarded`: v2's and v4's code without their new migrations.

## Codegen

The `_generated/` folders are committed. After changing the component's functions or an app's, run:

```sh
bun run codegen
```

Component codegen pulls deployment state, so the script starts a throwaway backend in Docker (`e2e/backend.ts`), and removes it after. Nothing is deployed. It runs the component's codegen, then `bun run build`, since the apps import the built package, and the build's type check needs the component's new generated types; then every app's codegen.

## End-to-end tests

```sh
bun run e2e             # all scenarios, a few minutes
bun run e2e skip        # only the named scenarios: skip, failed, unguarded, rollback, restart, queued, queued-step, args
```

The script builds the package first. Each scenario starts a fresh backend and leaves runs waiting on `awaitEvent`, or, in `queued` and `queued-step`, in upstream's workpool:

- `skip` starts two runs on v1, deploys v3 over them, and checks they replay through all three migrations, and that a run started on v3 has every id applied. Around that, it exercises the `histories` CLI from v3's directory. Before the deploy, the runs have no records: it exports them, plain and with `--redact`; checks that `--max-runs 1` and `--max-scan 1` refuse to export them without `--allow-partial`, and that `--allow-partial` exports the oldest. After the runs finish, they have records: it checks that `--redact` scrubs the overlay; that exactly `--max-scan` runs from before adoption and exactly `--max-steps` steps export whole, with the finished runs not counting toward `--max-runs`; and that `--max-steps 0` exits with 2. Last, it cleans up a run from before adoption, which reads its journal through a function handle to upstream's `journal.load`.
- `failed` starts the run on v1, deploys v3, and fails the download: the run fails instead of pausing, though the deploy's migrations edited its history.
- `unguarded` starts three runs on v1, deploys v2-unguarded, sends the events, and checks that the runs pause (reported once to `onPause`) instead of failing. It deletes the second run's workflow, as a parent's cleanup would, and fails the third with `fail`; then deploys v2 and waits for the scheduled retries, about a minute later, to finish the first run and delete the second's record.
- `rollback` starts the run on v3, deploys v2, sends the event, and checks that the run pauses with `migrations`; then deploys v3 again and resumes it with `resume`.
- `restart` pauses a run the same way, and checks that `restartFrom` on v2, where any position would pause it again, throws and changes nothing; then deploys v3, restarts it from the wait with `restartFrom`, lets it finish, restarts the finished run from transcode, by name, with `restart`, and checks that upstream's journal didn't keep the entries `restart` ran again.
- `queued` starts, on v3, the workflow that holds the workpool; then a parent whose child waits behind it, and a pipeline run with `startAsync`. It checks both records and that the export lists both runs, with no steps yet; then deploys v4, whose pipeline takes a channel, and checks that both run on v4 with the channel `updateWorkflowArgs` gives them, that the parent resumes through its own migration, and that the parent's cleanup deletes the child's record.
- `queued-step` starts, on v3, the workflow that holds the workpool, then a pipeline run, inline, whose grab its first handler run starts behind it, with v3's args. It deploys v4, which gives grab a channel, and checks that grab runs on v4 without one, since the argument is optional, and that the run then replays through v4's migrations and finishes.
- `args` starts the run on v3, deploys v4-unguarded, sends the event, and checks that the run pauses with `args`; then deploys v4 and resumes it with `resumeAll`, before its scheduled retry, and checks that `--redact` scrubs the migrated workflow args.

## Internals

How the package works inside. The README describes what users see; this is what's behind it.

### Records and the overlay

Each run has a record in the migrations component's `runs` table: its workflow function's name, the ids of the migrations applied to it, an overlay of edits, a pending `restart`, whether it's still running (`live`), who created the record (`origin`), the parent of a child workflow, and the format of the row. A paused run also has a row in a separate table, `pauses`, so that listing paused runs and scheduling their retries never read an overlay; only the handler run a retry calls reads the record. `runs` has at most one row per run; `pauses` has one per paused run, deleted when the pause ends.

Upstream's journal is append-only and its component is unchanged, so the edits live in the record, anchored to journal entry ids. The overlay's operations (`vOverlayOp` in `src/component/schema.ts`):

- `insert`, a stand-in, after or before a step, or at the start of the history (an empty anchor, which `restart` writes for a stand-in whose anchor it deletes and that has no step around it left), with its name, kind, args and result. Its id is a counter, `+1`, `+2`, …;
- `remove`, a step;
- `truncate`, a range of journal entries, which `restartFrom` hides in one edit, with a `remove` for each stand-in in the part it cuts (`restart` adds only those `remove`s, since upstream deletes the entries);
- `rewrite`, a step's name, args or result. A rewrite of a step that has one merges into it, the latest value of each field winning;
- `workflowArgs`, the workflow's arguments. Only the latest one is kept.

The run's history is its journal with those edits applied in order; an edit whose step is gone from the journal, because upstream's restart deleted it, is dropped. At the start of a handler run, the vendored workflow mutation reads the record, and its pause. If the code lists ids beyond those applied, it builds the history and runs the missing migrations on it, in memory. Then the handler replays against the history instead of the raw journal: a stand-in resolves its call without sending anything to upstream, removed steps are skipped, and rewritten steps are compared by their new name and args and resolve with their new result. The deterministic `Date.now()` during replay reads the history too: a stand-in sees the time of the step before it, and a stand-in before every recorded step sees the first recorded step's time, or the time the handler run started if the history has no recorded step.

If replay matches, the new ids and overlay are saved in the same transaction as the handler run's other writes, and so is whether the handler run completed the run. If it doesn't, nothing but the pause is saved. Each handler run writes the record only when something changed.

Migrating early or at the next replay gives the same result: a migration changes only recorded data, and replay never runs a finished step again. That's why there's no deploy hook and no drain.

### When a record is written

A run's history starts in the shape of the code that created it, so its record has to say which ids that code listed (`origin` says who wrote it):

- The workflow mutation writes it with every id the workflow lists, in the transaction that creates the run, with `startAsync` too (`start`). The manager's `start` always goes through the workflow mutation, and so does upstream's standalone `start`. A run queued in upstream's workpool across a deploy therefore migrates from the ids it started with at its first handler run, `updateWorkflowArgs` included.
- A `runWorkflow` step's child is created by upstream's component, which doesn't know the child's migrations. So the parent's handler run writes the child's record, linked to the parent, without applied ids (`child`). At the child's first handler run, its args are all its history has: if they pass the current `args` validator, it starts with every id applied, as a run this code started would; otherwise every migration applies to the empty history, where only `updateWorkflowArgs` does anything. If the args still don't pass, it pauses with `args`. `prepareRun` in `src/migrations.ts` makes that choice, for the workflow mutation and for `expectReplays`.
- A run from before the app adopted this package gets its record at its first handler run that matches, or at its first pause, which writes it without applied ids (`adopted`). With journal entries, it then counts as a run from before the first migration; a queued one, with an empty journal, makes the same choice as a child. `restart` of a run without a record writes one with nothing applied, so a restart that empties the journal still migrates the run's old args.
- `restart` marks the record live again; `fail` and `cancel` mark it finished.

`live` is set when the record is written and when the run restarts. It's cleared when a handler run completes the run; when the manager fails or cancels it; after the manager's cancel, on the records of the descendants upstream's cancel canceled with it (`runs:finishDescendants`, in batches, following `parent` links through the records that were live); and when the workflow mutation is called for a run that has finished, as a paused run's retry calls it.

### Pauses and retries

A pause records the reason, the detail, the position and the id of the step there if it has one, how many migrations the history had applied, and the workflow mutation's function handle with the generation the run was at. The first pause schedules a retry. A retry (`runs:retry`) is write-ahead: in one transaction it counts the attempt, sets `lastError` to say the attempt hasn't completed, and schedules the next retry with backoff and the attempt itself (`runs:attempt`), which calls the workflow mutation through its handle, with the generation the pause recorded, in a transaction of its own: the call upstream's workpool makes after every step. The mutation returns normally after pausing, so the workpool sees a success and `onComplete` doesn't run. An attempt that pauses the run again clears `lastError`; one that gets past the pause ends it, and the retry scheduled for later finds nothing to do; one whose workflow mutation throws records the error. `resumeAll` reads 100 paused runs per transaction, in the order they paused, schedules a retry of each, due now, 100 ms apart, and reads the next 100 after those, until it has read every run that was paused when it was first called.

`resume` and `restartFrom` call `runs:resume`, which calls the workflow mutation in its own transaction, without counting an attempt. A pause counts how many handler runs paused the run (`pausedRuns`), so a call can tell what the workflow mutation did: paused the run again, got past the pause, or returned without replaying, because the run has finished, or is at another generation, for example after upstream's component completed or restarted it past the manager. The last ends the pause; for `restartFrom`, it throws instead. A run whose workflow is gone, for example a child workflow upstream deleted when it cleaned up the parent, loses its record and pause at its next retry, and its children's records after it.

`onPause` is called when a run pauses, and when a retry pauses it on changed code: the pause compares the reason, the step, the number of migrations applied and, for a mismatch, the detail with the pause before.

`restartFrom`'s position is a position in the history the pause saw. The pause records the step at that position and how many migrations the history had applied; the next handler run checks both before it cuts, and throws if they changed.

### `restart`

The manager finds the step `from` names in the history the run's last handler run left, without the migrations a newer release added, and stores it, by id, on the run's record. Then it calls upstream's restart with the step number of the first journal entry at or after that step, so upstream deletes the entries from there on, their events, and the child workflows they started; the manager deletes those children's records. The restarted run's first handler run applies the migrations a newer release added, to the steps that are left; they never see the deleted ones. Then it removes the stand-ins from the stored step on.

A finished run can have a journal entry still marked running: upstream's cancel leaves a canceled run's wait that way, and a step whose work it canceled. Upstream's restart without `from` keeps such an entry, so the restarted run would block on it. As a workaround, the manager has upstream delete from that entry instead, if it comes first, with `from` or without (`tests/children.test.ts` checks that upstream still behaves this way; once it doesn't, the workaround can go). Without `from` and without such an entry, nothing is deleted, and the run replays its whole history.

From an action, the records are updated in transactions before the restart.

### `cleanup`

`WorkflowManager.cleanup` deletes the run and its record, and the records of the child workflows upstream deletes with it, and of theirs (`runs:forget`). It finds them by the links their records have to their parents, in batches that schedule themselves before a transaction gets near Convex's limits. A run from before adoption has no links to its children, so for such a run, and for each of its descendants that has none either, the batch reads the run's journal through a function handle to upstream's `journal.load`, before the run's own record goes. From a mutation, the run's record goes in its transaction; the descendants' in the batches after it. For a workflow that's already gone, it deletes the record.

### Limits inside

- **Pause details are cut** to 8,192 characters, and each call of a mismatch to 8,192, so a mismatch's detail is at most about 16 KiB, and the stored detail at most 24,576 characters. `lastError` is cut to 8,192 characters. A cut never splits a character.
- **Records whose runs are gone.** Upstream deletes a run's child workflows, and theirs, when it cleans up the run, and when its restart deletes the journal entries that started them. `cleanup` and `restart` delete those children's records too. A child deleted some other way, for example by calling upstream's component directly, loses its record at its next retry if it was paused, and otherwise when `cleanup` is called with its id. A paused run whose workflow is gone loses its record at its next retry, and its linked children's after it; if it's from before adoption, its journal is gone too, so the records of its unlinked children are left. When `cleanup` reads the journal of a run from before adoption, upstream may have deleted a child of it first, through its workpool: then the records of that child's own children from before adoption are left. And a journal too big to load whole names only the children in the part that loaded. The workflow mutation never runs these records; they're only storage.
- **`live` can stay set.** A run upstream's component finished past the manager stays marked live until something calls its workflow mutation, as a paused run's retry does: for example a child canceled by calling upstream's `cancel` on its parent directly, a run completed through upstream's component, or one that fails because its journal is too big to load. The CLI checks each live run's status, leaves out the finished ones, and says how many there were.

## The component across versions

A deployment's `runs` and `pauses` rows, its scheduled `runs:retry`, `runs:attempt`, `runs:resumeAll`, `runs:forget` and `runs:finishDescendants` calls, and what the CLI reads outlive the version of this package that wrote them: the next release reads the rows and runs the scheduled calls, and the `histories` CLI of whatever version a developer has installed reads the deployment's component. So from one version to the next:

- keep every field of `runs`, of `pauses` and of the overlay operations readable, adding only optional fields (Convex refuses a schema that existing rows don't match, so the push fails otherwise);
- keep `runs:retry` callable with `{ workflowId, due? }` (a first pause and every retry schedule it with `{ workflowId }`, `resumeAll` with `due: true`), `runs:attempt` with `{ workflowId, attempts }`, `runs:resumeAll` with `{ workflow?, cursor, until }`, `runs:forget` with `{ workflowIds, from?, journal? }` and `runs:finishDescendants` with `{ workflowIds, from? }`;
- keep what the CLI sends working: `runs:load` with `{ workflowId }`, `runs:live` with `{ workflow, paginationOpts }`, and `runs:origins` with `{ workflowIds }` of up to 100 ids, the most the CLI sends at once; keep their results supersets of the last ones;
- keep `origin`'s values, `start`, `child` and `adopted`, and their meanings: the CLI stops scanning upstream's runs at the first whose origin isn't `adopted`, so a new value would be misread by an older CLI;
- keep the stored `pauses.handle` called with `{ workflowId, generationNumber }`, upstream's workflow mutation arguments, and a scheduled `forget`'s `journal` handle called as upstream's `journal.load`, with `{ workflowId }`;
- when a record's meaning changes in a way an older version would misread, raise `FORMAT` in `src/component/schema.ts`. The workflow mutation of a version that finds a record with a higher `format` pauses the run instead of reading it, and the CLI, `restart`, `fail` and `cancel` refuse it, so a rollback can't corrupt it. That holds only while the newer row still matches the older version's schema; if it doesn't, the older version's push fails instead. A `pauses` row has no format: it lasts until the run's next replay that matches, and only the component's own functions write it, so keep each field's meaning, and put new data in new optional fields an older version can ignore.

## Updating @convex-dev/workflow

The package carries a copy of one upstream release's client code. A weekly job (`.github/workflows/upstream.yml`) fails when a newer upstream release is out. To move to it:

1. Set the new version in the root `package.json` catalog and in the package's `peerDependencies`. Check the `@convex-dev/workpool` version the new release depends on, and move the catalog's pin and the peer range if it changed. Then `bun install`.
2. Run `bun run vendor`, which re-vendors the client with [`scripts/vendor.ts`](scripts/vendor.ts), and follow [`VENDORED.md`](packages/convex-workflow-migrations/src/vendor/workflow/VENDORED.md#updating-to-a-new-upstream-release) for conflicts, new upstream files and the version at its top.
3. `bun run ready` and `bun run e2e`. `packages/convex-workflow-migrations/tests/vendor.test.ts` fails until the copy is the installed release plus the diff, `packages/convex-workflow-migrations/tests/exports.test.ts` fails if upstream added a value or type export this package doesn't re-export or leave out on purpose, and `packages/convex-workflow-migrations/tests/children.test.ts` fails if upstream's restart no longer keeps a canceled run's running entry, which `restart` works around ([`restart`](#restart)).
4. Add a row to the versions table in README.md, update its install command, and add a line to CHANGELOG.md. Users must install the new upstream version with it, so this is a release with a new first number.

## Backend version

[convex-release](https://github.com/dev-marzahn/convex-release) is the tool this repo's layout follows. Its "migrations" are data migrations: numbered files that change a Convex app's stored documents, run in order when a deployment upgrades; they're unrelated to this package's workflow migrations. It also seeds deployments and builds self-hosted Docker images. Each of its versions pins a Convex backend build, which its images ship and its tests run against. The e2e tests and codegen run against the same build, which `BACKEND_IMAGE` in [`e2e/backend.ts`](e2e/backend.ts) names; that's the only place this repo names it. `packages/convex-workflow-migrations/tests/backend.test.ts` reads the pin from the installed `@dev-marzahn/convex-release` (its README, the only place it records the pin) and fails until the two match.

The pin moves when convex-release moves it: bump `@dev-marzahn/convex-release` in the root `package.json` catalog, run `bun install`, set `BACKEND_IMAGE` to the build the test names, then run `bun run e2e`.

## Pull requests

- Run `bun run ready` before you push. Run `bun run e2e` too if you touched the vendored client, the component, `src/index.ts`, `src/history.ts`, `src/migrations.ts`, `src/replay.ts`, `src/cli.ts`, `src/histories.ts` or `src/redact.ts`.
- Add a test for a bug fix or a new option.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for a change users will notice.
- If you change how the package behaves, update [README.md](README.md) in the same pull request. It's the only README: packing the package copies it, and `LICENSE`, into `packages/convex-workflow-migrations`. What's behind the behaviour goes under [Internals](#internals) here.
- The README numbers the pause rules, and code comments cite them by number (`src/replay.ts`, `src/index.ts`, `src/migrations.ts`, `src/component/schema.ts`): if you add, remove or reorder a rule, update them.

## Releasing

Maintainers release from `main`:

1. Pick the version by [Epoch SemVer](https://antfu.me/posts/epoch-semver): `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at `100.0.0`. Bump the first number by one for a breaking change, which includes moving to a new `@convex-dev/workflow` version (users have to install that exact version with it), and to the next hundred for a new epoch.
2. Set `version` in `packages/convex-workflow-migrations/package.json`, and move the "Unreleased" changelog entries under the new version.
3. Push a tag `v<version>`. The [release workflow](.github/workflows/release.yml) checks that the tag matches the package version, runs the checks, then stages the package on npm.
4. Approve the staged version with 2FA under **Staged Packages** on npmjs.com, or with `npm stage approve <id>`. It goes live on approval.
