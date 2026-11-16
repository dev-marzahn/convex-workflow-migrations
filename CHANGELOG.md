# Changelog

This project follows [Epoch Semantic Versioning](https://antfu.me/posts/epoch-semver): versions are `{EPOCH * 100 + MAJOR}.MINOR.PATCH`, starting at epoch 1 (`100.0.0`). A change to the first number can break your app; minor and patch releases don't. Moving to a new `@convex-dev/workflow` version changes the first number.

## Unreleased

The first release, for `@convex-dev/workflow` 0.4.10.

- Per-workflow migrations: `workflow.define({ migrations: [migration(id, (h) => ...)] })`. A migration rewrites a run's recorded history into the shape the current handler expects: insert a finished stand-in with its result, remove, rename, update a step's args or result, or update the workflow's own args. Each run records the ids applied to it and applies the missing ones, in order, the next time it replays, so an installation can skip releases. Empty and duplicate ids throw when the workflow is defined.
- A run is paused instead of failed when its history doesn't match the code (including code that returns before the end of it), when its args don't match the validator and it has history, when the handler throws during replay where a migration may be the cause, when a migration throws, when its applied ids aren't the start of the code's list (a rollback), and when its overlay would pass 512 KiB. A pause commits nothing. A paused run is retried after 1 minute, 10 minutes, 1 hour, then every 6 hours, and `onPause` in the manager's options is called once when it pauses.
- `WorkflowManager.paused` (paginated, by workflow), `resume`, `resumeAll`, `restartFrom` and `fail` for paused runs; `cancel` also ends a pause, `restart` takes a position or step in the migrated history, and `cleanup` also deletes the run's record.
- The `workflowMigrations` component, with one row per run: its applied migrations, their edits, its pause and the row's format.
- convex-test helpers in `@dev-marzahn/convex-workflow-migrations/test`: `register`, `expectReplays` (replays recorded histories against the current handler, by a handler run's rules), `history` (builds one by hand), `migrate` (the history after the migrations) and `expectEdits` (fails for a migration that changed nothing).
- `convex-workflow-migrations histories <workflow>`: exports a workflow's run histories from a deployment as JSON, for `expectReplays`, with a warning that they hold production data and `--redact <module>` to scrub them.
- Upstream's exports are re-exported, except `defineWorkflow` and the standalone `cancel`, `restart` and `cleanup`, which bypass the migrations or the run's record.
