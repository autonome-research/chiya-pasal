# Chiya Cron Configuration

## Linux Cron (collection, every 4h)
```
0 */4 * * * VAULT_DIR=/home/velvet/vault /home/velvet/chiya-library/matcha/scripts/collect.sh >> /home/velvet/chiya-library/matcha/logs/cron.log 2>&1
```

Collection runs: ~00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC

## Hermes Cron (curation, daily 6:30 PM PT)
Schedule: `30 0 * * *` (00:30 UTC = 6:30 PM PDT / 7:30 PM PST)

Steps:
1. Load librarian + digest agent prompts
2. Librarian processes raw articles into wiki
3. Digest agent curates and delivers daily digest

## Patch Live Hermes Jobs

Hermes stores live cron jobs in `~/.hermes/cron/jobs.json`, outside this repo.
After changing repo prompts, run:

```
python3 /home/velvet/chiya-library/cron/patch-hermes-jobs.py
```

This updates:
- `chiya-digest-email-am` (`be39e91f36ca`)
- `chiya-digest-email-pm` (`a4171d9d9cdd`)
- `chiya-librarian-ingest` (`c49e549771ee`)
