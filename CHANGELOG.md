# Changelog

This project follows [Epoch Semantic Versioning](https://antfu.me/posts/epoch-semver): versions are `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at epoch 1 (`100.0.0`). A change to the first number can break your app; minor and patch releases don't.

## Unreleased

The first release, for `@convex-dev/workflow` 0.4.10.

- Per-workflow migrations: `workflow.define({ migrations: [migration(id, (h) => ...)] })`. A migration rewrites a run's recorded history into the shape the current handler expects: insert a finished stand-in with its result, insert a step that runs late, remove, rename, or update a step's args. Each run records the ids applied to it and applies the missing ones, in order, the next time it replays, so an installation can skip releases. Duplicate ids throw when the workflow is defined.
- A run whose history doesn't match the code, whose migration throws, or whose applied ids aren't the start of the code's list (a rollback) is paused instead of failed. It's retried after 1 minute, 10 minutes, 1 hour, then every 6 hours, and `onPause` in the manager's options is called once when it pauses.
- `WorkflowManager.paused`, `resume`, `restartFrom` and `fail` for paused runs; `cancel` also ends a pause, and `cleanup` also deletes the run's record.
- The `workflowPatches` component, with one row per run: its applied migrations, their edits, and its pause.
- convex-test helpers in `@dev-marzahn/convex-workflow-patches/test`: `register`, `expectReplays` (replays recorded histories against the current handler), `history` (builds one by hand) and `migrate` (the history after the migrations).
- `convex-workflow-patches histories <workflow>`: exports a workflow's run histories from a deployment as JSON, for `expectReplays`.
- Upstream's exports are re-exported, except `defineWorkflow` and the standalone `cleanup`, which bypass the migrations and the run's record.
