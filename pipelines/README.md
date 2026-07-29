# chiya-pipelines

Curation pipelines for the Chiya Library — TypeScript on
[`thread-phase`](https://github.com/autonome-research/thread-phase) v6
(owned, heartbeat-based job lifecycle). Multi-tenant: one SHARED pipeline
does the expensive per-article work once (absorb → enrich → summarize →
route); per-user librarian and digest pipelines iterate over enabled
tenants from `config/users.yaml`.

## Status

| Pipeline | State | Cadence |
|---|---|---|
| `shared` | live (routing mode: broadcast until the embedding service returns) | every 30 min |
| `librarian` | live, multi-tenant (router → scouts → reviewer → serial apply per user) | every 10 min |
| `digest` | live, multi-tenant | 06:30 / 18:30 local |
| `intake` | retired — absorbed into the shared pipeline | — |

511 tests, all green. `npm test`, `npm run build`.

## Setup

```bash
cd ~/chiya-library/pipelines
npm install
npm run build
```

### Required env

In multi-tenant mode (a `config/users.yaml` exists) per-user email, vault, and interests come from the tenant registry, and `CHIYA_UNPAYWALL_EMAIL` should be set so the OA enrichment rung works. `CHIYA_EMAIL_TO` is required only in legacy single-tenant mode. Everything else has defaults wired for the tiny-emerson vllm tunnel + the `~/chiya-data` layout. Put overrides in `pipelines/.env` (gitignored) — systemd loads via `EnvironmentFile=`.

| Var | Default | Notes |
|---|---|---|
| `VAULT_DIR` | `~/vault` | Vault repo root |
| `VAULT_REMOTE` | `origin` | Git remote to push to |
| `VAULT_BRANCH` | `main` | |
| `CHIYA_EMAIL_TO` | *(required in single-tenant mode)* | Digest delivery target; multi-tenant reads per-user email from users.yaml |
| `FAST_INFERENCE_BASE_URL` | `http://localhost:11435/v1` | Fast-tier OpenAI-compatible endpoint |
| `FAST_INFERENCE_MODEL` | `qwen36` | Digest classify/draft + librarian summary. No tools. |
| `TOOLS_INFERENCE_BASE_URL` | `http://localhost:11435/v1` | Tool-capable endpoint (same vllm on tiny-emerson:9000) |
| `TOOLS_INFERENCE_MODEL` | `qwen36` | Librarian router + scouts + reviewer. Verified to invoke `vault_read`/`vault_list`/etc. via OpenAI tool-call protocol. |
| `THREAD_PHASE_DB` | `<VAULT_DIR>/.chiya-pipelines.db` | Shared SQLite for both `article` and `job` tables |
| `CHIYA_FAST_MAX_TOKENS` | `4000` | Output-token cap for fast-tier digest classify/draft calls. Raised for reasoning models that otherwise spend the full cap on hidden reasoning and return `finishReason: length`. |
| `CHIYA_SOURCE_TIMEOUT_MS` | `15000` | Per-request timeout for TypeScript API source adapters |
| `CHIYA_SOURCE_RETRIES` | `1` | Retry count for retryable source HTTP failures (`408`, `429`, `5xx`) |
| `CHIYA_DATA_ROOT` | `~/chiya-data` | Multi-tenant layout root: `shared/` cache + `users/<handle>/vault` |
| `CHIYA_USERS_FILE` | `config/users.yaml` | Tenant registry (managed via `npm run admin`) |
| `CHIYA_SHARED_INBOX` | `<dataRoot>/shared/inbox` | Where matcha's `*-articles.md` land (live deploy uses `<dataRoot>/shared/raw/inbox` — matcha's collect.sh writes `$VAULT_DIR/raw/inbox`) |
| `CHIYA_UNPAYWALL_EMAIL` | unset | Contact email for Unpaywall OA lookups; the OA enrichment rung is skipped without it |
| `CHIYA_ROUTING_MODE` | `embedding` | `broadcast` = every quality-passing article to every user, no embeddings (current live mode) |
| `EMBED_INFERENCE_BASE_URL` | `http://localhost:11437/v1` | Embeddings endpoint (unused in broadcast mode) |

The default `localhost:11435` is the SSH tunnel installed via `chiya-tunnel-tiny.service` (forwards to tiny-emerson:9000 — the raw vllm. NOT :8000, which is a PI/Hermes wrapper whose chat template hardcodes its own tool surface and breaks scout tool calls).

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
npm run backfill-archive-articles -- --status=done     # recover dedup memory after DB loss
npm run backfill-archive-articles -- --status=pending  # re-queue archived resources for graph curation
```

Each pipeline run logs every event to stdout. Persisted job + event log lives in `$THREAD_PHASE_DB`. Inspect with sqlite directly or via thread-phase's `JobStore.getJob` / `getEvents`. `npm run doctor` exits nonzero only for failed checks; warnings cover optional/non-blocking issues such as skipped network checks or a dirty vault worktree.

## systemd install

```bash
mkdir -p ~/.config/systemd/user
ln -sf ~/chiya-library/pipelines/systemd/chiya-tunnel-tiny.service ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-shared.service      ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-shared.timer        ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-librarian.service   ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-librarian.timer     ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest@.service     ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest-am.timer     ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest-pm.timer     ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now \
  chiya-tunnel-tiny.service \
  chiya-shared.timer \
  chiya-librarian.timer \
  chiya-digest-am.timer \
  chiya-digest-pm.timer

systemctl --user list-timers chiya-*
```

Every pipeline service has `ExecStartPre=npm rebuild better-sqlite3` so a silent Node ABI bump can't break the DB binding. Roughly 1s when already-current, ~30s when actually rebuilding.

Legacy units still in `systemd/` but not installed: `chiya-intake.{service,timer}` (intake is retired — absorbed into the shared pipeline) and `chiya-embed.service` (kubectl port-forward for the embedding endpoint; only needed when `CHIYA_ROUTING_MODE=embedding` and the embed service is back).

Manual triggers:
```bash
systemctl --user start chiya-shared.service
systemctl --user start chiya-librarian.service
systemctl --user start chiya-digest@AM.service
journalctl --user -u chiya-librarian.service -f
```

## Pipeline shapes

### collection/api-ingest.ts

The live matcha collector calls the TypeScript API ingest from `matcha/scripts/collect.sh` before RSS filtering. `src/collection/api-ingest.ts` resolves the repository-local `matcha/` directory via `src/collection/paths.ts` and writes:

- `matcha/scripts/api-articles.jsonl`
- `matcha/scripts/api-digest.md`

`CHIYA_MATCHA_DIR` can override the computed `matcha/` path for tests or non-standard deployments. Registered API adapters now cover the legacy Python collector's active public endpoints: Semantic Scholar, OpenAlex, Crossref, arXiv, Zenodo, DOAJ, Europe PMC, INSPIRE-HEP, NCBI/PubMed, and OSF. Source HTTP calls use shared timeout/retry handling and report `health:elapsedMs` / `health:attempts` entries in `api-digest.md` source-health warnings.

### shared-pipeline.ts

One job per tick (`chiya-shared`, heartbeat-owned lock), doing the expensive per-article work once regardless of how many users are enabled:

```
scanSharedInbox     (pure)   read $CHIYA_SHARED_INBOX/*-articles.md
absorbInbox         (pure)   parse → upsert into SharedArticleStore (stable URL-hash IDs,
                              dedup, query labels) → archive processed files
enrichPending       (HTTP)   full text ladder: arXiv HTML → direct URL → Unpaywall OA
                              (pdftotext for PDFs). Retryable failures stay 'pending';
                              hard failures → 'enrich-failed' (abstract-only fallback)
summarizeEnriched   (LLM)    rich structured summary (methods / data / findings /
                              conclusions) + mandatory `## Assessment` block
                              (rigor 0-5, evidence 0-5, kind). Quality gate drops
                              kind announcement/other or rigor ≤ 1 → 'rejected-quality'
                              (fail-open: unparseable assessments pass through)
route               (mode)   CHIYA_ROUTING_MODE:
                              embedding — embed summaries, cosine-match against each
                                          user's interest paragraphs (threshold 0.43),
                                          full score matrix logged to routing_log
                              broadcast — every quality-passing article to every
                                          enabled user (current live mode)
                              matched articles are COPIED into each user's ArticleStore
                              (summary → snippet, refs columns, shared provenance)
```

Shared-cache article FSM: `pending → enriched | enrich-failed → summarized → (embedded →) routed | rejected-quality | failed`. Status transitions happen only after the work they record is durably complete, so a crash mid-tick resumes cleanly at the next one. Unresolved external references reported by per-user librarians accumulate in the shared `citation_demand` ledger (the trigger data for future demand-driven ingestion).

### intake.ts (retired)

The single-tenant intake (scan `vault/raw/inbox` → ArticleStore → archive) is absorbed into the shared pipeline's absorb phase. `npm run intake` and the code remain for legacy single-tenant deployments, but the live system does not run it. Its recovery script is still current: if a per-user ArticleStore is lost/reset while raw inbox archives remain, recover dedup memory with `npm run backfill-archive-articles -- --status=done`, or re-queue archived resources for graph curation with `-- --status=pending`.

### librarian.ts

Multi-tenant: `main` iterates enabled users from `config/users.yaml` (or falls back to the legacy single-tenant env when no users file exists), each under its own job lock (`chiya-librarian:<handle>`) against its own vault + DB. One tenant failing doesn't block the others; `--user <handle>` restricts a run to one tenant.

```
reapStale           (pure)   reset stuck 'processing' rows (> 20 min) back to pending
loadBatch           (pure)   pull up to N pending rows, mark as processing
                              (--dry-run leaves rows pending)
planArticleTree     (LLM)    per-article fan-out, concurrency=4, no writes:
                              ├── router          (1 call, no tools)
                              ├── topic-scout     (vault_read, vault_list, vault_search)
                              ├── source-scout    (+ article_search_by_title)
                              ├── entity-scout    (vault tools)
                              ├── cite-tracker    (+ article_lookup_by_arxiv/doi)
                              └── reviewer        (synthesizes the 4 scouts, vault_read)
applyArticlePlans   (pure)   serial revalidation + deterministic writes
                              source page + topic touches + cite/entity backlinks + related source edges + ArticleStore status
                              (--dry-run revalidates and reports would-write/would-skip/would-fail without writes)
mergeMetadata       (pure)   append per-article entries to vault/log.md
commitLocal         (pure)   single git commit per run (no push — digest pushes)
```

Enrichment, reference extraction, and summarization all happen upstream in the shared pipeline: the article body the planner sees IS the pre-computed rich summary (`snippet` column), and refs arrive in dedicated columns (regex fallback only for legacy rows). Per-article planning wall: ~40-70s (6 LLM calls). Batch=10 + planning concurrency=4 fits in the 8-min in-pipeline deadline + 20-min systemd hard kill. Vault/DB writes are then applied serially to avoid lost updates on shared topic/backlink pages. New topic proposals are reconciled against both existing topics and other new proposals in the same reviewer output, so near-duplicates collapse before page creation. Reviewer-approved related sources are rendered as source-page frontmatter (`related: [...]`) and a `## Related sources` wikilink section. Unresolved cites render as `## External references` (cap 10) on the source page and are recorded in the shared citation-demand ledger only after the source page is durably written. The apply/metadata/commit block runs under a cross-process vault mutation lock shared with digest publishing.

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

Email format: the digest keeps a Markdown/plain-text body for logs and fallback, but sends a deterministic HTML fragment when available. Article titles are rendered as embedded links to the original collected source URL; all article/model text is HTML-escaped in TypeScript, and the LLM is never asked to generate HTML. OSF API preprint URLs are converted to human-readable `https://osf.io/<slug>` links, and Zenodo bare record IDs are converted to `https://zenodo.org/records/<id>` before rendering/backfill storage.

Push strategy: many small local commits accumulate (librarian and digest both); the digest's `squashAndPush` rebase-squashes everything since the last push into one commit per push. Result on remote: ~2 commits/day max, each summarizing the work since the last push.

## Crash recovery

Four mechanisms keep a crashed run from blocking everything that follows:

1. **Heartbeat job ownership (thread-phase v6)** — every runner is constructed with `heartbeatMs: 30_000` and calls `runner.reconcileAbandoned(5 * 60 * 1000)` before `acquireExclusive`. A running job's owner refreshes its heartbeat every 30s; if the process dies, the heartbeat goes stale and the next run reconciles the job as abandoned before acquiring the lock. This replaced the old wall-clock `sweepStaleJobLock` (deleted with the v6 upgrade) — no threshold tuning against systemd timeouts needed.

2. **`reapStaleProcessing`** — first phase of every librarian run. Resets any `article.status='processing'` row older than 20 min back to `pending`. The librarian's `acquireExclusive` guarantees no concurrent runs per tenant, so we can't reap a live row by accident. Tested in `__tests__/article-store.test.ts`.

3. **`VaultMutationLock`** — wraps librarian apply/metadata/commit and digest append/commit/push using an atomic lock directory under the vault root. This prevents cross-service `log.md` and git races while still allowing the expensive agent planning/classification work to run outside the lock. Tested in `__tests__/vault-mutation-lock.test.ts`.

4. **`backfill-archive-articles`** — restores ArticleStore rows from `raw/inbox/archive/*-articles.md` after DB loss/reset. Use `--status=done` for dedup-memory recovery without graph work, or `--status=pending` when archived resources should be curated into the graph. The script preserves the original archive date from the filename so old resources do not masquerade as today's collection.
