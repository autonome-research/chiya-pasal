# Chiya Cron Configuration

## Linux Cron (collection, every 4h)
```
0 */4 * * * /home/velvet/matcha/scripts/collect.sh >> /home/velvet/matcha/logs/cron.log 2>&1
```

Collection runs: ~00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC

## Hermes Cron (curation, daily 6:30 PM PT)
Schedule: `30 0 * * *` (00:30 UTC = 6:30 PM PDT / 7:30 PM PST)

Steps:
1. Load librarian + digest agent prompts
2. Librarian processes raw articles into wiki
3. Digest agent curates and delivers daily digest

