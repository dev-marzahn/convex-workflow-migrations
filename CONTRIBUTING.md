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

| Path                               | Contents                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/convex-workflow-patches` | The npm package: the `WorkflowManager`, the marker component (`src/component`), the vendored `@convex-dev/workflow` client (`src/vendor/workflow`), the `drain` CLI (`src/cli.ts`) and the convex-test helpers (`src/test.ts`). |
| `examples/basic`                   | An app with a patched workflow and its tests.                                                                                                                                                                                   |
| `e2e/`                             | Fixture apps v1, v2 and v2-unguarded, and the script that deploys them over each other on a real backend.                                                                                                                       |
| `scripts/codegen.ts`               | Rewrites every `_generated/` folder.                                                                                                                                                                                            |

## Codegen

The `_generated/` folders are committed. After changing the component's functions or an app's, run:

```sh
bun run codegen
```

Component codegen pulls deployment state, so the script starts a throwaway backend in Docker (`e2e/backend.ts`), runs `convex codegen` for the component and every app, and removes the container. Nothing is deployed.

## End-to-end tests

```sh
bun run e2e             # all scenarios, under a minute
bun run e2e patched     # only the named scenarios
```

Each scenario starts a fresh backend, deploys fixture app v1, starts a run that waits on `awaitEvent`, deploys the next fixture app over it, sends the event and checks which steps ran.

## Updating @convex-dev/workflow

The package carries a copy of one upstream release's client code. To move to a new release:

1. Set the new version in the root `package.json` catalog and in the package's `peerDependencies`, then `bun install`.
2. Follow the steps in [`VENDORED.md`](packages/convex-workflow-patches/src/vendor/workflow/VENDORED.md): copy the new upstream files, re-apply `upstream.diff`, regenerate it.
3. `bun run ready` and `bun run e2e`. `tests/vendor.test.ts` fails until the copy is the installed release plus the diff.
4. Add a row to the versions table in README.md and a line to CHANGELOG.md.

## Backend version

`e2e/backend.ts` pins the Convex backend build the tests use: the one convex-release pins in its `images/Dockerfile`. Move them together, then run `bun run e2e`.

## Pull requests

- Run `bun run ready` before you push. Run `bun run e2e` too if you touched the vendored client, the component or `src/patchState.ts`.
- Add a test for a bug fix or a new option.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for a change users will notice.
- If you change how the package behaves, update [README.md](README.md) in the same pull request. It's the only README: packing the package copies it, and `LICENSE`, into `packages/convex-workflow-patches`.

## Releasing

Maintainers release from `main`:

1. Pick the version by [Epoch SemVer](https://antfu.me/posts/epoch-semver): `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at `100.0.0`. Bump the first number by one for a breaking change, which includes moving to a new `@convex-dev/workflow` version with breaking changes, and to the next hundred for a new epoch.
2. Set `version` in `packages/convex-workflow-patches/package.json`, and move the "Unreleased" changelog entries under the new version.
3. Push a tag `v<version>`. The [release workflow](.github/workflows/release.yml) checks that the tag matches the package version, runs the checks, then stages the package on npm.
4. Approve the staged version with 2FA under **Staged Packages** on npmjs.com, or with `npm stage approve <id>`. It goes live on approval.
