#!/bin/bash
# Build-time installer for Creality Print.
#
# usage: fetch-crealityprint.sh <tag>     e.g. fetch-crealityprint.sh v7.3.2
#
# Why a script instead of inline RUN commands: Creality's release assets change naming often
# (several AppImages per release, renamed patterns), so asset selection needs real checks that
# fail loudly instead of silently picking the wrong file. See docs/research/09, risk R3.

set -euo pipefail

readonly release_tag="${1:?usage: fetch-crealityprint.sh <tag>}"
readonly repository="CrealityOfficial/CrealityPrint"
readonly install_dir="/opt/crealityprint"
readonly asset_name_pattern='^CrealityPrint-V[0-9.]+-x86_64-Release\.AppImage$'
work_dir="$(mktemp -d)"
readonly work_dir

log() {
  echo "**** $* ****"
}

fail() {
  printf 'ERROR: %b\n' "$*" >&2
  exit 1
}

# Only plain vX.Y.Z tags are tracked; suffixed tags (-Beta, -rc, ...) are real betas.
check_tag_format() {
  if [[ ! "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    fail "tag '${release_tag}' is not a plain vX.Y.Z release tag"
  fi
}

# Use a token when the build passes one (CI), to avoid the 60 requests/hour anonymous limit.
github_api() {
  local api_path="$1"
  local token_file="/run/secrets/github_token"
  local auth_header=()
  if [ -s "$token_file" ]; then
    auth_header=(-H "Authorization: Bearer $(cat "$token_file")")
  fi
  curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    "${auth_header[@]}" \
    "https://api.github.com/${api_path}"
}

# Pick the generic x86_64 AppImage. When a release ships several (v7.3.0 had three builds),
# take the highest build number. Prints "<url> <sha256-digest>".
select_asset() {
  local release_json="$1"
  jq -r --arg pattern "$asset_name_pattern" '
    [.assets[] | select(.name | test($pattern))]
    | if length == 0 then error("no asset matches the AppImage name pattern") else . end
    | sort_by(.name | capture("V(?<v>[0-9.]+)-").v | split(".") | map(tonumber))
    | last
    | "\(.browser_download_url) \(.digest // "")"
  ' <<< "$release_json"
}

download_and_verify() {
  local download_url="$1"
  local expected_digest="$2"
  local appimage_path="$3"

  log "downloading ${download_url}"
  curl -fsSL -o "$appimage_path" "$download_url"

  if [ -z "$expected_digest" ]; then
    fail "the release asset has no sha256 digest to verify against"
  fi
  local actual_digest
  actual_digest="sha256:$(sha256sum "$appimage_path" | cut -d' ' -f1)"
  if [ "$actual_digest" != "$expected_digest" ]; then
    fail "checksum mismatch: expected ${expected_digest}, got ${actual_digest}"
  fi
  log "checksum ok (${actual_digest})"
}

# No FUSE in containers, so extract the AppImage instead of mounting it.
extract_appimage() {
  local appimage_path="$1"
  chmod +x "$appimage_path"
  (
    cd "$work_dir"
    "$appimage_path" --appimage-extract > /dev/null
  )
  mv "$work_dir/squashfs-root" "$install_dir"

  # The extracted directories come out as 0700, which the non-root app user can't read.
  find "$install_dir" -type d -exec chmod 755 {} +

  # Belt and braces with /usr/local/bin/crealityprint: the GTK UI needs the X11 backend.
  sed -i "1a export GDK_BACKEND=x11" "$install_dir/AppRun"
}

# Fail the build when the base image lacks a library the app links against.
# Resolve with the same library path AppRun sets, so bundled libraries (libmspack, libsrtp2, ...)
# count as found and only libraries the image must provide are reported.
check_libraries() {
  local bundled_library_path="$install_dir/bin:$install_dir/usr/lib"
  local missing_libraries
  missing_libraries="$(
    LD_LIBRARY_PATH="$bundled_library_path" ldd "$install_dir/bin/CrealityPrint" \
      | grep 'not found' \
      || true
  )"
  if [ -n "$missing_libraries" ]; then
    fail "missing libraries:\n${missing_libraries}"
  fi
  log "all libraries resolved"
}

# Selkies copies www/icon.png to the favicon and the PWA icon on every start.
install_icon() {
  local app_icon="$install_dir/CrealityPrint.png"
  if [ ! -f "$app_icon" ]; then
    fail "app icon ${app_icon} not found in the AppImage"
  fi
  cp "$app_icon" /usr/share/selkies/www/icon.png
}

write_build_version() {
  local download_url="$1"
  printf 'CrealityPrint %s\nURL: %s\n' "$release_tag" "$download_url" > /build_version
}

main() {
  check_tag_format

  log "resolving ${repository} release ${release_tag}"
  local release_json
  release_json="$(github_api "repos/${repository}/releases/tags/${release_tag}")"

  local asset_line download_url expected_digest
  asset_line="$(select_asset "$release_json")"
  download_url="${asset_line%% *}"
  expected_digest="${asset_line#* }"

  local appimage_path="$work_dir/CrealityPrint.AppImage"
  download_and_verify "$download_url" "$expected_digest" "$appimage_path"
  extract_appimage "$appimage_path"
  check_libraries
  install_icon
  write_build_version "$download_url"

  rm -rf "$work_dir"
  log "installed Creality Print ${release_tag} to ${install_dir}"
}

main
