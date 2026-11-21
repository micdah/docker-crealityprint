#!/bin/bash
# Print a Markdown table of e2e results (for the GitHub job summary).
#
# usage: tests/e2e-summary.sh <playwright results.json> [title]
#
# Why: lets a reviewer see which tests ran and passed in a PR without opening the artifacts.

set -euo pipefail

readonly results_file="${1:?usage: tests/e2e-summary.sh <results.json> [title]}"
readonly title="${2:-e2e results}"

if [ ! -f "$results_file" ]; then
  echo "### ${title}"
  echo
  echo "No results file was produced (the run failed before Playwright reported)."
  exit 0
fi

echo "### ${title}"
echo
echo "| Result | Test | Duration |"
echo "|---|---|---|"
jq -r '
  def walk_suites: .suites[]? | (., walk_suites);
  [walk_suites | .specs[]? as $spec | $spec.tests[]? as $test
    | ($test.results | last) as $result
    | {
        status: ($result.status // "skipped"),
        title: "\($spec.file) › \($spec.title)",
        seconds: (($result.duration // 0) / 1000 | floor)
      }]
  | .[]
  | "| \(if .status == "passed" then "✅" elif .status == "skipped" then "⏭️" else "❌" end) \(.status) | \(.title) | \(.seconds)s |"
' "$results_file"
