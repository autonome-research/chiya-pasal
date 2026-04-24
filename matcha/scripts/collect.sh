#!/bin/bash
# collect.sh — Matcha collection orchestrator
# Runs: api_ingest → matcha RSS → filter/dedup → VAULT_DIR/raw/inbox/YYYY-MM-DD-articles.md
# Triggered by Linux cron every 4 hours
#
# VAULT_DIR env var points to the target vault (default: ~/vault)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MATCHA_DIR="$(dirname "$SCRIPT_DIR")"
VAULT_DIR="${VAULT_DIR:-$HOME/vault}"
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

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "Matcha Collection — $TODAY (vault: $VAULT_DIR)"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Step 1: API ingestion
log "> Step 1: API ingestion (api_ingest.py)..."
cd "$SCRIPT_DIR"
python3 api_ingest.py >> "$LOG" 2>&1
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

log "Collection cycle finished"
log ""
