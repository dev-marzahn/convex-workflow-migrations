# Vendored `@convex-dev/workflow` client

These files are the client half of [`@convex-dev/workflow`](https://github.com/convex/workflow) **0.4.10** (npm; built from commit `6c5cdfd`), the code that runs inside the app's workflow mutation and replays the journal. They are Apache-2.0 ([LICENSE](LICENSE)); the rest of this package is MPL-2.0.

The server half, the `workflow` component, is not copied. Apps install it from `@convex-dev/workflow` with `app.use(workflow)`, and these files call its functions (`journal.load`, `journal.startSteps`, `workflow.create`, `workflow.complete`). The types for those calls come from the installed package (`types.ts`), so a change in its API is a type error here.

## Changes

The main changes are marked `PATCHES:`; [`upstream.diff`](upstream.diff) is the complete record, including the import paths and renames that carry no marker. The logic the patches call lives outside this directory, in `src/migrations.ts`, `src/replay.ts` and `src/testing.ts`, so the copy stays close to upstream.

| File | Change |
| --- | --- |
| `workflowMutation.ts` | Takes a `WorkflowMigrations` parameter (`src/migrations.ts`): the migrations component, the workflow's migrations and `onPause`. Loads the journal with `loadJournal`, which deletes the record of a paused run whose workflow is gone. Returns for a finished run of any result, not only success, so a retry left over from `fail` ends the pause. Loads the run's record and applies its pending migrations in memory (`RunRecord`); a run they can't be applied to pauses. Replaces upstream's handler and executor workers with one call of `replayHandler` (`src/replay.ts`), which replays the handler against the history with the args as the migrations left them and returns upstream's result or the pause the run should take, by the rules in the README's "Pausing and recovery". A pause is recorded, with the mutation's own function handle for the retry, outside the replay's environment, and the mutation returns normally. Saves the record after a replay that matched, in its transaction. Hands a replay request from `expectReplays()` or `migrate()` in `/test` to `src/testing.ts`. |
| `step.ts` | Matches step calls against the history (`HistoryView.replay()` in `src/history.ts`) instead of the raw journal, so `getGenerationState` reads it too: a stand-in resolves its call without sending anything, removed steps are gone, rewritten steps compare by their new name and args and resolve with their new result. `completeMessage` matches a stand-in inserted without args on its name and kind, throws `ReplayMismatch` for a mismatch with the history, and with `checkOnly` compares a running step's call without resolving it: a running step blocks replay, which only a history given to `expectReplays()` has. `progress()` tells the workflow mutation how far replay got, and whether a step past the history started. |
| `workflowContext.ts` | Import paths, and the header comment. |
| `types.ts` | `JournalEntry` and `Step` derived from the installed component's API (upstream imports them from its schema, which isn't exported). `WorkflowHandler` with this package's `WorkflowCtx`. |
| `environment.ts`, `logging.ts`, `publicTypes.ts`, `safeFunctionName.ts`, `shared.ts` | Unchanged copies. Upstream doesn't export them. |

## Updating to a new upstream release

1. Bump the exact `@convex-dev/workflow` version in the root catalog and the peer dependency, then `bun install`.
2. Copy the new release's sources from the installed package, the directory `packages/convex-workflow-migrations/node_modules/@convex-dev/workflow` (a link into `node_modules/.bun/`, which is where `tests/vendor.test.ts` resolves it from): `src/client/{workflowMutation,step,workflowContext,environment,safeFunctionName,types}.ts`, `src/component/logging.ts`, `src/shared.ts` and `src/types.ts` (as `publicTypes.ts`). Put them in a temporary directory, and keep it.
3. Copy them over these files too, then apply the changes: from this directory, `patch -p1 < upstream.diff`. Fix conflicts.
4. Update the version and commit in this file, the `vendored from @convex-dev/workflow <version>` header comments, the versions table and the install command in the repo's README.md. Find the commit with `npm view @convex-dev/workflow@<version> gitHead`.
5. Regenerate the diff against the temporary directory, after step 4, since the header comments are part of it: for each file, `diff -u --label upstream/<file> --label vendor/<file> <temporary copy> <file>`, concatenated in alphabetical order of the file names (`step`, `types`, `workflowContext`, `workflowMutation`). Unchanged files produce no hunk.
6. `bun run ready` and `bun run e2e`. `packages/convex-workflow-migrations/tests/vendor.test.ts` checks that these files are the installed release plus `upstream.diff`; its file list matches the table above. A type error usually means the component API changed shape.
