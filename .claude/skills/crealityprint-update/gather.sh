#!/bin/bash
# Collect the facts for reviewing a Creality Print update PR (see SKILL.md next to this file).
#
# usage: gather.sh [pr-number]     default: the open PR labelled crealityprint-update
#
# Why a script: the data gathering is the same for every release, so it should give the same
# output every time. Judging what the output means is the skill's job.
# Needs gh (logged in) and jq.

set -euo pipefail

readonly upstream_repo="CrealityOfficial/CrealityPrint"
readonly pr_label="crealityprint-update"
readonly max_patch_hits_per_file=5
repo_root="$(git rev-parse --show-toplevel)"
readonly repo_root
work_dir="$(mktemp -d)"
readonly work_dir
trap 'rm -rf "$work_dir"' EXIT

# Changed upstream paths that touch what the image relies on (docs/research/app.md).
readonly watched_paths=(
  'src/platform/unix/'                # AppRun and the AppImage build: our GDK_BACKEND line
  'InstanceCheck'                     # single-instance D-Bus call used by crealityprint-open
  '^src/[^/]+\.(cpp|hpp)$'            # main() and command-line parsing
  'GUI_App\.(cpp|hpp)'                # startup, data dir, first run, web requests
  'AppConfig\.(cpp|hpp)'              # Creality.conf keys the first-run seed writes
  'Widgets/WebView'                   # every embedded WebKit page (wizard, home, login)
  'MainFrame\.cpp'                    # window and quit handling (idle quit sends SIGTERM)
  'OpenGLManager'                     # GPU and llvmpipe behaviour
  'PresetUpdater|AppUpdater'          # update checks and profile downloads
  'resources/profiles/[^/]+\.json$'   # vendor profile index
  'resources/profiles/[^/]+/machine/' # machine profiles the CP_PRINTER seed reads
  'resources/fonts/'                  # font crash (#607): no variable UI font
  '^deps/'                            # bundled libraries, wxWidgets, FreeType
  '^CMakeLists\.txt$'                 # build and bundling
)

# Words in added or removed lines that touch the image's integration points. Upstream's own
# tests are skipped: they read env vars and paths of their own.
readonly watched_keywords=(
  'privacyInfo' 'is_first_install' 'firstguide' 'last_export_path' 'last_opened_folder'
  'default_print_profile' 'default_filament_profile' 'single_instance' 'AnotherInstance'
  'datadir' 'getenv' 'GDK_' 'WEBKIT_' 'LD_LIBRARY_PATH' 'SSL_CERT' 'XDG_' 'DRI_PRIME'
  'LC_ALL' 'AppImage' 'load_files' 'EVT_LOAD_MODEL_OTHER_INSTANCE'
)

log_section() {
  printf '\n## %s\n\n' "$*"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

join_regex() {
  local IFS='|'
  echo "$*"
}

# An empty section would read like a missing one.
print_or_none() {
  local section_text
  section_text="$(cat)"
  if [ -z "$section_text" ]; then
    echo "none"
    return
  fi
  echo "$section_text"
}

check_requirements() {
  local tool
  for tool in gh jq; do
    if ! command -v "$tool" > /dev/null; then
      fail "${tool} is not installed"
    fi
  done
}

# Renovate labels its Creality Print PRs, so the open one is the default.
resolve_pr_number() {
  local requested_pr="${1:-}"
  if [ -n "$requested_pr" ]; then
    echo "$requested_pr"
    return
  fi
  local found_pr
  found_pr="$(gh pr list --label "$pr_label" --state open --json number --jq '.[0].number')"
  if [ -z "$found_pr" ]; then
    fail "no open PR labelled ${pr_label}; pass the PR number"
  fi
  echo "$found_pr"
}

# The old or new tag, from the Dockerfile line the PR changes. diff_side is "-" or "+".
tag_from_pr_diff() {
  local pr_number="$1"
  local diff_side="$2"
  gh pr diff "$pr_number" \
    | grep -E "^[${diff_side}]ARG CREALITYPRINT_VERSION=" \
    | head -n 1 \
    | sed -E 's/^.ARG CREALITYPRINT_VERSION=//'
}

# The same asset pattern the build uses, so this check and the build can't disagree.
asset_name_pattern() {
  grep -oE "asset_name_pattern='[^']+'" "${repo_root}/build/fetch-crealityprint.sh" \
    | sed -E "s/^asset_name_pattern='//; s/'$//"
}

# Each upstream response is fetched once; the sections below read the saved file.
fetch_upstream() {
  local api_path="$1"
  local output_file="$2"
  gh api "repos/${upstream_repo}/${api_path}" > "$output_file"
}

# Full version (e.g. 7.3.2.6412) of a release, from its AppImage name.
full_version_of_release() {
  local release_file="$1"
  local pattern="$2"
  jq -r --arg pattern "$pattern" \
    '[.assets[].name | select(test($pattern))] | last // ""' "$release_file" \
    | sed -E 's/^CrealityPrint-V//; s/-x86_64-Release\.AppImage$//'
}

print_release() {
  local new_tag="$1"
  local release_file="$2"
  local pattern="$3"

  log_section "Release ${new_tag}"
  jq -r '
    "published: \(.published_at)\nprerelease: \(.prerelease)\ndraft: \(.draft)\nassets:",
    (.assets[] | "  \(.name)  \(.size) bytes  \(.digest // "NO DIGEST")")' "$release_file"

  local matching_count
  matching_count="$(
    jq --arg pattern "$pattern" \
      '[.assets[] | select(.name | test($pattern))] | length' "$release_file"
  )"
  echo
  echo "AppImages matching the build's pattern ${pattern}: ${matching_count}"
  if [ "$matching_count" = "0" ]; then
    echo "WARNING: the build will fail; build/fetch-crealityprint.sh needs a new pattern"
  fi

  log_section "Recent releases (the prerelease flag moves)"
  gh release list --repo "$upstream_repo" --limit 5
}

print_changed_files() {
  local old_tag="$1"
  local new_tag="$2"
  local compare_file="$3"

  log_section "Upstream diff ${old_tag}...${new_tag}"
  jq -r '
    "commits: \(.total_commits)  changed files: \(.files | length)",
    (.commits[] | "  \(.sha[0:9]) \(.commit.message | split("\n")[0])")' "$compare_file"

  local file_count
  file_count="$(jq '.files | length' "$compare_file")"
  if [ "$file_count" -ge 300 ]; then
    echo "WARNING: GitHub lists at most 300 files; clone the repo and run git diff for the rest"
  fi

  log_section "Changed files on the watch list"
  jq -r --arg watched "$(join_regex "${watched_paths[@]}")" '
    .files[]
    | select(.filename | test($watched))
    | "\(.status)\t+\(.additions)/-\(.deletions)\t\(.filename)"' "$compare_file" \
    | print_or_none

  log_section "Watch-list keywords in added or removed lines"
  jq -r \
    --arg keywords "$(join_regex "${watched_keywords[@]}")" \
    --argjson max_hits "$max_patch_hits_per_file" '
    .files[]
    | select(.patch != null and (.filename | startswith("tests/") | not))
    | .filename as $file
    | [.patch | split("\n")[] | select(test("^[-+]") and test($keywords))]
    | .[0:$max_hits][]
    | "\($file): \(.[0:160])"' "$compare_file" \
    | print_or_none

  log_section "Changed files without a patch (binary, or too large for the API)"
  jq -r '.files[] | select(.patch == null) | "\(.status)\t\(.filename)"' "$compare_file" \
    | print_or_none

  log_section "Changed files per directory"
  jq -r '
    [.files[].filename | split("/") | .[0:2] | join("/")]
    | group_by(.) | map("\(length)\t\(.[0])") | .[]' "$compare_file"
}

# The upstream issues the image's docs rely on: a fix may let us drop a workaround.
print_documented_issues() {
  local app_doc="${repo_root}/docs/research/app.md"
  local issue_numbers
  issue_numbers="$(
    grep -oE '(^|[^A-Za-z0-9/#-])#[0-9]{3,5}' "$app_doc" \
      | grep -oE '[0-9]+' \
      | sort -un
  )"

  log_section "Upstream issues and PRs named in docs/research/app.md"
  local issue_number
  for issue_number in $issue_numbers; do
    gh api "repos/${upstream_repo}/issues/${issue_number}" --jq '
      "#\(.number) [\(.state)\(if .pull_request.merged_at then ", merged" else "" end)] updated \(.updated_at[0:10]): \(.title)"'
  done
}

print_new_issues() {
  local new_tag="$1"
  local release_file="$2"
  local published_date
  published_date="$(jq -r '.published_at[0:10]' "$release_file")"

  log_section "Upstream issues opened since ${new_tag} was published (${published_date})"
  gh search issues \
    --repo "$upstream_repo" \
    --created ">=${published_date}" \
    --limit 40 \
    --json number,title,state,createdAt \
    --jq '.[] | "#\(.number) [\(.state)] \(.createdAt[0:10]) \(.title)"' \
    | print_or_none
}

# Mentions of the old version in this checkout; the skill decides which are stale.
print_old_version_mentions() {
  local old_tag="$1"
  local old_full_version="$2"
  local old_version="${old_tag#v}"
  local search_terms=(-e "$old_version")
  # An empty term would match every line.
  if [ -n "$old_full_version" ]; then
    search_terms+=(-e "$old_full_version")
  fi

  log_section "Mentions of ${old_version} ${old_full_version} in this checkout ($(git -C "$repo_root" rev-parse --abbrev-ref HEAD))"
  git -C "$repo_root" grep -nF \
    "${search_terms[@]}" \
    -- . ':!**/package-lock.json' \
    || echo "none"
}

print_ci_checks() {
  local pr_number="$1"
  log_section "CI checks on PR #${pr_number}"
  # gh exits non-zero while checks are pending or failing; the listing is what matters.
  gh pr checks "$pr_number" || true
}

main() {
  check_requirements

  local pr_number old_tag new_tag pattern
  pr_number="$(resolve_pr_number "${1:-}")"
  old_tag="$(tag_from_pr_diff "$pr_number" '-')"
  new_tag="$(tag_from_pr_diff "$pr_number" '+')"
  if [ -z "$old_tag" ] || [ -z "$new_tag" ]; then
    fail "PR #${pr_number} doesn't change ARG CREALITYPRINT_VERSION in the Dockerfile"
  fi
  pattern="$(asset_name_pattern)"
  if [ -z "$pattern" ]; then
    fail "could not read asset_name_pattern from build/fetch-crealityprint.sh"
  fi

  local old_release_file="${work_dir}/old-release.json"
  local new_release_file="${work_dir}/new-release.json"
  local compare_file="${work_dir}/compare.json"
  fetch_upstream "releases/tags/${old_tag}" "$old_release_file"
  fetch_upstream "releases/tags/${new_tag}" "$new_release_file"
  fetch_upstream "compare/${old_tag}...${new_tag}" "$compare_file"

  local old_full_version
  old_full_version="$(full_version_of_release "$old_release_file" "$pattern")"

  echo "# Creality Print update: PR #${pr_number}, ${old_tag} -> ${new_tag}"
  print_release "$new_tag" "$new_release_file" "$pattern"
  print_changed_files "$old_tag" "$new_tag" "$compare_file"
  print_documented_issues
  print_new_issues "$new_tag" "$new_release_file"
  print_old_version_mentions "$old_tag" "$old_full_version"
  print_ci_checks "$pr_number"
}

main "$@"
