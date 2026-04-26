#!/usr/bin/env python3
"""Patch live Hermes cron jobs for the Chiya Library.

This updates jobs stored in ~/.hermes/cron/jobs.json:
- chiya-digest-email-am / chiya-digest-email-pm get terminal/file/email tools
  and an explicit terminal-send prompt.
- chiya-librarian-ingest is synced to agents/librarian/prompt.md so the live
  job uses the continuous pump prompt from this repo.
"""
import json
import os
from datetime import datetime
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
JOBS_PATH = Path(os.path.expanduser("~/.hermes/cron/jobs.json"))

EMAIL_PROMPT = """You have the latest chiya digest from the script output below.

Your ONLY task is to send it as an email. You MUST execute the terminal command to send it.

Steps:
1. Extract the digest content from the script output above
2. Run this terminal command, replacing the body with the actual digest:

   gws gmail +send --to velvetmoon222999@gmail.com --subject "🍵 Chiya Daily Digest — YYYY-MM-DD ({direction})" --body "$(cat /tmp/chiya-digest-body.txt)"

   First write the digest body to /tmp/chiya-digest-body.txt, then run the gws command.

3. Verify the command succeeded (exit code 0, JSON response with "id" field)

If the script output is empty, says "FAILED", or reports no digest found, reply with [SILENT].

IMPORTANT: You MUST use the terminal() tool to execute gws gmail +send. Simply writing the email content as text will NOT send it."""


def main() -> int:
    if not JOBS_PATH.exists():
        raise SystemExit(f"Missing Hermes jobs file: {JOBS_PATH}")

    data = json.loads(JOBS_PATH.read_text(encoding="utf-8"))
    librarian_prompt = (REPO_ROOT / "agents" / "librarian" / "prompt.md").read_text(encoding="utf-8")

    updates = {
        "be39e91f36ca": {
            "prompt": EMAIL_PROMPT.format(direction="AM"),
            "enabled_toolsets": ["terminal", "file", "email"],
        },
        "a4171d9d9cdd": {
            "prompt": EMAIL_PROMPT.format(direction="PM"),
            "enabled_toolsets": ["terminal", "file", "email"],
        },
        "c49e549771ee": {
            "prompt": librarian_prompt,
            "enabled_toolsets": ["file", "terminal", "delegation"],
        },
    }

    seen = set()
    for job in data.get("jobs", []):
        patch = updates.get(job.get("id"))
        if not patch:
            continue
        job.update(patch)
        seen.add(job["id"])

    missing = sorted(set(updates) - seen)
    if missing:
        raise SystemExit(f"Missing expected job IDs: {', '.join(missing)}")

    backup = JOBS_PATH.with_suffix(f".json.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
    backup.write_text(JOBS_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    data["updated_at"] = datetime.now().astimezone().isoformat()
    JOBS_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Patched Hermes jobs: {', '.join(sorted(seen))}")
    print(f"Backup written: {backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
