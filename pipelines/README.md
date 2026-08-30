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

