# Vendored `@convex-dev/workflow` client

These files are the client half of [`@convex-dev/workflow`](https://github.com/convex/workflow) **0.4.10** (npm; built from commit `6c5cdfd`), the code that runs inside the app's workflow mutation and replays the journal. They are Apache-2.0 ([LICENSE](LICENSE)); the rest of this package is MPL-2.0.

The server half, the `workflow` component, is not copied. Apps install it from `@convex-dev/workflow` with `app.use(workflow)`, and these files call its functions (`journal.load`, `journal.startSteps`, `workflow.create`, `workflow.complete`). The types for those calls come from the installed package (`types.ts`), so a change in its API is a type error here.

## Changes

The main changes are marked `PATCHES:`; [`upstream.diff`](upstream.diff) is the complete record, including the import paths and renames that carry no marker.

| File | Change |
| --- | --- |
| `workflowMutation.ts` | Takes the migrations component and the workflow's migrations as a parameter. Loads the run's record and applies its pending migrations in memory (`RunRecord` in `src/migrations.ts`), and replays against the resulting history. A run whose migrations can't be applied, or whose replay doesn't match, is paused instead of failed: the mutation records the pause, with its own function handle for the retry, and returns normally. Saves the record after a replay that matched, in its transaction. Hands a replay request from `expectReplays()` or `migrate()` in `/test` to `src/testing.ts`. |
| `step.ts` | Matches step calls against the history (`HistoryView.replay()` in `src/history.ts`) instead of the raw journal, so `getGenerationState` reads it too: a stand-in resolves its call without sending anything, removed steps are gone, rewritten steps compare by their new name and args. A mismatch throws `ReplayMismatch`. A running step blocks replay, which only a history given to `expectReplays()` has. |
| `workflowContext.ts` | Import paths only. |
| `types.ts` | `JournalEntry` and `Step` derived from the installed component's API (upstream imports them from its schema, which isn't exported). `WorkflowHandler` with this package's `WorkflowCtx`. |
| `environment.ts`, `logging.ts`, `publicTypes.ts`, `safeFunctionName.ts`, `shared.ts` | Unchanged copies. Upstream doesn't export them. |

## Updating to a new upstream release

1. Bump the exact `@convex-dev/workflow` version in the root catalog and the peer dependency, then `bun install`.
2. Copy the new release's `src/client/{workflowMutation,step,workflowContext,environment,safeFunctionName,types}.ts`, `src/component/logging.ts`, `src/shared.ts` and `src/types.ts` (as `publicTypes.ts`) into a temporary directory, and keep it.
3. Copy them over these files too, then apply the changes: from this directory, `patch -p1 < upstream.diff`. Fix conflicts.
4. Regenerate the diff against the temporary directory: for each file, `diff -u --label upstream/<file> --label vendor/<file> <temporary copy> <file>`, concatenated in alphabetical order of the file names (`step`, `types`, `workflowContext`, `workflowMutation`). Unchanged files produce no hunk.
5. Update the version and commit in this file, the `vendored from @convex-dev/workflow <version>` header comments, and the versions table in the repo's README.md. Find the commit with `npm view @convex-dev/workflow@<version> gitHead`.
6. `bun run ready` and `bun run e2e`. `packages/convex-workflow-migrations/tests/vendor.test.ts` checks that these files are the installed release plus `upstream.diff`; its file list matches the table above. A type error usually means the component API changed shape.
