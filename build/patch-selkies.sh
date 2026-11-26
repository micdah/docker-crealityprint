#!/bin/bash
# Apply our patches to the base image's Selkies Python package, at build time.
#
# usage: patch-selkies.sh <patch>...
#
# Why: the patches must fail the build, not apply half-way or silently, when a base image
# update changes the code they touch. git apply allows no fuzz (only line offsets) and applies
# all hunks of a patch or none. Research: docs/research/base-image.md.

set -euo pipefail

log() {
  echo "[patch-selkies] $*"
}

fail() {
  echo "[patch-selkies] FAIL: $*" >&2
  exit 1
}

# The folder that holds the selkies package. find_spec locates it without importing it.
selkies_parent_dir() {
  local package_dir
  package_dir="$(python3 -c 'import importlib.util; print(importlib.util.find_spec("selkies").submodule_search_locations[0])')"
  dirname "$package_dir"
}

selkies_version() {
  python3 -c 'import importlib.metadata; print(importlib.metadata.version("selkies"))'
}

# Check first, so a patch that doesn't apply names itself before anything changes.
apply_patch() {
  local patch_file="$1"
  local patch_name
  patch_name="$(basename "$patch_file")"

  if ! git apply --check --verbose "$patch_file"; then
    fail "${patch_name} no longer applies to selkies $(selkies_version). The base image changed the patched code; update the patch (see its header)."
  fi
  git apply --verbose "$patch_file"
  log "applied ${patch_name}"
}

# Rebuild the bytecode of every patched file: it fails the build on a syntax error, and Selkies
# (running as abc, who can't write here) doesn't recompile the stale .pyc on every start.
recompile_patched_files() {
  local patch_file
  local patched_file
  for patch_file in "$@"; do
    git apply --numstat "$patch_file" | cut -f3 | while read -r patched_file; do
      python3 -m py_compile "$patched_file"
      log "recompiled ${patched_file}"
    done
  done
}

main() {
  if [ "$#" -eq 0 ]; then
    fail "usage: patch-selkies.sh <patch>..."
  fi

  local patch_files=()
  local patch_file
  for patch_file in "$@"; do
    patch_files+=("$(realpath "$patch_file")")
  done

  local target_dir
  target_dir="$(selkies_parent_dir)"
  log "selkies $(selkies_version) in ${target_dir}"

  # git apply resolves the patches' paths (selkies/...) against the working directory.
  cd "$target_dir"
  for patch_file in "${patch_files[@]}"; do
    apply_patch "$patch_file"
  done
  recompile_patched_files "${patch_files[@]}"
}

main "$@"
