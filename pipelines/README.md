# chiya-pipelines

Curation pipelines for the Chiya Library — TypeScript on [`thread-phase`](https://github.com/Code4me2/thread-phase). Three composable typed pipelines (intake / librarian / digest) running as plain Node processes under systemd user timers.

## Status

| Pipeline | State | Cadence |
|---|---|---|
| `intake` | live | every 4h at HH:03 |
| `librarian` | live (v3 router → scouts → reviewer flow) | every 10 min (drain mode); switch to 30 min once `pending` clears |
| `digest` | live | 06:30 / 18:30 local |
| `daily cycle` | optional | 09:00 local catch-up timer: collect → intake → librarian passes → digest/email |

369 tests, all green. `npm test`, `npm run build`.

## Setup

```bash
cd ~/chiya-library/pipelines
npm install
npm run build
```

### Required env

`VAULT_DIR` and `CHIYA_EMAIL_TO` are the only must-set vars. Everything else has defaults wired for the tiny-emerson Ollama tunnel + local vault. Put them in `pipelines/.env` (gitignored) — systemd loads via `EnvironmentFile=`.

| Var | Default | Notes |
|---|---|---|
| `VAULT_DIR` | `~/vault` | Vault repo root |
| `VAULT_REMOTE` | `origin` | Git remote to push to |
| `VAULT_BRANCH` | `main` | |
| `CHIYA_EMAIL_TO` | *(required)* | Digest delivery target |
| `FAST_INFERENCE_BASE_URL` | `http://localhost:11435/v1` | Fast-tier OpenAI-compatible endpoint |
| `FAST_INFERENCE_MODEL` | `gemma4:e4b` | Used by digest drafting + librarian summary |
| `TOOLS_INFERENCE_BASE_URL` | `http://localhost:11435/v1` | Tool-capable endpoint |
| `TOOLS_INFERENCE_MODEL` | `gemma4:26b` | Used by librarian router + scouts + reviewer. `26b` because `e4b` confabulated tool calls without actually invoking them. |
| `THREAD_PHASE_DB` | `<VAULT_DIR>/.chiya-pipelines.db` | Shared SQLite for both `article` and `job` tables |
| `CHIYA_FAST_MAX_TOKENS` | `4000` | Output-token cap for fast-tier digest classify/draft calls. Raised for reasoning models that otherwise spend the full cap on hidden reasoning and return `finishReason: length`. |
| `CHIYA_SOURCE_TIMEOUT_MS` | `15000` | Per-request timeout for TypeScript API source adapters |
| `CHIYA_SOURCE_RETRIES` | `1` | Retry count for retryable source HTTP failures (`408`, `429`, `5xx`) |
| `CHIYA_DIGEST_ONCE_DAILY` | unset (`1` in `run-cycle.sh` / `chiya-daily.service`) | Skip digest email when a successful `email-send` event already exists for the local date |
| `CHIYA_CYCLE_LIBRARIAN_PASSES` | `5` | Max librarian batches attempted by `run-cycle.sh` before digesting |
| `CHIYA_CYCLE_LIBRARIAN_BATCH` | `10` | Librarian batch size used by `run-cycle.sh` |
| `CHIYA_CYCLE_LIBRARIAN_MINUTES` | `8` | Librarian per-pass soft deadline used by `run-cycle.sh` |

The default `localhost:11435` is the SSH tunnel installed via `chiya-tunnel-tiny.service` (forwards to tiny-emerson:11434).

## Running by hand

```bash
set -a && source .env && set +a   # systemd loads this automatically

npm run doctor -- --no-network    # validate env/vault/db/git without inference HTTP checks
npm run status                    # article status counts + recent jobs
npm run intake                    # tsx src/intake.ts
npm run librarian                 # tsx src/librarian.ts
npm run librarian -- --dry-run    # calls agents + previews apply; no vault/git/article status mutation
npm run librarian -- --plan-only  # stops after semantic article plans; no apply preview
npm run digest:am                 # tsx src/digest.ts AM
npm run digest:pm                 # tsx src/digest.ts PM
./run-cycle.sh AM                 # collect → intake → librarian drain passes → guarded digest/email
```

Each pipeline run logs every event to stdout. Persisted job + event log lives in `$THREAD_PHASE_DB`. Inspect with sqlite directly or via thread-phase's `JobStore.getJob` / `getEvents`. `npm run doctor` exits nonzero only for failed checks; warnings cover optional/non-blocking issues such as skipped network checks or a dirty vault worktree.

## systemd install

```bash
mkdir -p ~/.config/systemd/user
ln -sf ~/chiya-library/pipelines/systemd/chiya-tunnel-tiny.service ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-intake.service      ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-intake.timer        ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-librarian.service   ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-librarian.timer     ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest@.service     ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest-am.timer     ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest-pm.timer     ~/.config/systemd/user/
# Optional once-daily catch-up cycle instead of, or alongside, separate timers:
ln -sf ~/chiya-library/pipelines/systemd/chiya-daily.service        ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-daily.timer          ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now \
  chiya-tunnel-tiny.service \
  chiya-intake.timer \
  chiya-librarian.timer \
  chiya-digest-am.timer \
  chiya-digest-pm.timer
# Optional: systemctl --user enable --now chiya-daily.timer

systemctl --user list-timers chiya-*
```

Every pipeline service has `ExecStartPre=npm rebuild better-sqlite3` so a silent Node ABI bump can't break the DB binding. Roughly 1s when already-current, ~30s when actually rebuilding.

Manual triggers:
```bash
systemctl --user start chiya-intake.service
systemctl --user start chiya-librarian.service
systemctl --user start chiya-digest@AM.service
systemctl --user start chiya-daily.service
journalctl --user -u chiya-librarian.service -f
```

## Pipeline shapes

### collection/api-ingest.ts

The live matcha collector calls the TypeScript API ingest from `matcha/scripts/collect.sh` before RSS filtering. `src/collection/api-ingest.ts` resolves the repository-local `matcha/` directory via `src/collection/paths.ts` and writes:

- `matcha/scripts/api-articles.jsonl`
- `matcha/scripts/api-digest.md`

`CHIYA_MATCHA_DIR` can override the computed `matcha/` path for tests or non-standard deployments. Registered API adapters now cover the legacy Python collector's active public endpoints: Semantic Scholar, OpenAlex, Crossref, arXiv, Zenodo, DOAJ, Europe PMC, INSPIRE-HEP, NCBI/PubMed, and OSF. Source HTTP calls use shared timeout/retry handling and report `health:elapsedMs` / `health:attempts` entries in `api-digest.md` source-health warnings.

### intake.ts

```
scanInbox          (pure)   read vault/raw/inbox/*-articles.md
parseAndStore      (pure)   upsert into ArticleStore (URL + title hash dedup)
archiveInboxFiles  (pure)   move processed files → vault/raw/inbox/archive/
```

No LLM. Idempotent — re-running on the same files inserts nothing new.

### librarian.ts

```
reapStale           (pure)   reset stuck 'processing' rows (> 20 min) back to pending
loadBatch           (pure)   pull up to N pending rows, mark as processing
                              (--dry-run leaves rows pending)
batchEnrich         (HTTP)   fetch full text for thin snippets, capped at 50KB
batchExtractRefs    (pure)   regex-extract arxiv IDs + DOIs from each body
planArticleTree     (LLM)    per-article fan-out, concurrency=4, no writes:
                              ├── router          (1 call, no tools)
                              ├── topic-scout     (vault_read, vault_list, vault_search)
                              ├── source-scout    (+ article_search_by_title)
                              ├── entity-scout    (vault tools)
                              ├── cite-tracker    (+ article_lookup_by_arxiv/doi)
                              ├── reviewer        (synthesizes the 4 scouts, vault_read)
                              └── summary         (fast-tier, no tools)
applyArticlePlans   (pure)   serial revalidation + deterministic writes
                              source page + topic touches + cite/entity backlinks + related source edges + ArticleStore status
                              (--dry-run revalidates and reports would-write/would-skip/would-fail without writes)
mergeMetadata       (pure)   append per-article entries to vault/log.md
commitLocal         (pure)   single git commit per run (no push — digest pushes)
```

Per-article planning wall: ~50-85s (7 LLM calls). Batch=10 + planning concurrency=4 → ~4-5 min/batch, fits in the 8-min in-pipeline deadline + 20-min systemd hard kill. Vault/DB writes are then applied serially to avoid lost updates on shared topic/backlink pages. New topic proposals are reconciled against both existing topics and other new proposals in the same reviewer output, so near-duplicates collapse before page creation. Reviewer-approved related sources are rendered as source-page frontmatter (`related: [...]`) and a `## Related sources` wikilink section. The apply/metadata/commit block runs under a cross-process vault mutation lock shared with digest publishing.

### digest.ts

Implementation is split under `src/phases/digest/` (`context`, `load-articles`, `classify`, `draft`, `assemble`, `render-html`, `publish`). `src/phases/digest-phases.ts` remains a compatibility re-export surface.

```
loadContext         (pure)   read CLAUDE.md, TASTE.md, index, log tail, focuses, research/STATUS
loadArticles        (pure)   query ArticleStore by collected-on-{date}
prioritize          (LLM)    classify each article: focus / notable / followup / skip
draftSections       (LLM)    one writer per article-driven section
assemble            (pure)   format final markdown plus deterministic HTML email
appendLog           (pure)   record digest entry in vault/log.md
commitDigest        (pure)   local git commit
squashAndPush       (pure)   fetch → squash unpushed local commits → push to origin
emailSend           (pure)   gws gmail +send (--html when HTML body is available); throws on send failure
```

Email format: the digest keeps a Markdown/plain-text body for logs and fallback, but sends a deterministic HTML fragment when available. Article titles are rendered as embedded links to the original collected source URL; all article/model text is HTML-escaped in TypeScript, and the LLM is never asked to generate HTML.

Push strategy: many small local commits accumulate (librarian and digest both); the digest's `squashAndPush` rebase-squashes everything since the last push into one commit per push. Result on remote: ~2 commits/day max, each summarizing the work since the last push.

Digest email can be guarded with `CHIYA_DIGEST_ONCE_DAILY=1`: before sending, `digest.ts` checks persisted thread-phase job/event logs for a successful `email-send` event on the same local calendar date. `run-cycle.sh` and `chiya-daily.service` enable this guard by default to prevent duplicate emails from persistent timer catch-up or manual retries. Standalone AM/PM digest timers leave it unset so the existing twice-daily cadence can still send both emails.

## Crash recovery

Two mechanisms keep a crashed run from blocking everything that follows:

1. **`sweepStaleJobLock`** — runs before `acquireExclusive` in both librarian and digest. If a process died between acquire and `setCompleted`/`setFailed`, the lock row would sit `RUNNING` forever; the sweep flips any same-name `RUNNING` row older than the configured threshold to `FAILED`. Thresholds sit safely above each unit's `TimeoutStartSec` (librarian: 30m, digest: 25m).

2. **`reapStaleProcessing`** — first phase of every librarian run. Resets any `article.status='processing'` row older than 20 min back to `pending`. The librarian's `acquireExclusive` guarantees no concurrent runs, so we can't reap a live row by accident.

Both are tested in `__tests__/sweep-stale-job.test.ts` and `__tests__/article-store.test.ts`.

3. **`VaultMutationLock`** — wraps librarian apply/metadata/commit and digest append/commit/push using an atomic lock directory under the vault root. This prevents cross-service `log.md` and git races while still allowing the expensive agent planning/classification work to run outside the lock.
