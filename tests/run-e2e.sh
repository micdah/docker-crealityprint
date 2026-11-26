#!/bin/bash
# Run the Playwright e2e suite against an image, locally or in CI.
#
# Why this shape: specs start their own app containers through the host's Docker socket, so
# Playwright runs in a runner image with the Docker CLI. Config dirs live under a work dir
# mounted at the same path in the runner, so bind mounts the specs create resolve on the host.
# The specs never talk to a printer.

set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_dir
readonly e2e_dir="${repo_dir}/tests/e2e"
readonly runner_image="crealityprint-e2e-runner:local"
readonly artifacts_dir="${E2E_ARTIFACTS_DIR:-${repo_dir}/e2e-artifacts}"

image=""
specs=()
workers=2
app_cpus=""

log() {
  echo "[e2e] $*"
}

usage() {
  cat >&2 << 'EOF'
usage: tests/run-e2e.sh <image> [--spec <name>]... [--workers <n>] [--app-cpus <n>]
  --spec      run only tests/e2e/<name>.spec.js (repeatable; default: all specs)
  --workers   spec files run in parallel (default 2; CI matrix jobs use 1)
  --app-cpus  limit each app container's CPUs, e.g. 4 to mimic a CI runner
env:
  E2E_ARTIFACTS_DIR  reports and screenshots (default <repo>/e2e-artifacts)
  E2E_WORK_ROOT      parent of the per-run work dir with the app configs (default <repo>/.e2e-work)
EOF
  exit 2
}

parse_arguments() {
  if [ "$#" -lt 1 ]; then
    usage
  fi
  image="$1"
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --spec)
        specs+=("$2.spec.js")
        shift 2
        ;;
      --workers)
        workers="$2"
        shift 2
        ;;
      --app-cpus)
        app_cpus="$2"
        shift 2
        ;;
      *)
        usage
        ;;
    esac
  done
}

build_runner_image() {
  log "building the test runner image"
  docker build --quiet --tag "$runner_image" "$e2e_dir" > /dev/null
}

has_gpu() {
  if [ -e /dev/dri ]; then
    echo true
  else
    echo false
  fi
}

# Remove every app container of this run, then the work dir. Files in it may belong to other
# uids (the PUID test re-owns a config), so delete them from a container as root.
cleanup() {
  local leftover_containers
  leftover_containers="$(docker ps --all --quiet --filter "label=crealityprint-e2e=${run_id}")"
  if [ -n "$leftover_containers" ]; then
    # shellcheck disable=SC2086
    docker rm --force $leftover_containers > /dev/null 2>&1 || true
  fi
  docker run --rm \
    --volume "${work_dir}:/cleanup" \
    --entrypoint find \
    "$image" /cleanup -mindepth 1 -delete > /dev/null 2>&1 || true
  rmdir "$work_dir" 2> /dev/null || true
}

run_playwright() {
  local docker_socket_gid
  docker_socket_gid="$(stat -c %g /var/run/docker.sock)"

  docker run --rm \
    --network host \
    --ipc host \
    --user "$(id -u):$(id -g)" \
    --group-add "$docker_socket_gid" \
    --env HOME=/tmp \
    --env CI \
    --env E2E_REPORT_NAME \
    --env E2E_IMAGE="$image" \
    --env E2E_RUN_ID="$run_id" \
    --env E2E_WORK_DIR="$work_dir" \
    --env E2E_HAS_DRI="$(has_gpu)" \
    --env E2E_APP_CPUS="$app_cpus" \
    --env E2E_ARTIFACTS_DIR=/e2e/artifacts \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "${e2e_dir}:/e2e/tests:ro" \
    --volume "${work_dir}:${work_dir}" \
    --volume "${artifacts_dir}:/e2e/artifacts" \
    "$runner_image" \
    npx playwright test \
      --config /e2e/tests/playwright.config.js \
      --workers "$workers" \
      "${specs[@]}"
}

main() {
  parse_arguments "$@"
  if ! docker image inspect "$image" > /dev/null 2>&1; then
    echo "image ${image} not found; build it first" >&2
    exit 1
  fi

  run_id="$(date +%s)-$$"
  work_dir="${E2E_WORK_ROOT:-${repo_dir}/.e2e-work}/${run_id}"
  mkdir -p "$work_dir" "$artifacts_dir"
  # Screenshots are written by the specs themselves; drop the previous run's files, including
  # the PR comment screenshot, so a failed run never leaves an old one behind.
  rm -rf "${artifacts_dir}/screenshots" "${artifacts_dir}/app-screenshot"
  trap cleanup EXIT

  build_runner_image
  log "running ${specs[*]:-all specs} against ${image} (workers: ${workers}, app cpus: ${app_cpus:-unlimited})"
  run_playwright
}

main "$@"
