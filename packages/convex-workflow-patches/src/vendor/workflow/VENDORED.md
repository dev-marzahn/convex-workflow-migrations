# Vendored `@convex-dev/workflow` client

These files are the client half of [`@convex-dev/workflow`](https://github.com/convex/workflow) **0.4.10** (npm; built from commit `6c5cdfd`), the code that runs inside the app's workflow mutation and replays the journal. They are Apache-2.0 ([LICENSE](LICENSE)); the rest of this package is MPL-2.0.

The server half, the `workflow` component, is not copied. Apps install it from `@convex-dev/workflow` with `app.use(workflow)`, and these files call its functions (`journal.load`, `journal.startSteps`, `workflow.create`, `workflow.complete`). The types for those calls come from the installed package (`types.ts`), so a change in its API is a type error here.

## Changes

Every change is marked `PATCHES:`. [`upstream.diff`](upstream.diff) has the full diff against 0.4.10 (156 changed lines in 1,656).

| File | Change |
| --- | --- |
| `workflowContext.ts` | Adds `step.patched(id)` and `step.deprecatePatch(id)`. Every step call goes through `runStep`, which gives it a position (`seq`) at the call site. |
| `step.ts` | `StepRequest` carries `seq`. After `journal.startSteps`, writes the markers of patches decided at the frontier, in the same transaction. |
| `workflowMutation.ts` | Loads the run's markers and creates a `PatchState` per handler run. Takes the marker component as a parameter. |
| `types.ts` | `JournalEntry` and `Step` derived from the installed component's API (upstream imports them from its schema, which isn't exported). `WorkflowHandler` with this package's `WorkflowCtx`. |
| `environment.ts`, `logging.ts`, `publicTypes.ts`, `safeFunctionName.ts`, `shared.ts` | Unchanged copies. Upstream doesn't export them. |

## Updating to a new upstream release

1. Bump the exact `@convex-dev/workflow` version in the root catalog and the peer dependency.
2. Copy the new release's `src/client/{workflowMutation,step,workflowContext,environment,safeFunctionName,types}.ts`, `src/component/logging.ts`, `src/shared.ts` and `src/types.ts` (as `publicTypes.ts`) over these files.
3. Re-apply the changes in `upstream.diff` (from this directory: `patch -p1 < upstream.diff` against the fresh copies), fix conflicts, then regenerate the diff: for each file, `diff -u --label upstream/<file> --label vendor/<file> <fresh upstream copy> <file>`, concatenated.
4. `bun run ready` and `bun run e2e`. `tests/vendor.test.ts` checks that these files are the installed release plus `upstream.diff`; its file list matches the table above. A type error usually means the component API changed shape.
