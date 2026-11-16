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

| Path                                        | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/convex-workflow-migrations`       | The npm package: the `WorkflowManager` (`src/index.ts`); the history view and its edits (`src/history.ts`); migrations and what a handler run does with a run's record (`src/migrations.ts`); the replay of the handler and the pause rules, which runs and `expectReplays` share (`src/replay.ts`); the migrations component (`src/component`); the vendored `@convex-dev/workflow` client (`src/vendor/workflow`); the `histories` CLI (`src/cli.ts`, with its reads in `src/histories.ts` and `--redact` in `src/redact.ts`); the test helpers (`src/test.ts`, with the replay they run without Convex in `src/testing.ts`). |
| `packages/convex-workflow-migrations/tests` | The unit tests: the history and pause rules (`history.test.ts`); runs across simulated releases on convex-test (`migrations.test.ts`), with child workflows and canceled runs in `children.test.ts`; the `/test` helpers (`testHelpers.test.ts`); the CLI's reads (`histories.test.ts`); and the checks of the vendored copy, the re-exports and the backend pin (`vendor.test.ts`, `exports.test.ts`, `backend.test.ts`).                                                                                                                                                                                                      |
| `examples/basic`                            | An app with a workflow that has three migrations, and its tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `e2e/`                                      | The fixture apps (below); the `--redact` module the scenarios use; and the script that deploys the apps over each other on a real backend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `scripts/`                                  | `codegen.ts` rewrites every `_generated/` folder; `vendor.ts` (`bun run vendor`) re-vendors the upstream client and regenerates `upstream.diff`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

The e2e fixture apps are the README's pipeline at its releases: release 0 is `v1`, releases 1 and 2 are `v2`, release 3 is `v3` and release 4 is `v4`. Release 4 exists only here: the README's pipeline stops at release 3.

- `v1`: release 0, plain `@convex-dev/workflow`: grab, wait for the download, import, prepare, publish.
- `v2`: releases 1 and 2: adopts the package, and adds notify (`notify-after-grab`) and import's `notifiedAt` (`import-gets-notified-at`).
- `v3`: release 3: renames prepare to transcode (`prepare-becomes-transcode`), and lists all three migrations.
- `v4`: release 4: a new required workflow arg, `channel` (`channel-arg`, with `updateWorkflowArgs`).
- `v3` and `v4` also have `queued.ts`, for the `queued` scenario: a parent workflow that runs the pipeline as a child, which passes the channel from v4 on (`child-gets-channel`).
- `v2-unguarded` and `v4-unguarded`: v2's and v4's code without their new migrations.

## Codegen

The `_generated/` folders are committed. After changing the component's functions or an app's, run:

```sh
bun run codegen
```

Component codegen pulls deployment state, so the script starts a throwaway backend in Docker (`e2e/backend.ts`), runs `convex codegen` for the component and every app, and removes the container. Nothing is deployed. The apps import the built package, so run `bun run build` first. If the component's generated types are stale, as they are after you change its functions, the build fails its type check and exits non-zero: it still writes `dist/`, which is enough for codegen, but skips its last step, which copies the vendored LICENSE into `dist/` and makes the CLI executable. So run `bun run build`, then `bun run codegen`, then `bun run build` again.

## End-to-end tests

```sh
bun run e2e             # all scenarios, a few minutes
bun run e2e skip        # only the named scenarios: skip, failed, unguarded, rollback, restart, queued, args
```

The script builds the package first. Each scenario starts a fresh backend and leaves runs waiting on `awaitEvent`, or, in `queued`, in upstream's workpool:

- `skip` starts two runs on v1 and exports their histories with `convex-workflow-migrations histories` from v3, plain and with `--redact`, and checks that `--max-runs 1` refuses to export these two runs from before adoption without `--allow-partial`, and exports the oldest with it. Then it deploys v3, sends the events, and checks that the runs replay through all three migrations and that a run started on v3 has every id applied. It exports with `--redact` again, now that the runs have records, and checks the overlay is scrubbed; that exactly `--max-runs` runs from before adoption and exactly `--max-steps` steps export whole; and that `--max-steps 0` exits with 2. Last, it cleans up a run from before adoption, which reads its journal through a function handle to upstream's `journal.load`.
- `failed` starts the run on v1, deploys v3, and fails the download: the run fails instead of pausing, though the deploy's migrations edited its history.
- `unguarded` starts three runs on v1, deploys v2-unguarded, sends the events, and checks that the runs pause (reported once to `onPause`) instead of failing. It deletes the second run's workflow, as a parent's cleanup would, and fails the third with `fail`; then deploys v2 and waits for the scheduled retries, about a minute later, to finish the first run and delete the second's record.
- `rollback` starts the run on v3, deploys v2, sends the event, and checks that the run pauses with `migrations`; then deploys v3 again and resumes it with `resume`.
- `restart` pauses a run the same way, and checks that `restartFrom` on v2, where any position would pause it again, throws and changes nothing; then deploys v3, restarts it from the wait with `restartFrom`, lets it finish, restarts the finished run from transcode, by name, with `restart`, and checks that upstream's journal didn't keep the entries `restart` ran again.
- `queued` starts, on v3, a workflow whose action holds upstream's workpool, which `e2e/apps/v3/convex/queued.ts` limits to one job at a time; then a parent whose child waits behind it, and a pipeline run with `startAsync`. It checks both records and that the export lists both runs, with no steps yet; then deploys v4, whose pipeline takes a channel, and checks that both run on v4 with the channel `updateWorkflowArgs` gives them, that the parent resumes through its own migration, and that the parent's cleanup deletes the child's record.
- `args` starts the run on v3, deploys v4-unguarded, sends the event, and checks that the run pauses with `args`; then deploys v4 and resumes it with `resumeAll`, before its scheduled retry, and checks that `--redact` scrubs the migrated workflow args.

## The component across versions

A deployment's `runs` and `pauses` rows, its scheduled `runs:retry`, `runs:attempt`, `runs:resumeAll` and `runs:forget` calls, and what the CLI's queries return outlive the version of this package that wrote them: the next release reads the rows and runs the scheduled calls, and the `histories` CLI of whatever version a developer has installed calls `runs:load`, `runs:live` and `runs:origins`. So from one version to the next:

- keep every field of `runs`, of `pauses` and of the overlay operations readable, adding only optional fields (Convex refuses a schema that existing rows don't match, so the push fails otherwise);
- keep `runs:retry` callable with `{ workflowId, due? }` (a first pause and every retry schedule it with `{ workflowId }`, `resumeAll` with `due: true`), `runs:attempt` with `{ workflowId, attempts }`, `runs:resumeAll` with `{ workflow?, cursor, until }` and `runs:forget` with `{ workflowIds, from?, journal? }`, and the results of `runs:load`, `runs:live` and `runs:origins` supersets of the last ones;
- keep the stored `pauses.handle` called with `{ workflowId, generationNumber }`, upstream's workflow mutation arguments, and a scheduled `forget`'s `journal` handle called as upstream's `journal.load`, with `{ workflowId }`;
- when a record's meaning changes in a way an older version would misread, raise `FORMAT` in `src/component/schema.ts`. The workflow mutation of a version that finds a record with a higher `format` pauses the run instead of reading it, and the CLI and `restart` refuse it, so a rollback can't corrupt it. That holds only while the newer row still matches the older version's schema; if it doesn't, the older version's push fails instead. A `pauses` row has no format: it lasts until the run's next replay that matches, and only the component's own functions write it, so keep each field's meaning, and put new data in new optional fields an older version can ignore.

## Updating @convex-dev/workflow

The package carries a copy of one upstream release's client code. A weekly job (`.github/workflows/upstream.yml`) fails when a newer upstream release is out. To move to it:

1. Set the new version in the root `package.json` catalog and in the package's `peerDependencies`, then `bun install`.
2. Run `bun run vendor`, which re-vendors the client with [`scripts/vendor.ts`](scripts/vendor.ts), and follow [`VENDORED.md`](packages/convex-workflow-migrations/src/vendor/workflow/VENDORED.md#updating-to-a-new-upstream-release) for conflicts, new upstream files and the version at its top.
3. `bun run ready` and `bun run e2e`. `packages/convex-workflow-migrations/tests/vendor.test.ts` fails until the copy is the installed release plus the diff, and `packages/convex-workflow-migrations/tests/exports.test.ts` fails if upstream added a value or type export this package doesn't re-export or leave out on purpose.
4. Add a row to the versions table in README.md, update its install command, and add a line to CHANGELOG.md. Users must install the new upstream version with it, so this is a release with a new first number.

## Backend version

[convex-release](https://github.com/dev-marzahn/convex-release) is the tool this repo's layout follows. Its "migrations" are data migrations: numbered files that change a Convex app's stored documents, run in order when a deployment upgrades; they're unrelated to this package's workflow migrations. It also seeds deployments and builds self-hosted Docker images. Each of its versions pins a Convex backend build, which its images ship and its tests run against. The e2e tests and codegen run against the same build, which `BACKEND_IMAGE` in [`e2e/backend.ts`](e2e/backend.ts) names; that's the only place this repo names it. `packages/convex-workflow-migrations/tests/backend.test.ts` reads the pin from the installed `@dev-marzahn/convex-release` (its README, the only place it records the pin) and fails until the two match.

The pin moves when convex-release moves it: bump `@dev-marzahn/convex-release` in the root `package.json` catalog, run `bun install`, set `BACKEND_IMAGE` to the build the test names, then run `bun run e2e`.

## Pull requests

- Run `bun run ready` before you push. Run `bun run e2e` too if you touched the vendored client, the component, `src/index.ts`, `src/history.ts`, `src/migrations.ts`, `src/replay.ts`, `src/cli.ts`, `src/histories.ts` or `src/redact.ts`.
- Add a test for a bug fix or a new option.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for a change users will notice.
- If you change how the package behaves, update [README.md](README.md) in the same pull request. It's the only README: packing the package copies it, and `LICENSE`, into `packages/convex-workflow-migrations`.

## Releasing

Maintainers release from `main`:

1. Pick the version by [Epoch SemVer](https://antfu.me/posts/epoch-semver): `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at `100.0.0`. Bump the first number by one for a breaking change, which includes moving to a new `@convex-dev/workflow` version (users have to install that exact version with it), and to the next hundred for a new epoch.
2. Set `version` in `packages/convex-workflow-migrations/package.json`, and move the "Unreleased" changelog entries under the new version.
3. Push a tag `v<version>`. The [release workflow](.github/workflows/release.yml) checks that the tag matches the package version, runs the checks, then stages the package on npm.
4. Approve the staged version with 2FA under **Staged Packages** on npmjs.com, or with `npm stage approve <id>`. It goes live on approval.
