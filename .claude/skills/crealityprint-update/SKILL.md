---
name: crealityprint-update
description: Review a Renovate PR that bumps Creality Print (ARG CREALITYPRINT_VERSION, label crealityprint-update). Checks the release asset, the upstream source diff against what the image relies on, upstream issues and CI, then brings docs/research up to date with the new version. Use when asked to check, review or prepare a Creality Print update or new release. Not for base-image or tooling PRs.
---

# Review a Creality Print update PR

Goal: tell the user whether the new release is safe to merge, what changes for this image, and bring the docs in line with it. Selkies base-image PRs need different checks and are not covered here.

## 1. Gather

1. Check out the PR branch, so the docs you read and edit are the PR's: `gh pr checkout <n>` in a clean tree, or a separate worktree.
2. From the repo root, run `bash .claude/skills/crealityprint-update/gather.sh [<pr>]` (needs `gh` and `jq`). Without a number it picks the open PR labelled `crealityprint-update`. It prints:
   - the release: prerelease flag, assets and digests, and how many AppImages match the build's asset pattern;
   - the upstream diff: changed files on the watch list, watch-list keywords in changed lines, files without a patch, and changed files per directory;
   - the upstream issues named in `docs/research/app.md`, and issues opened since the release;
   - every mention of the old version in this checkout;
   - the PR's CI checks.
3. Read the release notes in the PR body (`gh pr view <n>`).

Upstream syncs its sources as one squashed commit per release, so commit messages say nothing. Read the patches instead. The compare response is cached for an hour:

```bash
gh api --cache 1h repos/CrealityOfficial/CrealityPrint/compare/<old>...<new> \
  --jq '.files[] | select(.filename | test("WebView|InstanceCheck")) | "===== \(.filename)\n\(.patch)"'
```

## 2. Review

Check each part of the app the image depends on. The docs describe how the image uses it; read the matching section before you judge a change.

| What the image relies on | Where it is described | What breaks it |
|---|---|---|
| One AppImage matching `asset_name_pattern` in `build/fetch-crealityprint.sh`, with a sha256 `digest` | `app.md` (Releases and assets), `decisions.md` | No match or no digest fails the build. Several matches are fine: the highest build number wins. A rename needs a new pattern in the script and both docs |
| `AppRun` layout: the build inserts `export GDK_BACKEND=x11` as its second line. The `ldd` check uses `bin:usr/lib`, like `AppRun` | `app.md` (Inside the AppImage) | Changes under `src/platform/unix/` to the AppImage build (`BuildLinuxDeb` is the `.deb` only), or new or removed bundled libraries. The build's `ldd` check catches a missing library |
| Single-instance D-Bus call (`InstanceCheck`, `AnotherInstance`, `Plater::load_files`), used by `crealityprint-open` and the upload watcher | `app.md` (Single instance and opening files), `files.md` | A renamed bus name, object path or method, or a change to the message format or to how argv is handled |
| Data directory `<major>.<minor>`, `Creality.conf` keys and `privacyInfo.json` written by the first-run seed | `persistence.md` | A new minor or major version means a new data directory and the app's own migration. Test upgrading a `/config` from the previous release by hand. On a major version, also check that `privacyInfo.json` (version `7.3.0.0`) still declines telemetry |
| Machine profiles with `default_print_profile` and `default_filament_profile`, read by the `CP_PRINTER` seed | `persistence.md` (first-run seed) | Renamed or removed machine profiles, or default presets. The seed e2e covers the K1C |
| WebKitGTK pages: wizard, home, login, device manager | `app.md` (First run; Cloud, updates and telemetry) | `Widgets/WebView` changes. The seed and scale e2e use some pages; suggest a manual look at the home page and the device tab |
| Fonts and bundled FreeType, and libraries from `deps/` | `app.md` (Inside the AppImage; Known upstream issues) | A variable UI font crashes the app at start (#607). The smoke test catches crashes at start |
| Environment variables the app reads (`getenv`) | `app.md` (Environment variables the app reads) | New or changed variables, especially for WebKit, GDK or GPU |
| Window and quit handling (`MainFrame`), used by idle quit's SIGTERM | `idle-quit.md` | The idle e2e covers it |
| OpenGL setup (`OpenGLManager`) | `gpu.md` | CI has no GPU. Say so if this changes |
| Update checks and profile downloads (`PresetUpdater`, `AppUpdater`) | `app.md` (Cloud, updates and telemetry) | Changed network behaviour, or a self-updater that would try to replace the AppImage |

Also:

- **Upstream issues:** for each issue that is now closed or merged, check whether the fix is in this release. If it is, update the `app.md` table. Propose dropping a workaround the fix makes unnecessary, but don't drop it in the update PR without asking. Flag new issues about Linux or the AppImage that were opened since the release.
- **CI:** every check must pass. If checks are pending, wait with `gh run watch <run-id> --exit-status`. What the e2e specs cover:

  | Spec | Covers |
  |---|---|
  | `seed` | first-run seed and `CP_PRINTER` |
  | `persistence` | restarts and the `PUID`/`PGID` repair |
  | `transfer`, `watcher` | file transfer, and auto-open over D-Bus |
  | `clipboard`, `input` | clipboard and input |
  | `scale` | `CP_UI_SCALE` |
  | `idle` | idle quit |

## 3. Update the docs

The docs describe the image as it is now (`docs/research/README.md`): when the pinned version changes, they change in the same PR. Go through the old-version mentions that `gather.sh` printed, and decide on each one.

- **`app.md`:**
  - the pinned version in the summary ("now `vX.Y.Z`") and in "How the image installs it";
  - the release table: add the new release's row, update the "As of" date, and fix the previous release's prerelease flag (it often changes when the next release appears);
  - the prerelease-flag bullet, if its example no longer holds.
- **`persistence.md`:** the example full version (`X.Y.Z.<build>`) and the `CP_PRINTER` seed output, but only once the seed e2e has passed on the new build.
- **"Verified against" lines:** add the new version only to docs whose claims you rechecked for this release. Reading the source diff rechecks `app.md`. Leave `gpu.md`, `hidpi.md`, `printers.md` and the others alone unless their subject changed and you rechecked it.
- **Behaviour changes found in the review:** update the topic doc that covers that subject. Don't add a new doc.
- **Leave version examples alone:** the tag examples in the README, `docker-compose.example.yml` and the script usage comments stay as they are, because any published version is a valid example.

## 4. Report and hand over

- **Report:**
  - a verdict;
  - what you checked;
  - which integration points are unchanged;
  - changes worth knowing about;
  - doc edits;
  - anything you didn't verify (for example, whether creality.com offers the release as its current download).
- **Show the diff.** Commit and push only when the user asks for it in that turn. Use conventional-commit messages (`docs: …`). If you push to the Renovate branch, tell the user that Renovate stops rebasing a branch that has someone else's commits. Never merge the PR.
