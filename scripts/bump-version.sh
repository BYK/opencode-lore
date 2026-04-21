#!/bin/bash
# Pre-release version bump for all three Lore workspace packages.
#
# Why this exists instead of letting craft auto-bump:
#
# Craft's built-in auto-bumping runs `npm version --workspaces --include-workspace-root`.
# On our monorepo this succeeds in updating the version field in every package.json,
# but then npm *also* validates dependency URLs during the version command and
# errors out with EUNSUPPORTEDPROTOCOL on `workspace:*` specifiers. The exit
# status propagates back to craft which treats the whole step as failed and
# falls back to per-package bumping — which fails identically, because the
# workspace deps are still there.
#
# We bypass npm entirely by editing package.json files with jq directly.
#
# Why we also patch bun.lock:
#
# `bun pm pack` rewrites `workspace:*` dependency specifiers to a concrete
# version at pack time. It reads that version from `bun.lock`, NOT from
# `packages/<pkg>/package.json`. If the lockfile still records the OLD
# version of a workspace package, pack will embed that stale version in the
# tarball's `dependencies` field. We learned this the hard way with v0.10.0:
# @loreai/opencode@0.10.0 and @loreai/pi@0.10.0 were published with a
# @loreai/core@0.9.1 dependency (because 0.9.1 was the lockfile's recorded
# workspace version), which was never published — npm install failed with
# ETARGET "No matching version found for @loreai/core@0.9.1".
#
# Neither `bun install` nor `bun install --lockfile-only` updates the
# `version` field of a workspace entry once it exists in the lockfile —
# the lockfile is the source of truth and package.json edits are ignored.
# We'd need `rm bun.lock && bun install --lockfile-only` to refresh it,
# but bun isn't available in craft's Docker image (which runs this script
# as preReleaseCommand). So we patch the three workspace version lines with
# awk instead — same result, no bun required.
#
# Upstream tracking: https://github.com/getsentry/craft/issues/804
#
# Craft passes the new version via CRAFT_NEW_VERSION. Command-line args are a
# legacy fallback — prefer the env var.
set -euo pipefail

NEW_VERSION="${CRAFT_NEW_VERSION:-${2:-}}"
if [ -z "$NEW_VERSION" ]; then
  echo "error: CRAFT_NEW_VERSION not set and no positional version argument" >&2
  exit 1
fi

echo "Bumping Lore workspace packages to ${NEW_VERSION}"

for f in \
  packages/core/package.json \
  packages/opencode/package.json \
  packages/pi/package.json; do
  # Preserve trailing newline by piping through jq then appending.
  tmp="$(mktemp)"
  jq --arg v "$NEW_VERSION" '.version = $v' "$f" > "$tmp"
  mv "$tmp" "$f"
  name=$(jq -r '.name' "$f")
  echo "  ✓ ${name} → ${NEW_VERSION}"
done

# Patch workspace version fields in bun.lock.
#
# The lockfile structure for each workspace is:
#     "packages/<name>": {
#       "name": "@loreai/<name>",
#       "version": "<OLD_VERSION>",
#       "dependencies": { ... },
#       ...
#     }
#
# The awk state machine below sets in_ws when it sees a workspace-path key,
# then replaces the *next* "version": "..." line it encounters with NEW_VERSION.
# Resets in_ws after the replacement so only the first "version" line after
# the workspace header gets touched (not version pins inside "dependencies").
#
# Uses only POSIX-standard awk constructs so it works with gawk, mawk, etc.
if [ -f bun.lock ]; then
  echo "Patching bun.lock workspace versions..."
  tmp="$(mktemp)"
  awk -v new_ver="$NEW_VERSION" '
    /^    "packages\/(core|opencode|pi)": \{$/ { in_ws = 1 }
    in_ws && /^      "version": "[0-9]+\.[0-9]+\.[0-9]+",$/ {
      sub(/"[0-9]+\.[0-9]+\.[0-9]+"/, "\"" new_ver "\"")
      in_ws = 0
    }
    { print }
  ' bun.lock > "$tmp"
  mv "$tmp" bun.lock
  echo "  ✓ bun.lock patched"
else
  echo "warning: bun.lock not found — skipping lockfile patch." >&2
fi

echo "Version bump complete."
