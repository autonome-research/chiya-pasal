#!/bin/bash
# collect.sh — Matcha collection orchestrator
# Runs: api_ingest → matcha RSS → filter/dedup → append to wiki/raw/articles/YYYY-MM-DD.md
# Triggered by Linux cron every 4 hours
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MATCHA_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="${MATCHA_DIR}/logs"
TODAY=$(date +%Y-%m-%d)
LOG="${LOG_DIR}/collect-${TODAY}.log"

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "🍵 Chiya Collection — $TODAY"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Step 1: API ingestion
log "▶ Step 1: API ingestion (api_ingest.py)..."
cd "$SCRIPT_DIR"
python3 api_ingest.py >> "$LOG" 2>&1
log "✅ API ingestion complete"

# Step 2: RSS fetch (matcha binary)
log "▶ Step 2: RSS fetch (matcha)..."
MATCHA_BIN="${MATCHA_DIR}/bin/matcha"
MATCHA_CFG="${MATCHA_DIR}/config.yaml"
if [ -f "$MATCHA_BIN" ]; then
    "$MATCHA_BIN" -c "$MATCHA_CFG" >> "$LOG" 2>&1
    log "✅ RSS fetch complete"
else
    log "⚠️  matcha binary not found at $MATCHA_BIN — skipping RSS"
fi

# Step 3: Dedup + append to wiki
log "▶ Step 3: Dedup + append to wiki/raw/articles/..."
python3 filter_matcha.py >> "$LOG" 2>&1
log "✅ Dedup complete"

log "🍵 Collection cycle finished"
log ""
