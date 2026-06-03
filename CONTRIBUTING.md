# Contributing

This project is TypeScript-first in the pipeline layer and uses a separate vault git repository for generated knowledge artifacts.

For the project vision and architectural principles, read `AGENTS.md` first.

## Before changing code

Read the relevant docs:

- `README.md`
- `pipelines/README.md`
- `docs/developer-guide.md`
- `docs/architecture-improvement-notes.md` for larger refactors

## Verification

From `pipelines/` run:

```bash
npm run typecheck
npm test
npm run build
```

For shell scripts, also run:

```bash
bash -n path/to/script.sh
git diff --check
```

If SQLite tests fail after a Node upgrade with a native binding error:

```bash
npm rebuild better-sqlite3
```

Then rerun the verification commands.

## Change hygiene

- Keep commits focused and logically scoped.
- Update docs when behavior, env vars, operational commands, or architecture changes.
- Add tests for new parser behavior, LLM validation, DB transitions, idempotency, and rollback/recovery logic.
- Avoid live network calls in tests; prefer fixtures or fake fetch functions.
- Do not commit local `.env`, vault contents, generated DB files, or lock files.

## Pull requests

Before merging or replacing remote branches, check that the branch is based on current `main` and does not delete newer safety/operational work.

Useful checks:

```bash
git fetch --all --prune
git diff --stat main..branch-name
git diff --name-status main..branch-name
```

If a branch is stale, port the useful pieces onto a fresh branch from current `main` rather than merging regressions.
