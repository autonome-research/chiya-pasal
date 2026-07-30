#!/usr/bin/env bash
# Serialized rebuild of the better-sqlite3 native binding.
#
# Every chiya systemd unit runs this as ExecStartPre so a silent Node ABI
# bump can't break the DB binding. The flock matters: the digest timers
# (06:30/18:30) fire on the same tick as the every-10-min librarian, and
# two concurrent `npm rebuild` runs race on the same .node file — both
# units then die before running any pipeline code. One lock file under
# pipelines/ serializes rebuilds across units (and dev runs that use this
# script instead of calling npm rebuild directly).
# The rebuild is also CONDITIONAL: `npm rebuild` recompiles unconditionally
# (~30s), deleting the .node file mid-recompile — a unit whose main process
# is loading modules during another unit's rebuild crashes with "could not
# locate the bindings file" even with the flock (the lock serializes
# rebuilds against each other, not against module loads). Skipping the
# rebuild when the binding already loads shrinks that window to the rare
# post-Node-upgrade tick, where crashed units self-heal on their next run.
set -euo pipefail
cd "$(dirname "$0")/.."
exec flock -w 300 .rebuild-better-sqlite3.lock bash -c '
  node -e "require(\"better-sqlite3\")" 2>/dev/null && exit 0
  npm rebuild better-sqlite3 --silent
'
