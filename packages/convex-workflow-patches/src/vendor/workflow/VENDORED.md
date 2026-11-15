# Vendored `@convex-dev/workflow` client

These files are the client half of [`@convex-dev/workflow`](https://github.com/convex/workflow) **0.4.10** (npm; built from commit `6c5cdfd`), the code that runs inside the app's workflow mutation and replays the journal. They are Apache-2.0 ([LICENSE](LICENSE)); the rest of this package is MPL-2.0.

The server half, the `workflow` component, is not copied. Apps install it from `@convex-dev/workflow` with `app.use(workflow)`, and these files call its functions (`journal.load`, `journal.startSteps`, `workflow.create`, `workflow.complete`). The types for those calls come from the installed package (`types.ts`), so a change in its API is a type error here.

## Changes

The main changes are marked `PATCHES:`; [`upstream.diff`](upstream.diff) is the complete record, including the import paths and renames that carry no marker.

| File | Change |
| --- | --- |
| `workflowContext.ts` | Adds `step.patched(id)` and `step.deprecatePatch(id)`, and makes `WorkflowCtx` generic over the declared ids. Every step call goes through `runStep`, which gives it a position (`seq`) at the call site. |
| `step.ts` | `StepRequest` carries `seq`. After `journal.startSteps`, hands the new steps' ids to `PatchState`, so frontier decisions get their markers. |
| `workflowMutation.ts` | Reads the workflow's function name and the run's records, and creates a `PatchState` per handler run. Writes what the run decided at the end, in its transaction. Adds the cause to a journal mismatch in a run that skipped a removed patch. Takes the patches component and the declared patches as a parameter. |
| `types.ts` | `JournalEntry` and `Step` derived from the installed component's API (upstream imports them from its schema, which isn't exported). `WorkflowHandler` with this package's `WorkflowCtx`. |
| `environment.ts`, `logging.ts`, `publicTypes.ts`, `safeFunctionName.ts`, `shared.ts` | Unchanged copies. Upstream doesn't export them. |

## Updating to a new upstream release

1. Bump the exact `@convex-dev/workflow` version in the root catalog and the peer dependency, then `bun install`.
2. Copy the new release's `src/client/{workflowMutation,step,workflowContext,environment,safeFunctionName,types}.ts`, `src/component/logging.ts`, `src/shared.ts` and `src/types.ts` (as `publicTypes.ts`) into a temporary directory, and keep it.
3. Copy them over these files too, then apply the changes: from this directory, `patch -p1 < upstream.diff`. Fix conflicts.
4. Regenerate the diff against the temporary directory: for each file, `diff -u --label upstream/<file> --label vendor/<file> <temporary copy> <file>`, concatenated in alphabetical order of the file names (`step`, `types`, `workflowContext`, `workflowMutation`). Unchanged files produce no hunk.
5. Update the version and commit in this file, the `vendored from @convex-dev/workflow <version>` header comments, and the versions table in the repo's README.md. Find the commit with `npm view @convex-dev/workflow@<version> gitHead`.
6. `bun run ready` and `bun run e2e`. `packages/convex-workflow-patches/tests/vendor.test.ts` checks that these files are the installed release plus `upstream.diff`; its file list matches the table above. A type error usually means the component API changed shape.
