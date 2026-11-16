# Vendored `@convex-dev/workflow` client

These files are the client half of [`@convex-dev/workflow`](https://github.com/convex/workflow) **0.4.10** (npm; built from commit `6c5cdfd`), the code that runs inside the app's workflow mutation and replays the journal. They are Apache-2.0 ([LICENSE](LICENSE)); the rest of this package is MPL-2.0.

The server half, the `workflow` component, is not copied. Apps install it from `@convex-dev/workflow` with `app.use(workflow)`, and these files call its functions (`journal.load`, `journal.startSteps`, `workflow.create`, `workflow.complete`). The types for those calls come from the installed package (`types.ts`), so a change in its API is a type error here.

## Changes

The main changes are marked `PATCHES:`; [`upstream.diff`](upstream.diff) is the complete record, including the import paths and renames that carry no marker. The logic the patches call lives outside this directory, in `src/history.ts`, `src/migrations.ts` and `src/replay.ts`, so the copy stays close to upstream. The `/replay` helpers call `replayHandler` too; [CONTRIBUTING.md](../../../../../CONTRIBUTING.md#internals) describes them.

| File | Change |
| --- | --- |
| `workflowMutation.ts` | Takes a `WorkflowMigrations` parameter (`src/migrations.ts`): the migrations component, the workflow's migrations and its `args` validator. Called directly to create a run, it writes the run's record in the same transaction (`recordStart`), with `startAsync` too. Before replay, loads the run's record and applies its pending migrations in memory (`loadRecord`), which throws, so the run fails, if they can't be applied. Replaces upstream's handler and executor workers with one call of `replayHandler` (`src/replay.ts`) with the prepared history, which runs them as upstream does, with the args as the migrations left them. Args that fail validation throw a `ReplayError` instead of completing the run as failed, and so does a handler that throws after migrations applied in this handler run, unless the history's last step failed or was canceled. After the replay, saves the record in its transaction if it changed. |
| `step.ts` | Matches step calls against the history (`HistoryView.replay()` in `src/history.ts`) instead of the raw journal, so `getGenerationState` reads it too: a stand-in resolves its call without sending anything, removed steps are gone, and rewritten steps compare by their new name and args and resolve with their new result. `completeMessage` matches a stand-in inserted without args on its name and kind, and throws `ReplayMismatch`, with the position in the history, for a mismatch. With `checkOnly`, it compares a running step's call without resolving it: a running step blocks replay, which only a history given to `expectReplays()` has. |
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
