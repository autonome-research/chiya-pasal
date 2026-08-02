#!/bin/sh
# Email the operator when a chiya unit fails.
#
# Wired in as `OnFailure=chiya-alert@%n.service` on the pipeline units, so
# systemd invokes it with the failed unit's full name as $1. Until this
# existed, a failing timer was silent: the fleet failed 50 consecutive runs
# and told nobody.
#
# Contract: THIS SCRIPT NEVER FAILS. It is the last thing in the chain and a
# non-zero exit here would turn "a pipeline broke" into "a pipeline broke and
# the alerter is also in a failed state". Missing recipient, missing gws,
# missing journalctl, a bounced send — all are logged to the journal and
# exit 0.
#
# Recipient: CHIYA_ALERT_EMAIL, falling back to CHIYA_EMAIL_TO. Both come
# from the EnvironmentFile the alert unit loads (pipelines/.env).
#
# Usage: scripts/alert-failure.sh <unit-name>

set -u

UNIT="${1:-unknown-unit}"
TO="${CHIYA_ALERT_EMAIL:-${CHIYA_EMAIL_TO:-}}"
HOST="$(uname -n 2>/dev/null || echo unknown-host)"
WHEN="$(date -Is 2>/dev/null || date 2>/dev/null || echo unknown-time)"
LINES=30

log() {
  echo "[alert-failure] $*"
}

if [ -z "$TO" ]; then
  log "no CHIYA_ALERT_EMAIL or CHIYA_EMAIL_TO in the environment — cannot notify about $UNIT"
  exit 0
fi

# Last N journal lines for the failed unit. --user because the whole fleet
# runs as user units. Any failure here (no journalctl, unknown unit, no
# permission) degrades to a note in the body rather than losing the alert.
TAIL_TEXT=""
if command -v journalctl >/dev/null 2>&1; then
  TAIL_TEXT="$(journalctl --user -u "$UNIT" -n "$LINES" --no-pager 2>&1)" ||
    TAIL_TEXT="(journalctl exited non-zero; no log tail available)"
else
  TAIL_TEXT="(journalctl not available on this host)"
fi
if [ -z "$TAIL_TEXT" ]; then
  TAIL_TEXT="(no journal output for $UNIT)"
fi

SUBJECT="chiya FAILED: $UNIT on $HOST"
BODY="chiya unit failed: $UNIT
host: $HOST
time: $WHEN

Last $LINES journal lines:

$TAIL_TEXT"

if ! command -v gws >/dev/null 2>&1; then
  log "gws not on PATH — alert for $UNIT not emailed. Body follows:"
  log "$SUBJECT"
  exit 0
fi

# Bound the send so a hung gws can't sit here until the unit's timeout.
# Deliberately unquoted: empty when `timeout` is unavailable, and the split
# into two words when it is present is the point.
RUN=""
if command -v timeout >/dev/null 2>&1; then
  RUN="timeout 60"
fi

# shellcheck disable=SC2086
if $RUN gws gmail +send --to "$TO" --subject "$SUBJECT" --body "$BODY"; then
  log "alert for $UNIT emailed to $TO"
else
  log "gws send failed for $UNIT (exit $?) — giving up quietly"
fi

exit 0
