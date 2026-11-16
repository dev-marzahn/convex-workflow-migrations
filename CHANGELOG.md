# Changelog

This project follows [Epoch Semantic Versioning](https://antfu.me/posts/epoch-semver): versions are `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at epoch 1 (`100.0.0`). A change to the first number can break your app; minor and patch releases don't.

## Unreleased

- The first release, as `@dev-marzahn/convex-workflow-migrations`, for `@convex-dev/workflow` 0.4.10: per-workflow migrations. `migration(id, fn)`, listed in `workflow.define({ migrations })`, rewrites a run's recorded history into the shape the current handler expects. Each run's record in the `workflowMigrations` component, written when the run is created, says which migrations it has had; the pending ones apply at its next replay, so a run from any older release replays on the newest code. A run that can't replay fails with a message that says why. `restart({ from })` refuses a run whose migrations edited its history. `/replay` has `history()`, `expectReplays` and `migrate`, without Convex; `/test` adds `register(t)` for convex-test. This replaces the earlier, unreleased `step.patched()` design and its predeploy check.
