#!/usr/bin/env bash
# Build the committed checkout, verify it, install it, and open Cat Code.
# The live app must be closed before this script runs.
set -Eeuo pipefail

if [[ ${1:-} == --help ]]; then
  echo 'Usage: bun run --cwd app install:local'
  echo 'Builds HEAD in a clean temporary checkout, verifies it, installs it, and opens Cat Code.'
  echo 'Quit Cat Code first. Uncommitted changes are excluded; the previous app is kept for rollback.'
  exit 0
fi
if (( $# != 0 )); then
  echo 'Unknown argument. Use --help for usage.' >&2
  exit 2
fi

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
installed_app='/Applications/Cat Code.app'
bundle_id='com.catcode.desktop'
scratch=''
staging_app=''

fail() {
  echo "[install:local] $*" >&2
  exit 1
}

cleanup() {
  if [[ -n $staging_app && -d $staging_app ]]; then
    rm -rf "$staging_app"
  fi
  if [[ -n $scratch && -d $scratch ]]; then
    rm -rf "$scratch"
  fi
}
trap cleanup EXIT

check_closed() {
  [[ -d $installed_app ]] || return 0
  local output status
  output=$(/usr/sbin/lsof -t "$installed_app/Contents/MacOS/Cat Code" 2>&1) && status=0 || status=$?
  if (( status == 0 )); then
    fail "Cat Code is running (PID ${output//$'\n'/, }). Quit it before installing."
  fi
  if (( status != 1 )) || [[ -n $output ]]; then
    fail "Could not check whether Cat Code is running: $output"
  fi
}

verify_bundle() {
  local bundle=$1 commit=$2
  codesign --verify --deep --strict "$bundle" || return 1
  [[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Contents/Info.plist") == "$bundle_id" ]] || return 1
  [[ -x "$bundle/Contents/MacOS/Cat Code" ]] || return 1
  /usr/bin/grep -Fq "$commit" "$bundle/Contents/Resources/app/main/main.js" || return 1
}

[[ -d "$repo_root/node_modules" && -d "$repo_root/app/node_modules" ]] || fail 'Install root and app dependencies first.'
command -v bun >/dev/null || fail 'bun is required.'
check_closed

commit=$(git -C "$repo_root" rev-parse HEAD)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/cat-code-install.XXXXXX")
checkout="$scratch/source"
echo "[install:local] Building committed revision ${commit:0:8}; uncommitted changes are excluded."
git clone --shared --no-checkout --quiet "$repo_root" "$checkout"
git -C "$checkout" checkout --detach --quiet "$commit"
ln -s "$repo_root/node_modules" "$checkout/node_modules"
ln -s "$repo_root/app/node_modules" "$checkout/app/node_modules"
printf 'node_modules\napp/node_modules\n' >> "$checkout/.git/info/exclude"
[[ -z $(git -C "$checkout" status --porcelain) ]] || fail 'Temporary checkout is dirty.'

(cd "$checkout" && bun run --cwd app package)
built_app="$checkout/app/dist-app/Cat Code.app"
verify_bundle "$built_app" "$commit" || fail 'Built bundle verification failed.'
(cd "$checkout" && bun run --cwd app smoke:packaged)

check_closed
tag="$(date +%Y%m%d%H%M%S)-$(uuidgen)"
staging_app="/Applications/Cat Code.staging-$tag.app"
rollback_app="/Applications/Cat Code.rollback-$tag.app"
[[ ! -e $staging_app && ! -e $rollback_app ]] || fail 'Install paths already exist.'
cp -R "$built_app" "$staging_app"
verify_bundle "$staging_app" "$commit" || fail 'Staged bundle verification failed.'

if [[ -d $installed_app ]]; then
  mv "$installed_app" "$rollback_app"
fi
if ! mv "$staging_app" "$installed_app"; then
  if [[ -d $rollback_app ]]; then mv "$rollback_app" "$installed_app"; fi
  fail 'Could not place the updated app; the previous app was restored.'
fi
staging_app=''
if ! verify_bundle "$installed_app" "$commit"; then
  staging_app="/Applications/Cat Code.staging-$tag.app"
  mv "$installed_app" "$staging_app"
  if [[ -d $rollback_app ]]; then mv "$rollback_app" "$installed_app"; fi
  fail 'Installed bundle verification failed; the previous app was restored.'
fi

/usr/bin/open -a "$installed_app" || fail "Installed the update, but could not open it. Rollback: $rollback_app"
for _ in {1..15}; do
  if /usr/sbin/lsof -t "$installed_app/Contents/MacOS/Cat Code" >/dev/null 2>&1; then
    echo "[install:local] Running $installed_app at ${commit:0:8}"
    if [[ -d $rollback_app ]]; then echo "[install:local] Rollback: $rollback_app"; fi
    exit 0
  fi
  sleep 1
done
fail "Installed the update, but Cat Code did not remain running. Rollback: $rollback_app"
