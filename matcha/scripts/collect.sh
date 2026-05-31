#!/bin/bash
# collect.sh — Matcha collection orchestrator
# Runs: TypeScript API ingest → matcha RSS → filter/dedup → VAULT_DIR/raw/inbox/YYYY-MM-DD-articles.md
# Triggered by Linux cron every 4 hours
#
# VAULT_DIR env var points to the target vault (default: ~/vault)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MATCHA_DIR="$(dirname "$SCRIPT_DIR")"
VAULT_DIR="${VAULT_DIR:-$HOME/vault}"
export VAULT_DIR
LOG_DIR="${MATCHA_DIR}/logs"
LOCK_FILE="${MATCHA_DIR}/collect.lock"
TODAY=$(date +%Y-%m-%d)
LOG="${LOG_DIR}/collect-${TODAY}.log"

mkdir -p "$LOG_DIR"

# Prevent concurrent runs
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Another collect.sh is already running — skipping" >> "$LOG"
    exit 0
fi

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

queue_health() {
    local queue_dir="$VAULT_DIR/raw/inbox/queue"
    local seen_file="${SEEN_TITLES_PATH:-$HOME/.seen-titles}"
    local stats
    if [ ! -d "$queue_dir" ]; then
        log "[queue] queue_dir=$queue_dir missing"
        return
    fi
    stats=$(find "$queue_dir" -maxdepth 1 -type f -name '*.md' -printf '%s\n' | awk '
        {n++; bytes += $1; if ($1 < 300) lt300++; if ($1 < 500) lt500++; if ($1 < 1000) lt1000++}
        END {printf "files=%d bytes=%d lt300=%d lt500=%d lt1000=%d", n+0, bytes+0, lt300+0, lt500+0, lt1000+0}
    ')
    local skip_count=0
    local seen_count=0
    if [ -d "$queue_dir/skip" ]; then
        skip_count=$(find "$queue_dir/skip" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')
    fi
    if [ -f "$seen_file" ]; then
        seen_count=$(wc -l < "$seen_file" | tr -d ' ')
    fi
    log "[queue] $stats skip=$skip_count seen_titles=$seen_count"
}

on_error() {
    local exit_code=$?
    log "[error] Collection cycle failed at line $1 (exit $exit_code)"
    exit "$exit_code"
}
trap 'on_error $LINENO' ERR

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "Matcha Collection — $TODAY (vault: $VAULT_DIR)"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
queue_health

# Step 1: API ingestion
log "> Step 1: API ingestion (TypeScript source adapters)..."
cd "$MATCHA_DIR/../pipelines"
/usr/bin/env npx tsx src/collection/api-ingest.ts >> "$LOG" 2>&1
cd "$SCRIPT_DIR"
log "[done] API ingestion complete"

# Step 2: RSS fetch (matcha binary)
log "> Step 2: RSS fetch (matcha)..."
MATCHA_BIN="${MATCHA_DIR}/bin/matcha"
MATCHA_CFG="${MATCHA_DIR}/config.yaml"
if [ -f "$MATCHA_BIN" ]; then
    "$MATCHA_BIN" -c "$MATCHA_CFG" >> "$LOG" 2>&1
    log "[done] RSS fetch complete"
else
    log "[skip] matcha binary not found at $MATCHA_BIN"
fi

# Step 3: Dedup + write to VAULT_DIR/raw/inbox/YYYY-MM-DD-articles.md
log "> Step 3: Dedup + write to raw/inbox/..."
python3 filter_matcha.py >> "$LOG" 2>&1
log "[done] Dedup complete"

# Step 4: (removed) split_queue.py
#
# In the Option-3 librarian, articles flow:
#   matcha → raw/inbox/YYYY-MM-DD-articles.md → chiya-pipelines `intake` →
#     ArticleStore → librarian
#
# split_queue.py used to fan the inbox file out into raw/inbox/queue/*.md
# stub files. The librarian no longer reads from queue/ — intake reads the
# articles file directly. Leaving split_queue.py active here would silently
# accumulate orphan queue/ stubs every 4h.
#
# To re-enable temporarily:  python3 split_queue.py >> "$LOG" 2>&1

log "Collection cycle finished"
log ""
