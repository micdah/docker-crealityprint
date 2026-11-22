#!/bin/bash
# Smoke test: the image starts, serves HTTPS, runs Creality Print and shows its icon.
#
# usage: tests/smoke.sh <image>
#
# Why: a fast check (about a minute) that every build and CI run does before the slower
# e2e suite. It never talks to a printer.

set -euo pipefail

readonly image="${1:?usage: tests/smoke.sh <image>}"
readonly container_name="crealityprint-smoke-$$"
config_dir="$(mktemp -d)"
readonly config_dir

log() {
  echo "[smoke] $*"
}

fail() {
  echo "[smoke] FAIL: $*" >&2
  docker logs "$container_name" 2>&1 | tail -n 60 >&2 || true
  exit 1
}

# Remove the container, and the config dir as root because the container may own files in it.
cleanup() {
  docker rm --force "$container_name" > /dev/null 2>&1 || true
  docker run --rm \
    --volume "${config_dir}:/cleanup" \
    --entrypoint find \
    "$image" /cleanup -mindepth 1 -delete > /dev/null 2>&1 || true
  rmdir "$config_dir" 2> /dev/null || true
}
trap cleanup EXIT

start_container() {
  docker run --detach \
    --name "$container_name" \
    --shm-size 1gb \
    --publish 127.0.0.1::3001 \
    --env PUID="$(id -u)" \
    --env PGID="$(id -g)" \
    --volume "${config_dir}:/config" \
    "$image" > /dev/null
}

# Poll a command until it succeeds or the timeout (seconds) runs out.
wait_for() {
  local description="$1"
  local timeout_seconds="$2"
  shift 2
  local waited=0
  while ! "$@" > /dev/null 2>&1; do
    if [ "$waited" -ge "$timeout_seconds" ]; then
      fail "timed out after ${timeout_seconds}s waiting for ${description}"
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log "ok: ${description} (${waited}s)"
}

init_done() {
  docker logs "$container_name" 2>&1 | grep -q 'ls.io-init\] done'
}

# Running as the desktop user (abc), not root.
app_running() {
  docker exec "$container_name" pgrep -u abc -x CrealityPrint
}

https_port() {
  docker port "$container_name" 3001/tcp | head -n 1 | cut -d: -f2
}

https_ok() {
  curl --fail --silent --insecure --output /dev/null "https://127.0.0.1:$(https_port)/"
}

check_app_stays_up() {
  sleep 20
  if ! app_running > /dev/null; then
    fail "Creality Print exited within 20s of starting"
  fi
  log "ok: Creality Print still running after 20s"
}

# Same check as the build-time guard, against the final image: every library resolves.
check_libraries() {
  local missing_libraries
  missing_libraries="$(
    docker exec "$container_name" bash -c \
      'LD_LIBRARY_PATH=/opt/crealityprint/bin:/opt/crealityprint/usr/lib ldd /opt/crealityprint/bin/CrealityPrint' \
      | grep 'not found' \
      || true
  )"
  if [ -n "$missing_libraries" ]; then
    fail "missing libraries: ${missing_libraries}"
  fi
  log "ok: all app libraries resolve"
}

# vainfo makes the base's init-video pick the i965 driver on Intel Gen9, which streams black
# (docs/research/04). The Dockerfile purges it; this catches a base that brings it back some
# other way. Needs no GPU, so it runs on every CI build.
check_no_vainfo() {
  if docker exec "$container_name" bash -c 'command -v vainfo' > /dev/null; then
    fail "vainfo is installed; it gives a black stream on Intel Gen9 GPUs"
  fi
  log "ok: vainfo is not installed"
}

check_icon() {
  local served_icon_sha app_icon_sha
  served_icon_sha="$(curl --silent --insecure "https://127.0.0.1:$(https_port)/icon.png" | sha256sum | cut -d' ' -f1)"
  app_icon_sha="$(docker exec "$container_name" sha256sum /opt/crealityprint/CrealityPrint.png | cut -d' ' -f1)"
  if [ "$served_icon_sha" != "$app_icon_sha" ]; then
    fail "served icon.png is not the Creality Print icon"
  fi
  log "ok: favicon/PWA icon is the Creality Print icon"
}

main() {
  log "starting ${image}"
  start_container
  wait_for "container init" 180 init_done
  wait_for "HTTPS on port 3001" 60 https_ok
  wait_for "the CrealityPrint process" 120 app_running
  check_app_stays_up
  check_libraries
  check_no_vainfo
  check_icon
  log "PASS"
}

main
