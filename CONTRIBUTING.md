# Contributing

Bug reports, fixes and pull requests are welcome. For a larger change, open an issue first so we can agree on the approach before you write it.

By sending a pull request, you agree to license your contribution under the [MPL-2.0](LICENSE), the license of this repository. The vendored files in `packages/convex-workflow-migrations/src/vendor/workflow/` stay under upstream's Apache-2.0.

## Setup

You need [Bun](https://bun.sh) 1.4, Node 22.18 or later and, for the end-to-end tests and codegen, Docker.

```sh
bun install
bun run ready   # build, then lint, format check and type check, then unit tests
```

The repo uses [Vite+](https://viteplus.dev): `vp check` runs Oxfmt, Oxlint and the TypeScript 7 type check, and `vp check --fix` formats. CI runs `bun run ready` and the end-to-end tests on every pull request.

## Repository

| Path                                  | Contents                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/convex-workflow-migrations` | The npm package: the `WorkflowManager` (`src/index.ts`); the patch decisions (`src/patchState.ts`); the patches component (`src/component`); the vendored `@convex-dev/workflow` client (`src/vendor/workflow`); the predeploy check (`src/predeploy.ts`, which is also convex-release's check module) and its CLI (`src/cli.ts`); the convex-test helpers (`src/test.ts`, with `simulateDeploy`'s switch in `src/testing.ts`). |
| `examples/basic`                      | An app with a patched workflow and its tests.                                                                                                                                                                                                                                                                                                                                                                                   |
| `e2e/`                                | Fixture apps v1 (plain `@convex-dev/workflow`), v2 (adopts the package and adds two patches), v3 (removes one patch's old branch) and v2-unguarded (the same change as v2, without patches), and the script that deploys them over each other on a real backend. v2 and v3 also use convex-release.                                                                                                                             |
| `scripts/codegen.ts`                  | Rewrites every `_generated/` folder.                                                                                                                                                                                                                                                                                                                                                                                            |

## Codegen

The `_generated/` folders are committed. After changing the component's functions or an app's, run:

```sh
bun run codegen
```

Component codegen pulls deployment state, so the script starts a throwaway backend in Docker (`e2e/backend.ts`), runs `convex codegen` for the component and every app, and removes the container. Nothing is deployed.

## End-to-end tests

```sh
bun run e2e             # all scenarios, under a minute
bun run e2e check       # only the named scenarios: patched, check, release, unguarded
```

The script builds the package first. Each scenario starts a fresh backend and deploys fixture app v1 with a run waiting on `awaitEvent`:

- `patched` deploys v2 over it, sends the event and checks which steps ran.
- `check` runs `convex-workflow-migrations check` from v2 and v3 between deploys, and checks its exit codes and output.
- `release` deploys v2 and v3 with `convex-release deploy` and with convex-release's one-shot image (pulled from ghcr.io, at the app's convex-release version), and checks that both refuse v3 while the run waits.
- `unguarded` deploys v2-unguarded and checks that the waiting run fails.

## The predeploy check

`src/predeploy.ts` is the module convex-release runs (`convex-release.predeploy` in the package's `package.json`). convex-release loads it from a folder of its own, without `node_modules`, so it may only import `node:` built-ins; type imports are fine, the build erases them. A test fails if it imports anything else, and the `release` scenario runs it the way convex-release does.

A release's check module reads what the deployed release wrote, which may be an older version of this package. Keep `runs:deployed`, `runs:lookup` and upstream's `workflow:list` callable with the same arguments and result shapes from one version to the next, or make the check accept both. To move to a new convex-release, set its version in the root `package.json` catalog and run `bun run e2e release`.

## Updating @convex-dev/workflow

The package carries a copy of one upstream release's client code. A weekly job (`.github/workflows/upstream.yml`) fails when a newer upstream release is out. To move to it:

1. Set the new version in the root `package.json` catalog and in the package's `peerDependencies`, then `bun install`.
2. Follow the steps in [`VENDORED.md`](packages/convex-workflow-migrations/src/vendor/workflow/VENDORED.md): copy the new upstream files, re-apply `upstream.diff`, regenerate it.
3. `bun run ready` and `bun run e2e`. `packages/convex-workflow-migrations/tests/vendor.test.ts` fails until the copy is the installed release plus the diff, and `packages/convex-workflow-migrations/tests/exports.test.ts` fails if upstream added an export this package doesn't re-export or leave out on purpose.
4. Add a row to the versions table in README.md and a line to CHANGELOG.md. This is a minor release unless upstream's change breaks something.

## Backend version

`e2e/backend.ts` pins the Convex backend build the tests use: the one [convex-release](https://github.com/dev-marzahn/convex-release) (the migrations and release-image tool this repo's layout follows) pins in its `images/Dockerfile`. Move them together, then run `bun run e2e`.

## Pull requests

- Run `bun run ready` before you push. Run `bun run e2e` too if you touched the vendored client, the component, `src/patchState.ts`, `src/predeploy.ts` or `src/cli.ts`.
- Add a test for a bug fix or a new option.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for a change users will notice.
- If you change how the package behaves, update [README.md](README.md) in the same pull request. It's the only README: packing the package copies it, and `LICENSE`, into `packages/convex-workflow-migrations`.

## Releasing

Maintainers release from `main`:

1. Pick the version by [Epoch SemVer](https://antfu.me/posts/epoch-semver): `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at `100.0.0`. Bump the first number by one for a breaking change, which includes moving to a new `@convex-dev/workflow` version with breaking changes, and to the next hundred for a new epoch. A new upstream version without breaking changes is a minor release.
2. Set `version` in `packages/convex-workflow-migrations/package.json`, and move the "Unreleased" changelog entries under the new version.
3. Push a tag `v<version>`. The [release workflow](.github/workflows/release.yml) checks that the tag matches the package version, runs the checks, then stages the package on npm.
4. Approve the staged version with 2FA under **Staged Packages** on npmjs.com, or with `npm stage approve <id>`. It goes live on approval.
