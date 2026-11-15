# Changelog

This project follows [Epoch Semantic Versioning](https://antfu.me/posts/epoch-semver): versions are `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at epoch 1 (`100.0.0`). A change to the first number can break your app; minor and patch releases don't.

## Unreleased

The first release, for `@convex-dev/workflow` 0.4.10.

- `step.patched(id)` and `step.deprecatePatch(id)` in workflows defined with this package's `WorkflowManager`. Patch ids are declared per workflow in `convex/patches.ts` and passed as `declared`; `patched()` throws for an undeclared id.
- A recorded patch counts wherever its `patched()` call sits in the run's history, so a released call can move.
- The `workflowPatches` component, which records per run which patches it took and skipped, and which patch ids its code declared: `runs.load`, `runs.save`, `runs.lookup`, `runs.deployed` and `runs.cleanup`.
- A predeploy check for [convex-release](https://github.com/dev-marzahn/convex-release) 100.1.0 or later (protocol 1; tested with 100.1.0-next.0): convex-release's deploys and images refuse a release that removes a patch's old branch while running workflows may still need it.
- `convex-workflow-patches check`: the same check from a checkout, for deploys without convex-release.
- An optional `componentPaths` export in `convex/patches.ts`, for components mounted under other names.
- A run that skipped a patch whose old branch was removed fails with an error naming the patch.
- `WorkflowManager.cleanup` deletes a run's patch records with the run.
- convex-test helpers in `@dev-marzahn/convex-workflow-patches/test`: `register` and `simulateDeploy`.
- Upstream's exports are re-exported, except `defineWorkflow` and the standalone `cleanup`, which bypass patching.
