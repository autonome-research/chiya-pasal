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
set -euo pipefail
cd "$(dirname "$0")/.."
exec flock -w 300 .rebuild-better-sqlite3.lock \
  npm rebuild better-sqlite3 --silent
