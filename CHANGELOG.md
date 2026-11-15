# Changelog

This project follows [Epoch Semantic Versioning](https://antfu.me/posts/epoch-semver): versions are `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at epoch 1 (`100.0.0`). A change to the first number can break your app; minor and patch releases don't.

## Unreleased

The first release, for `@convex-dev/workflow` 0.4.10.

- `step.patched(id)` and `step.deprecatePatch(id)` in workflows defined with this package's `WorkflowManager`. Patch ids are declared per workflow in `convex/patches.ts` as `active`, `deprecated` or `retired`, and passed as `declared`. With `as const`, a wrong id is a type error; at runtime, a call that doesn't match the declarations throws.
- A recorded patch counts wherever its `patched()` call sits in the run's history, so a released call can move. A run that skipped the patch keeps the old path at later call sites.
- The `workflowPatches` component, which records per run which patches it took and skipped and which patch ids its code declared, and per workflow every patch id its runs recorded.
- A predeploy check for [convex-release](https://github.com/dev-marzahn/convex-release) 100.1.0-next.0 or later (protocol 1): convex-release's deploys and images refuse a release that deprecates or retires a patch while running workflows may still need its old branch, or that drops a patch running workflows recorded.
- `convex-workflow-patches check`: the same check from a checkout, for deploys without convex-release.
- An optional `componentPaths` export in `convex/patches.ts`, for components mounted under other names.
- A run that skipped a patch whose old branch was removed fails with an error naming the patch.
- `WorkflowManager.cleanup` deletes a run's patch records with the run.
- convex-test helpers in `@dev-marzahn/convex-workflow-patches/test`: `register` and `simulateDeploy`.
- Upstream's exports are re-exported, except `defineWorkflow` and the standalone `cleanup`, which bypass patching.
