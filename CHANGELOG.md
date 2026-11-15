# Changelog

This project follows [Epoch Semantic Versioning](https://antfu.me/posts/epoch-semver): versions are `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at epoch 1 (`100.0.0`). A change to the first number can break your app; minor and patch releases don't.

## Unreleased

The first release, for `@convex-dev/workflow` 0.4.10.

- `step.patched(id)` and `step.deprecatePatch(id)` in workflows defined with this package's `WorkflowManager`.
- The `workflowPatches` component, which stores patch markers: `markers.list`, `markers.runsWithPatch` and `markers.cleanup`.
- `WorkflowManager.cleanup` deletes a run's markers with the run.
- convex-test helpers in `@dev-marzahn/convex-workflow-patches/test`: `register` and `simulateDeploy`.
