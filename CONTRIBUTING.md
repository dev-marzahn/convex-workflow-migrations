# Contributing

Bug reports, fixes and pull requests are welcome. For a larger change, open an issue first so we can agree on the approach before you write it.

By sending a pull request, you agree to license your contribution under the [MPL-2.0](LICENSE), the license of this repository. The vendored files in `packages/convex-workflow-patches/src/vendor/workflow/` stay under upstream's Apache-2.0.

## Setup

You need [Bun](https://bun.sh) 1.4, Node 22.18 or later and, for the end-to-end tests and codegen, Docker.

```sh
bun install
bun run ready   # build, then lint, format check and type check, then unit tests
```

The repo uses [Vite+](https://viteplus.dev): `vp check` runs Oxfmt, Oxlint and the TypeScript 7 type check, and `vp check --fix` formats. CI runs `bun run ready` and the end-to-end tests on every pull request.

## Repository

| Path                               | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/convex-workflow-patches` | The npm package: the `WorkflowManager` (`src/index.ts`); the history view and its edits (`src/history.ts`); migrations and what a handler run does with a run's record (`src/migrations.ts`); the patches component (`src/component`); the vendored `@convex-dev/workflow` client (`src/vendor/workflow`); the `histories` CLI (`src/cli.ts`); the convex-test helpers (`src/test.ts`, with the replay they hand to the workflow mutation in `src/testing.ts`). |
| `examples/basic`                   | An app with a workflow that has three migrations, and its tests.                                                                                                                                                                                                                                                                                                                                                                                                |
| `e2e/`                             | Fixture apps v1 (release 0, plain `@convex-dev/workflow`), v2 (releases 1 and 2: adopts the package, two migrations), v3 (release 3: a third migration, the list of all three) and v2-unguarded (v2's code without its migrations), and the script that deploys them over each other on a real backend.                                                                                                                                                         |
| `scripts/codegen.ts`               | Rewrites every `_generated/` folder.                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Codegen

The `_generated/` folders are committed. After changing the component's functions or an app's, run:

```sh
bun run codegen
```

Component codegen pulls deployment state, so the script starts a throwaway backend in Docker (`e2e/backend.ts`), runs `convex codegen` for the component and every app, and removes the container. Nothing is deployed. The apps import the built package, so run `bun run build` first. If the component's generated types are stale, the build fails its type check but still writes `dist/`, which is enough for codegen.

## End-to-end tests

```sh
bun run e2e             # all scenarios, about a minute and a half
bun run e2e skip        # only the named scenarios: skip, unguarded, rollback
```

The script builds the package first. Each scenario starts a fresh backend and leaves a run waiting on `awaitEvent`:

- `skip` starts the run on v1, exports its history with `convex-workflow-patches histories` from v3, deploys v3, sends the event, and checks that the run replays through all three migrations and that a run started on v3 has every id applied.
- `unguarded` starts the run on v1, deploys v2-unguarded, sends the event, and checks that the run pauses (reported once to `onPause`) instead of failing; then deploys v2 and waits for the scheduled retry, a minute later, to finish the run.
- `rollback` starts the run on v3, deploys v2, sends the event, and checks that the run pauses with `migrations`; then deploys v3 again and resumes it with `resume`.

## The component across versions

A deployment's `runs` rows, its scheduled `runs:retry` calls, and what `runs:load` returns outlive the version of this package that wrote them: the next release reads the rows and runs the scheduled retries, and the `histories` CLI of whatever version a developer has installed reads `runs:load`. So from one version to the next:

- keep every field of `runs` and of its overlay operations readable, adding only optional fields (Convex refuses a schema that existing rows don't match, so the push fails otherwise);
- keep `runs:retry` callable with `{ workflowId }`, and `runs:load`'s result shape a superset of the last one;
- keep the stored `paused.handle` called with `{ workflowId, generationNumber }`, upstream's workflow mutation arguments.

## Updating @convex-dev/workflow

The package carries a copy of one upstream release's client code. A weekly job (`.github/workflows/upstream.yml`) fails when a newer upstream release is out. To move to it:

1. Set the new version in the root `package.json` catalog and in the package's `peerDependencies`, then `bun install`.
2. Follow the steps in [`VENDORED.md`](packages/convex-workflow-patches/src/vendor/workflow/VENDORED.md): copy the new upstream files, re-apply `upstream.diff`, regenerate it.
3. `bun run ready` and `bun run e2e`. `packages/convex-workflow-patches/tests/vendor.test.ts` fails until the copy is the installed release plus the diff, `packages/convex-workflow-patches/tests/exports.test.ts` fails if upstream added a value export this package doesn't re-export or leave out on purpose, and `tests/typeExports.test.ts` does the same for type exports.
4. Add a row to the versions table in README.md and a line to CHANGELOG.md. This is a minor release unless upstream's change breaks something.

## Backend version

`e2e/backend.ts` pins the Convex backend build the tests use: the one [convex-release](https://github.com/dev-marzahn/convex-release) (the migrations and release-image tool this repo's layout follows) pins in its `images/Dockerfile`. Move them together, then run `bun run e2e`.

## Pull requests

- Run `bun run ready` before you push. Run `bun run e2e` too if you touched the vendored client, the component, `src/history.ts`, `src/migrations.ts` or `src/cli.ts`.
- Add a test for a bug fix or a new option.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for a change users will notice.
- If you change how the package behaves, update [README.md](README.md) in the same pull request. It's the only README: packing the package copies it, and `LICENSE`, into `packages/convex-workflow-patches`.

## Releasing

Maintainers release from `main`:

1. Pick the version by [Epoch SemVer](https://antfu.me/posts/epoch-semver): `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at `100.0.0`. Bump the first number by one for a breaking change, which includes moving to a new `@convex-dev/workflow` version with breaking changes, and to the next hundred for a new epoch. A new upstream version without breaking changes is a minor release.
2. Set `version` in `packages/convex-workflow-patches/package.json`, and move the "Unreleased" changelog entries under the new version.
3. Push a tag `v<version>`. The [release workflow](.github/workflows/release.yml) checks that the tag matches the package version, runs the checks, then stages the package on npm.
4. Approve the staged version with 2FA under **Staged Packages** on npmjs.com, or with `npm stage approve <id>`. It goes live on approval.
