# chiya-pipelines

Curation pipelines for the Chiya Library — TS, built on [`thread-phase`](https://github.com/Code4me2/thread-phase).

Replaces the prior Hermes-hosted prompts (`agents/librarian/prompt.md`, `agents/chiya-digest/prompt.md`) with composable typed phases that run as plain Node processes under systemd user timers.

## Status

| Pipeline | State |
|---|---|
| `digest` | implemented, smoke-tested |
| `librarian` | not yet (next) |

## Setup

```bash
cd ~/chiya-library/pipelines
npm install
npm run build
```

Inference defaults match the local vLLM + Hermes stack: `http://localhost:8000/v1`, model `qwen3.6-27b`. Override via `INFERENCE_BASE_URL` / `INFERENCE_MODEL` (see `thread-phase`'s `.env.example`).

## Running by hand

```bash
npm run digest:am      # tsx src/digest.ts AM
npm run digest:pm      # tsx src/digest.ts PM
```

Each run logs every event to stdout. Persisted job + event log goes to `$THREAD_PHASE_DB` (default: `<vault>/.chiya-pipelines.db`). Browse history with sqlite directly or via `thread-phase`'s `JobStore.getJob` / `getEvents`.

## systemd install

Versioned units live in `systemd/`. Install all four:

```bash
mkdir -p ~/.config/systemd/user
ln -sf ~/chiya-library/pipelines/systemd/chiya-intake.service     ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-intake.timer       ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-librarian.service  ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-librarian.timer    ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest@.service    ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest-am.timer    ~/.config/systemd/user/
ln -sf ~/chiya-library/pipelines/systemd/chiya-digest-pm.timer    ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now \
  chiya-intake.timer \
  chiya-librarian.timer \
  chiya-digest-am.timer \
  chiya-digest-pm.timer

systemctl --user list-timers chiya-*
```

Cadences:
- **intake** — every 4h at HH:03 (matches matcha collect cron + 3 min)
- **librarian** — every 10 min (DRAIN mode while the backlog catches up). Switch to every 30 min once `pending` is near zero by editing `chiya-librarian.timer` to `OnCalendar=*:0/30` and `daemon-reload && restart`.
- **digest** — 06:30 + 18:30 (AM/PM, Persistent=true catches up if the box was off)

Manual triggers:
```bash
systemctl --user start chiya-intake.service
systemctl --user start chiya-librarian.service
systemctl --user start chiya-digest@AM.service
journalctl --user -u 'chiya-librarian.service' -f
```

## Cutting over from Hermes

The Hermes chiya jobs were paused via `hermes cron pause <id>`. After a couple of clean cycles on systemd, leave them paused — keep them as a fast revert path. To delete entirely later: `hermes cron rm <id>`.

The Hermes `vault-daily-lint` job (midnight) is independent — leave active.

## Pipeline shape

```
digest.ts:
  loadContext       (pure)   read CLAUDE.md, TASTE, index, log tail, focuses, research/STATUS
  loadArticles      (pure)   parse raw/inbox/{date}-articles.md  (or raw/ fallback)
  prioritize        (LLM)    classify each article into focus/notable/followup/skip
  draftSections     (LLM)    one writer per article-driven section + pure code for library updates
  assemble          (pure)   format final markdown
  appendLog         (pure)   record digest entry in vault/log.md
  commitDigest      (pure)   local git commit
  squashAndPush     (pure)   fetch → squash unpushed → push to origin
  emailSend         (pure)   gws gmail +send
```

Push strategy: many small **local** commits accumulate (librarian and digest both); the digest's `squashAndPush` rebase-squashes everything since the last push into one commit per push. Result on remote: ~2 commits/day max, each summarizing the work since the last push.
