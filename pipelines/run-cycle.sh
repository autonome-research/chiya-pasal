#!/usr/bin/env bash
# Chiya daily full-cycle runner.
#
# One invocation performs the whole user-facing daily flow:
#   collect → intake → librarian graph updates → digest email
# It is safe to run from a Persistent=true systemd timer: collection/intake are
# deduped, the librarian is batch/lock protected, and digest email delivery is
# guarded in TypeScript so a day is not mailed twice unless explicitly forced.

set -Eeuo pipefail

DIRECTION="${1:-AM}"
if [[ "$DIRECTION" != "AM" && "$DIRECTION" != "PM" ]]; then
  echo "Usage: $0 {AM|PM}" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MATCHA_DIR="$REPO_DIR/matcha"

# Load local deployment config for manual runs. systemd also sets/loads these,
# but sourcing here keeps this script self-contained when invoked by hand.
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

export VAULT_DIR="${VAULT_DIR:-$HOME/vault}"
export THREAD_PHASE_DB="${THREAD_PHASE_DB:-$VAULT_DIR/.chiya-pipelines.db}"
export CHIYA_DIGEST_ONCE_DAILY="${CHIYA_DIGEST_ONCE_DAILY:-1}"

LOCK_FILE="${CHIYA_CYCLE_LOCK_FILE:-$SCRIPT_DIR/.chiya-cycle.lock}"
LIBRARIAN_BATCH="${CHIYA_CYCLE_LIBRARIAN_BATCH:-10}"
LIBRARIAN_MINUTES="${CHIYA_CYCLE_LIBRARIAN_MINUTES:-8}"
LIBRARIAN_MAX_PASSES="${CHIYA_CYCLE_LIBRARIAN_PASSES:-5}"

exec 201>"$LOCK_FILE"
if ! flock -n 201; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] chiya-cycle($DIRECTION): another cycle is already running — skipping"
  exit 0
fi

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] chiya-cycle($DIRECTION): $*"
}

pending_count() {
  DB_PATH="$THREAD_PHASE_DB" node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.env.DB_PATH);
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM article WHERE status = ?").get("pending");
      console.log(row ? row.n : 0);
    } catch (err) {
      // The table may not exist before first intake; treat as empty.
      console.log(0);
    } finally {
      db.close();
    }
  '
}

on_error() {
  local rc=$?
  log "failed at line $1 (exit $rc)"
  exit "$rc"
}
trap 'on_error $LINENO' ERR

cd "$SCRIPT_DIR"
log "starting daily full cycle vault=$VAULT_DIR db=$THREAD_PHASE_DB"

log "STEP 1/4 collect → raw inbox"
"$MATCHA_DIR/scripts/collect.sh"

log "STEP 2/4 intake → ArticleStore"
npm run intake

log "STEP 3/4 librarian graph update drain, max_passes=$LIBRARIAN_MAX_PASSES"
for ((pass = 1; pass <= LIBRARIAN_MAX_PASSES; pass++)); do
  pending="$(pending_count | tr -d '[:space:]')"
  log "  pending=$pending (pass $pass)"
  if [[ "$pending" == "0" ]]; then
    break
  fi
  npx tsx src/librarian.ts --batch="$LIBRARIAN_BATCH" --minutes="$LIBRARIAN_MINUTES"
done

remaining="$(pending_count | tr -d '[:space:]')"
if [[ "$remaining" != "0" ]]; then
  log "  leaving pending=$remaining for next run after max_passes=$LIBRARIAN_MAX_PASSES"
fi

log "STEP 4/4 digest + guarded email"
if [[ "$DIRECTION" == "PM" ]]; then
  npm run digest:pm
else
  npm run digest:am
fi

log "cycle done"
