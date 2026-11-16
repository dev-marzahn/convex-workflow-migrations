# Vendored `@convex-dev/workflow` client

These files are the client half of [`@convex-dev/workflow`](https://github.com/convex/workflow) **0.4.10** (npm; built from commit `6c5cdfd`), the code that runs inside the app's workflow mutation and replays the journal. They are Apache-2.0 ([LICENSE](LICENSE)); the rest of this package is MPL-2.0.

The server half, the `workflow` component, is not copied. Apps install it from `@convex-dev/workflow` with `app.use(workflow)`, and these files call its functions (`journal.load`, `journal.startSteps`, `workflow.create`, `workflow.complete`). The types for those calls come from the installed package (`types.ts`), so a change in its API is a type error here.

## Changes

The main changes are marked `PATCHES:`; [`upstream.diff`](upstream.diff) is the complete record, including the import paths and renames that carry no marker. The logic the patches call lives outside this directory, in `src/history.ts`, `src/migrations.ts` and `src/replay.ts`, so the copy stays close to upstream. The table says what changed in each file; [CONTRIBUTING.md](../../../../../CONTRIBUTING.md#internals) says why.

| File | Change |
| --- | --- |
| `workflowMutation.ts` | Takes a `WorkflowMigrations` parameter (`src/migrations.ts`). Called directly to create a run, it writes the run's record in the same transaction (`recordStart`), with `startAsync` too. Returns for a finished run of any result, not only success. Before replay, loads the run's record and applies its pending migrations in memory (`loadRecord`), and pauses a run they can't be applied to. Replaces upstream's handler and executor workers with one call of `replayHandler` (`src/replay.ts`), which returns the pause the run takes instead of a result, if it can't replay. Records a pause outside `setupEnvironment`'s deterministic `Date` and `console`, and returns normally. After a replay that matched, saves the record in its transaction. |
| `step.ts` | Matches step calls against the history (`HistoryView.replay()` in `src/history.ts`) instead of the raw journal, and `getGenerationState` reads it too. `completeMessage` matches a stand-in inserted without args on its name and kind, throws `ReplayMismatch`, with the position in the history, for a mismatch, and with `checkOnly` compares a running step's call without resolving it. `run()` stops at a running step. `progress()` says how far replay got, and whether the handler run started, or queued a call to, a step past the history. `run()` starts no step once `halted` is set. |
| `workflowContext.ts` | Import paths, and the header comment. |
| `types.ts` | `JournalEntry` and `Step` derived from the installed component's API (upstream imports them from its schema, which isn't exported). `WorkflowHandler` with this package's `WorkflowCtx`. |
| `environment.ts`, `logging.ts`, `publicTypes.ts`, `safeFunctionName.ts`, `shared.ts` | Unchanged copies. Upstream doesn't export them. |

## Changing the copy

Keep a change to a vendored file as small as the feature allows, and put its logic outside this directory. Mark it with a `PATCHES:` comment, describe it in the table above, then run `bun run vendor diff` from the repo root, which regenerates `upstream.diff` from the files as they are: the diff is the record of every change, and `tests/vendor.test.ts` fails until it matches.

## Re-vendoring a new upstream release

These are the vendoring steps of [the procedure for a new upstream release](../../../../../CONTRIBUTING.md#updating-convex-devworkflow), after the new version is installed. [`scripts/vendor.ts`](../../../../../scripts/vendor.ts) does the copying and diffing. Its `FILES` map, which `tests/vendor.test.ts` uses too, lists each vendored file and its source in the upstream package.

1. Run `bun run vendor` from the repo root. It copies the installed release's sources over these files, re-applies `upstream.diff`, sets the version in the `vendored from @convex-dev/workflow <version>` header comments, and regenerates the diff.
2. If a vendored file now imports a file upstream added, add it to `FILES` and to the table above, and run `bun run vendor` again. Then fix the new file's imports and the import of it by hand, then `bun run vendor diff`.
3. If a hunk doesn't apply, the script leaves a `<file>.rej` next to the file it belongs to. Make the change by hand, keeping its `PATCHES:` marker, delete the `.rej` file, then run `bun run vendor diff`.
4. Update the version and commit at the top of this file. Find the commit with `npm view @convex-dev/workflow@<version> gitHead`.
