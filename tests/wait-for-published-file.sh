#!/bin/bash
# Wait until a URL serves exactly the same bytes as a local file.
#
# usage: tests/wait-for-published-file.sh <url> <local-file> [timeout-seconds]
#   timeout-seconds   default 300; exit 1 when the URL still doesn't match by then
#
# Why: the CI report job pushes to gh-pages and then posts a PR comment that embeds an image
# from GitHub Pages. Pages needs a minute or so to deploy; if the comment goes out earlier,
# GitHub's image proxy fetches the previous image (or a 404) instead of this run's.

set -euo pipefail

readonly poll_interval_seconds=10

url=""
local_file=""
timeout_seconds=300
download_file=""

log() {
  echo "[wait-for-published-file] $*"
}

usage() {
  sed -n '4,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

parse_arguments() {
  if [ "$#" -lt 2 ]; then
    usage
  fi
  url="$1"
  local_file="$2"
  if [ "$#" -ge 3 ]; then
    timeout_seconds="$3"
  fi
  if [ ! -f "$local_file" ]; then
    echo "local file ${local_file} not found" >&2
    exit 2
  fi
}

file_checksum() {
  sha256sum "$1" | cut -d ' ' -f 1
}

# A fresh query string on every attempt: the Pages CDN caches each URL (stale answers too)
# for up to 10 minutes, so re-asking the same URL could keep returning the old file.
cache_busting_url() {
  local attempt="$1"
  local separator="?"
  if [[ "$url" == *\?* ]]; then
    separator="&"
  fi
  echo "${url}${separator}poll=${attempt}-$(date +%s)"
}

# true when this attempt downloaded the expected bytes; a 404 or network error is just "not yet".
published_file_matches() {
  local attempt="$1"
  local expected_checksum="$2"
  local matches=false
  # Time-limited, so one stalled connection can't hang the loop past its deadline.
  if curl \
      --silent \
      --fail \
      --location \
      --connect-timeout 10 \
      --max-time 30 \
      --output "$download_file" \
      "$(cache_busting_url "$attempt")"; then
    if [ "$(file_checksum "$download_file")" = "$expected_checksum" ]; then
      matches=true
    fi
  fi
  echo "$matches"
}

cleanup() {
  rm -f "$download_file"
}

main() {
  parse_arguments "$@"
  download_file="$(mktemp)"
  trap cleanup EXIT

  local expected_checksum deadline attempt
  expected_checksum="$(file_checksum "$local_file")"
  deadline=$(($(date +%s) + timeout_seconds))
  attempt=1

  log "waiting up to ${timeout_seconds}s for ${url} to match ${local_file}"
  while true; do
    if [ "$(published_file_matches "$attempt" "$expected_checksum")" = true ]; then
      log "${url} is published (attempt ${attempt})"
      exit 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "timed out: ${url} still doesn't serve ${local_file} after ${timeout_seconds}s"
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep "$poll_interval_seconds"
  done
}

main "$@"
