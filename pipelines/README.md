# chiya-pipelines

> **Live-operator runbook.** This file documents the Autonome Research
> deployment: host `tiny-emerson`, vllm ports (`localhost:11435` SSH tunnel
> to `tiny-emerson:9000`, **not** `:8000`), `chiya-tunnel-tiny.service`,
> and examples such as `npx tsx src/lint.ts --user velvet`. It is **not**
> the public Quick Start. Strangers should start at the
> [root README](../README.md). Do not treat tiny-emerson or `--user velvet`
> as the default for a fresh install.

Curation pipelines for the Chiya Library — TypeScript on
[`thread-phase`](https://github.com/autonome-research/thread-phase) v6
(owned, heartbeat-based job lifecycle). Multi-tenant: one SHARED pipeline
does the expensive per-article work once (absorb → enrich → summarize →
route); per-user librarian and digest pipelines iterate over enabled
tenants from `config/users.yaml`.

## Public setup vs this runbook

| Audience | Start here |
|---|---|
| New clone / public try-out | Root [`README.md`](../README.md) Quick Start |
| Operators of the live Chiya machine | This file: env table, systemd units |

Env defaults below are for the live machine. A public install should set
`pipelines/.env` (gitignored) to a reachable OpenAI-compatible endpoint
and skip `chiya-tunnel-tiny.service` unless you are on that host.

## Status

| Pipeline | State | Cadence |
|---|---|---|
| `shared` | live (routing mode: broadcast until the embedding service returns) | every 30 min |
| `librarian` | live, multi-tenant (router → scouts → reviewer → serial apply per user) | every 10 min |
| `lint` | multi-tenant, deterministic (resolve external refs, regenerate derived views, recount citations, report structure). Units written, **not yet enabled** | daily 00:15 local |
| `digest` | live, multi-tenant | 06:30 / 18:30 local |
| `demand-ingest` | standalone daily job (citation demand ledger → shared inbox). Units written, **not yet enabled** | daily 05:10 local |
| `intake` | retired — absorbed into the shared pipeline | — |

Failure alerting: `chiya-shared`, `chiya-librarian`, `chiya-lint`, `chiya-digest@` and
`chiya-demand` all carry `OnFailure=chiya-alert@%n.service`, which emails the operator
the failed unit's last 30 journal lines. `chiya-alert@` deliberately has no `OnFailure=`
of its own and `scripts/alert-failure.sh` exits 0 on every path — an alerter that can
fail is an alerter that needs an alerter.

`npm test`, `npm run build`. The full suite is the merge gate.

## Setup (live checkout)

On the operator machine the checkout is `~/chiya-library`. A public clone can use any path; systemd units below assume that live layout.

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
| `CHIYA_CONTACT_EMAIL` | falls back to `CHIYA_UNPAYWALL_EMAIL` | Contact address for the arXiv/Crossref polite pools used by `demand-ingest`. Unset = anonymous pools + a WARN line |
| `CHIYA_ALERT_EMAIL` | falls back to `CHIYA_EMAIL_TO` | Where `chiya-alert@` mails unit failures. With neither set the alerter logs to the journal and exits 0 |
| `CHIYA_ROUTING_MODE` | `embedding` | `broadcast` = every quality-passing article to every user, no embeddings (current live mode) |
| `EMBED_INFERENCE_BASE_URL` | `http://localhost:11437/v1` | Embeddings endpoint (unused in broadcast mode) |

The default `localhost:11435` is the SSH tunnel installed via `chiya-tunnel-tiny.service` (forwards to tiny-emerson:9000 — the raw vllm. NOT :8000, which is a PI/Hermes wrapper whose chat template hardcodes its own tool surface and breaks scout tool calls).

## Running by hand

```bash
set -a && source .env && set +a   # systemd loads this automatically

npm run doctor -- --no-network    # validate env/vault/db/git without inference HTTP checks
npm run doctor:offline            # same thing, cron/pre-deploy friendly
npm run budgets                   # effective agent output-token caps + which are env-overridden
npm run status                    # article status counts + recent jobs
npm run intake                    # tsx src/intake.ts
npm run librarian                 # tsx src/librarian.ts
npm run librarian -- --dry-run    # calls agents + previews apply; no vault/git/article status mutation
npm run librarian -- --plan-only  # stops after semantic article plans; no apply preview
npx tsx src/lint.ts               # deterministic vault reorganization pass (all enabled users)
npx tsx src/lint.ts --user velvet --dry-run   # reports every would-write; no vault/git mutation
npm run digest:am                 # tsx src/digest.ts AM
npm run digest:pm                 # tsx src/digest.ts PM
npm run backfill-archive-articles -- --status=done     # recover dedup memory after DB loss
npm run backfill-archive-articles -- --status=pending  # re-queue archived resources for graph curation

npm run demand-ingest -- --dry-run          # what the ledger wants; no network, no writes
npm run demand-ingest -- --limit=5          # resolve + emit one inbox file (capped first run)
npm run backfill-clusters-llm -- --user velvet --limit 60   # LLM cluster proposals, dry run
npm run backfill-clusters-llm -- --user velvet --execute    # write clusters: frontmatter
npm run fix-extensionless-pages -- --user velvet            # extensionless page audit, dry run
npm run fix-extensionless-pages -- --user velvet --execute  # rename/dedupe them
```

The last three are operator one-shots, not scheduled jobs: each defaults to a dry run,
prints a one-line JSON summary, and never touches git.

Each pipeline run logs every event to stdout. Persisted job + event log lives in `$THREAD_PHASE_DB`. Inspect with sqlite directly or via thread-phase's `JobStore.getJob` / `getEvents`. `npm run doctor` exits nonzero only for failed checks; warnings cover optional/non-blocking issues such as skipped network checks or a dirty vault worktree.

### What doctor checks

| Check | Network? | What it catches |
| --- | --- | --- |
| `email`, `vault`, `git`, `db` | no | Unset `CHIYA_EMAIL_TO`, missing vault, non-repo, missing/half-built pipeline DB |
| `truncation` | no | **Silent degradation.** Reads the JobStore `event` log and `article.status_reason` and reports each agent's truncation rate. WARN at 10%, FAIL at 35%, no escalation below 10 units. The window is **per agent** (each agent's most recent 40 runs) — a global row window is ~99% librarian and hides the twice-daily digest entirely |
| `budgets` | no | Prints every effective agent output-token cap; WARNs if any is env-overridden, since an override outlives the reason for it |
| `fast-inference`, `tools-inference`, `tools-model` | yes | Endpoint reachable, and the configured model id is actually one the endpoint serves |
| `tool-calling` | yes | A real tool-call round trip. A 200 answering in **prose** is a FAIL — that is the :8000 wrapper failure mode that made scouts confabulate for a week |
| `vision` | yes | Multimodality, probed with a generated 64x64 PNG. INFO either way. Deliberately not a 1x1 pixel: that crashed the VL preprocessor once and the crash was recorded as "model is not multimodal" |

`truncation` and `budgets` are two halves of one question — *is an agent hitting its ceiling, and what is that ceiling?* — so they run together and both work offline. Silent degradation does not need a network to happen.

### Agent output-token budgets

Every `maxTokens` in the pipelines lives in `src/shared/agent-budgets.ts`, one named export per agent role, each with a `CHIYA_<ROLE>_MAX_TOKENS` override, a floor, and a comment saying why the number holds and what would invalidate it. `__tests__/agent-budgets.test.ts` fails the build if a numeric `maxTokens` literal reappears at any call site, or if a new file calls `runAgentWithTools` without importing a budget. Run `npm run budgets` to see the effective values, or `npm run test:guards` for the check alone (~15ms). **Re-read that module whenever the inference target changes** — a reasoning model spends the front of its budget on a hidden pass, which is how the digest ran for weeks on caps sized for a non-reasoning model. See `docs/developer-guide.md` for how to add one.

## systemd install

```bash
mkdir -p ~/.config/systemd/user
ln -sf ~/chiya-library/pipelines/systemd/chiya-tunnel-tiny.service ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-shared.service      ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-shared.timer        ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-librarian.service   ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-librarian.timer     ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-lint.service        ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-lint.timer          ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest@.service     ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest-am.timer     ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest-pm.timer     ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-alert@.service      ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-demand.service      ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-demand.timer        ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now \
  chiya-tunnel-tiny.service \
  chiya-shared.timer \
  chiya-librarian.timer \
  chiya-digest-am.timer \
  chiya-digest-pm.timer

systemctl --user list-timers chiya-*
```

`chiya-lint.timer` is deliberately left out of that `enable --now` list: the first
apply run stamps `cited_by:` onto ~21.8k legacy source pages in one commit, so it
should be run by hand (after `--dry-run`) before the timer takes over. Enable it with
`systemctl --user enable --now chiya-lint.timer` once that has happened. Its
`TimeoutStartSec=5400` is sized for that one-off; steady-state runs are ~12s and write
nothing.

`chiya-demand.timer` is likewise left out: run `npm run demand-ingest -- --dry-run` and
then a capped `-- --limit=5` by hand before enabling it, since the first unthrottled run
emits ~25 papers into the shared inbox at once. `chiya-alert@.service` is a template —
never enabled, only started by the other units' `OnFailure=`. Verify the wiring with
`systemctl --user show chiya-lint.service -p OnFailure` and smoke-test it with
`systemctl --user start chiya-alert@chiya-lint.service`.

Every pipeline service has `ExecStartPre=npm rebuild better-sqlite3` so a silent Node ABI bump can't break the DB binding. Roughly 1s when already-current, ~30s when actually rebuilding.

Legacy units still in `systemd/` but not installed: `chiya-intake.{service,timer}` (intake is retired — absorbed into the shared pipeline) and `chiya-embed.service` (kubectl port-forward for the embedding endpoint; only needed when `CHIYA_ROUTING_MODE=embedding` and the embed service is back).

Manual triggers:
```bash
systemctl --user start chiya-shared.service
systemctl --user start chiya-librarian.service
systemctl --user start chiya-lint.service
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

### demand-ingest.ts

Tier-3 citation ingestion: the one place the *vault* gets to ask for an article instead
of the collector. Deliberately **not** a thread-phase pipeline — no vault, no git, no
LLM, no per-user state, no job lock. One shape, one artifact:

```
unsatisfiedCitationDemand  (SQL)   citation_demand → aggregate across ALL users by
                                    DISTINCT citing article → map each ref to the stable
                                    id it would occupy (merging '2301.03728' with
                                    '2301.03728v2') → keep ≥ --min-citers → drop refs
                                    whose stable id already exists → then --limit
resolveDemandRefs          (HTTP)  arXiv Atom, batched ~20 ids/request with an explicit
                                    max_results; Crossref one DOI at a time. ~1 req/s,
                                    15s timeout, 429/5xx retryable, everything else a
                                    counted reason. Nothing throws per ref
renderDemandArticles       (pure)  ONE <date>-demand-articles.md into $CHIYA_SHARED_INBOX
                                    in the exact matcha format parseArticles reads
```

Satisfaction is **computed, never stored**: a ref is satisfied when `stableIdForUrl` of
its canonical URL (`https://arxiv.org/abs/<id>` / `https://doi.org/<doi>`) already has a
`shared_article` row. Those are the same two URL forms `librarian-apply` writes into
`## External references`, and the same helper `lint`'s `resolve-external-refs` maps them
back with — one mapping, three call sites, no forks. It is also why the emitted article
dedups against a copy that later arrives through normal collection rather than creating a
second page.

From there the shared pipeline owns everything: absorb dedups, enrich fetches full text,
the quality gate can still reject the paper, routing distributes it. Because the only
side effect is that additive inbox file, the job defaults to **executing**; `--dry-run`
stops before metadata resolution, so it is offline and free. Flags: `--min-citers=N`
(3), `--limit=N` (25), `--user=<handle>`, `--dry-run`. Re-running the same day overwrites
the file, which is safe — anything in the earlier write is still unsatisfied and is
recomputed. Run summary:
`[demand] eligible=.. satisfied-skipped=.. unmapped=.. considered=.. resolved=.. emitted=.. failed=..`.

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

Enrichment, reference extraction, and summarization all happen upstream in the shared pipeline: the article body the planner sees IS the pre-computed rich summary (`snippet` column), and refs arrive in dedicated columns (regex fallback only for legacy rows). Per-article planning wall: ~40-70s (6 LLM calls). Batch=10 + planning concurrency=4 fits in the 8-min in-pipeline deadline + 20-min systemd hard kill. Vault/DB writes are then applied serially to avoid lost updates on shared topic/backlink pages. Each run loads the vault's topic vocabulary once — the lint pipeline's `registry.json` when present, else a live `scanTopicRegistry` — and appends a cluster-grouped, char-budgeted slug block to the topic-scout (2000 chars) and reviewer (6000 chars) system prompts, so the reviewer assigns topics against a vocabulary it can actually see rather than inventing slugs that fall through to `uncategorized`. New topic proposals are reconciled against both existing topics and other new proposals in the same reviewer output, so near-duplicates collapse before page creation; a proposed slug that is a typo or plural variant of a real one is snapped onto the real one instead of being dropped. New topic pages are born with the reviewer's `clusters:` frontmatter, and reviewer-approved entities are upserted into `wiki/entities/` (created on first mention, appended idempotently after). Reviewer-approved related sources are rendered as source-page frontmatter (`related: [...]`) and a `## Related sources` wikilink section. Unresolved cites render as `## External references` (cap 10) on the source page and are recorded in the shared citation-demand ledger only after the source page is durably written. The apply/metadata/commit block runs under a cross-process vault mutation lock shared with digest publishing.

### lint.ts

The vault's "organize" organ. Multi-tenant, same shape as `librarian.ts`: one sequential run per enabled user, each under its own job lock (`chiya-lint:<handle>`), `--user <handle>` (or `--user=<handle>`) restricts to one tenant, one tenant's failure never blocks the fleet. **Every pass is deterministic — no LLM is contacted anywhere in this pipeline**, so it runs regardless of whether the inference tunnel is up. Judgment-driven cleanup (merges, deletions, archiving) is a later phase and will still land as agent proposals for deterministic code to dispose of.

```
scanVault           (pure)   one walk of wiki/sources + wiki/topics + wiki/entities into
                              LintCtx: frontmatter, wikilinks, member lists, cite in-degree.
                              The only reader of page bodies; every later pass works off ctx
resolveExternalRefs (pure)   `## External references` entries whose paper has since landed
                              migrate into `## Cited references in this library` + `cites:`,
                              the target gains a `## Cited by` bullet, and ctx is updated in
                              place so the passes below see the new edges without a rescan
regenRegistry       (pure)   wiki/topics/_registry.md (human) + registry.json (machine —
                              this is the vocabulary the librarian's agents read)
recountCitations    (pure)   cited_by: ← inbound `cites:` edges, one frontmatter line
                              rewritten in place; rest of the page byte-for-byte identical
rankTopicMembers    (pure)   `## Member sources` re-sorted by (cited_by desc, collected desc)
                              into the exact line slots it occupied
regenIndex          (pure)   index.md as a NAVIGATION surface (clusters → top topics, other
                              page families, recent sources, stats) — never a 21.8k-page catalog
exportGraph         (pure)   graph.json: nodes (source/topic/entity/cluster) + edges
                              (member/cites/related/mentions) for the visualization tool
reportLint          (pure)   broken links / orphan sources / stub topics / near-duplicate
                              topic slugs. REPORT ONLY — summary line to log.md, full lists
                              on the event stream (capped at 2000 items/category)
commitLint          (pure)   one commit per run, pathspecs filtered to what exists
```

`resolveExternalRefs` runs FIRST among the mutating passes, and the ordering is
load-bearing: before `regenRegistry` so `registry.json`'s `citedByTotal` carries this
run's new edges, before `recountCitations` so they land in `cited_by`, before
`rankTopicMembers` so member lists already reflect the new importance, before
`exportGraph` so `graph.json` is not a day stale. It is the closing half of demand-driven
ingestion — fetching a demanded paper is pointless if it arrives disconnected from the
pages that asked for it. Refusal over repair: a `## External references` section or a
`cites:` key that is not the shape the writers emit freezes the page (skipped, counted,
reported as `lint-unparseable-external-refs`), and a ref URL that is neither arXiv nor
DOI has no stable identity to match on, so it stays external. A paper's own arXiv
DataCite DOI (`10.48550/arxiv.<own id>`) is rejected in both directions — 109 of velvet's
1,631 live external entries are exactly that, and resolving one would draw a citation
edge from a paper to itself.

Every write goes through `planWrite`, which content-compares first: a run over an unchanged vault produces zero writes and `commitLint` short-circuits before touching git, so a daily timer cannot churn history or mtimes. `scanVault` is read-only and runs outside the lock; the eight mutating passes (plus `log.md` and the commit) run inside `VaultMutationLock`. `--dry-run` reports every would-write and the full report without touching the vault, log.md, or git — and skips the lock, since it writes nothing. Live measurements on the 21.9k-source velvet vault: full pipeline ~12s, of which the scan is 0.3s and a worst-case (every page stale) recount is 11s; `ctx.heartbeat()` fires every 500 files inside the scan and recount loops so long runs are not reclaimed as abandoned.

The first apply run is the expensive one: ~21.8k legacy source pages have no `cited_by:` key at all and each gains one, in a single commit. Run `--dry-run` first.

### digest.ts

Implementation is split under `src/phases/digest/` (`context`, `load-articles`, `classify`, `draft`, `assemble`, `render-html`, `publish`). `src/phases/digest-phases.ts` remains a compatibility re-export surface.

```
loadContext         (pure)   read CLAUDE.md, TASTE.md, index, log tail, focuses, research/STATUS
loadArticles        (pure)   query ArticleStore by collected-on-{date}, `digested_at IS NULL`
prioritize          (LLM)    classify each article: focus / notable / followup / skip
draftSections       (LLM)    one writer per article-driven section
assemble            (pure)   format final markdown plus deterministic HTML email
appendLog           (pure)   record digest entry in vault/log.md
commitDigest        (pure)   local git commit
squashAndPush       (pure)   fetch → squash unpushed local commits → push to origin
emailSend           (pure)   gws gmail +send (--html when HTML body is available); throws on
                              send failure, then stamps digested_at on what it just mailed
```

AM/PM dedup: `digested_at` (additive-nullable column, lands on the next DB open) is what
makes the two runs different rather than the same run twice. `load-articles` takes only
undigested rows inside the existing local-day window — the 3-day fallback too — and
`email-send` stamps exactly the rows it loaded, **after** the `!result.ok` throw, so a
failed send leaves everything eligible for the next firing. Skips are stamped as well: a
`skip` verdict consumed the article just as much as a highlight did. `appendLog`'s
once-daily `[date] direction` marker is untouched and still idempotent per run.

Email format: the digest keeps a Markdown/plain-text body for logs and fallback, but sends a deterministic HTML fragment when available. Article titles are rendered as embedded links to the original collected source URL; all article/model text is HTML-escaped in TypeScript, and the LLM is never asked to generate HTML. OSF API preprint URLs are converted to human-readable `https://osf.io/<slug>` links, and Zenodo bare record IDs are converted to `https://zenodo.org/records/<id>` before rendering/backfill storage.

Push strategy: many small local commits accumulate (librarian and digest both); the digest's `squashAndPush` rebase-squashes everything since the last push into one commit per push. Result on remote: ~2 commits/day max, each summarizing the work since the last push.

## Crash recovery

Four mechanisms keep a crashed run from blocking everything that follows:

1. **Heartbeat job ownership (thread-phase v6)** — every runner is constructed with `heartbeatMs: 30_000` and calls `runner.reconcileAbandoned(5 * 60 * 1000)` before `acquireExclusive`. A running job's owner refreshes its heartbeat every 30s; if the process dies, the heartbeat goes stale and the next run reconciles the job as abandoned before acquiring the lock. This replaced the old wall-clock `sweepStaleJobLock` (deleted with the v6 upgrade) — no threshold tuning against systemd timeouts needed.

2. **`reapStaleProcessing`** — first phase of every librarian run. Resets any `article.status='processing'` row older than 20 min back to `pending`. The librarian's `acquireExclusive` guarantees no concurrent runs per tenant, so we can't reap a live row by accident. Tested in `__tests__/article-store.test.ts`.

3. **`VaultMutationLock`** — wraps librarian apply/metadata/commit and digest append/commit/push using an atomic lock directory under the vault root. This prevents cross-service `log.md` and git races while still allowing the expensive agent planning/classification work to run outside the lock. Tested in `__tests__/vault-mutation-lock.test.ts`.

4. **`backfill-archive-articles`** — restores ArticleStore rows from `raw/inbox/archive/*-articles.md` after DB loss/reset. Use `--status=done` for dedup-memory recovery without graph work, or `--status=pending` when archived resources should be curated into the graph. The script preserves the original archive date from the filename so old resources do not masquerade as today's collection.
