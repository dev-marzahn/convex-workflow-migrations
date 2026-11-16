# Vendored `@convex-dev/workflow` client

These files are the client half of [`@convex-dev/workflow`](https://github.com/convex/workflow) **0.4.10** (npm; built from commit `6c5cdfd`), the code that runs inside the app's workflow mutation and replays the journal. They are Apache-2.0 ([LICENSE](LICENSE)); the rest of this package is MPL-2.0.

The server half, the `workflow` component, is not copied. Apps install it from `@convex-dev/workflow` with `app.use(workflow)`, and these files call its functions (`journal.load`, `journal.startSteps`, `workflow.create`, `workflow.complete`). The types for those calls come from the installed package (`types.ts`), so a change in its API is a type error here.

## Changes

The main changes are marked `PATCHES:`; [`upstream.diff`](upstream.diff) is the complete record, including the import paths and renames that carry no marker. The logic the patches call lives outside this directory, in `src/history.ts`, `src/migrations.ts` and `src/replay.ts`, so the copy stays close to upstream. The `/replay` helpers (`src/helpers.ts`) don't go through the workflow mutation: they build the history with `prepareRun`, and `expectReplays()` then calls `replayHandler` itself, with a `StepExecutor` that starts no step.

| File | Change |
| --- | --- |
| `workflowMutation.ts` | Takes a `WorkflowMigrations` parameter (`src/migrations.ts`): the migrations component, the workflow's migrations and its `args` validator. Called directly to create a run, it writes the run's record in the same transaction (`recordStart`), with `startAsync` too. Before replay, loads the run's record and applies its pending migrations in memory (`loadRecord`), which throws, so the run fails, if they can't be applied. Replaces upstream's handler and executor workers with one call of `replayHandler` (`src/replay.ts`), which runs them as upstream does, with the args as the migrations left them. After the replay, saves the record in its transaction if it changed. |
| `step.ts` | Matches step calls against the history (`HistoryView.replay()` in `src/history.ts`) instead of the raw journal, so `getGenerationState` reads it too: a stand-in resolves its call without sending anything, removed steps are gone, and rewritten steps compare by their new name and args and resolve with their new result. `completeMessage` matches a stand-in inserted without args on its name and kind, and throws `ReplayMismatch`, with the position in the history, for a mismatch. With `checkOnly`, it compares a running step's call without resolving it: a running step blocks replay, which only a history given to `expectReplays()` has. |
| `workflowContext.ts` | Import paths, and the header comment. |
| `types.ts` | `JournalEntry` and `Step` derived from the installed component's API (upstream imports them from its schema, which isn't exported). `WorkflowHandler` with this package's `WorkflowCtx`. |
| `environment.ts`, `logging.ts`, `publicTypes.ts`, `safeFunctionName.ts`, `shared.ts` | Unchanged copies. Upstream doesn't export them. |

## Changing the copy

Keep a change to a vendored file as small as the feature allows, and put its logic outside this directory. Mark it with a `PATCHES:` comment, describe it in the table above, then run `bun run vendor diff` from the repo root, which regenerates `upstream.diff` from the files as they are: the diff is the record of every change, and `tests/vendor.test.ts` fails until it matches.

## Updating to a new upstream release

[`scripts/vendor.ts`](../../../../../scripts/vendor.ts) does the copying and diffing. Its `FILES` map, which `tests/vendor.test.ts` uses too, lists each vendored file and its source in the upstream package.

1. Set the new version in the root `package.json` catalog and in the package's `peerDependencies`, then `bun install`.
2. Run `bun run vendor` from the repo root. It copies the installed release's sources over these files, re-applies `upstream.diff`, sets the version in the `vendored from @convex-dev/workflow <version>` header comments, and regenerates the diff.
3. If a vendored file now imports a file upstream added, add it to `FILES` and to the table above, and run `bun run vendor` again.
4. If a hunk doesn't apply, the script leaves a `<file>.rej` next to the file it belongs to. Make the change by hand, keeping its `PATCHES:` marker, delete the `.rej` file, then run `bun run vendor diff`.
5. Update the version and commit at the top of this file, and the versions table in the repo's README.md. Find the commit with `npm view @convex-dev/workflow@<version> gitHead`.
6. `bun run ready` and `bun run e2e`. `tests/vendor.test.ts` checks that these files are the installed release plus `upstream.diff`, and that the diff is what `bun run vendor diff` writes. A type error usually means the component API changed shape.
