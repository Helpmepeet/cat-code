#!/usr/bin/env bash
# Build committed source; keep only the installed bundle visible to launchers.
set -Eeuo pipefail

fail() { echo "[install:local] $*" >&2; exit 1; }

check_closed() {
  local bundle=$1 output status
  [[ -d $bundle ]] || return 0
  output=$(/usr/sbin/lsof -t "$bundle/Contents/MacOS/Cat Code" 2>&1) && status=0 || status=$?
  if (( status == 0 )); then
    echo "[install:local] Cat Code is running (PID ${output//$'\n'/, }). Quit it before installing." >&2
    return 1
  fi
  if (( status != 1 )) || [[ -n $output ]]; then
    echo "[install:local] Could not check whether Cat Code is running: $output" >&2
    return 1
  fi
}

bundle_identifier() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"
}

verify_bundle() {
  local bundle=$1 commit=$2
  codesign --verify --deep --strict "$bundle" || return 1
  [[ $(bundle_identifier "$bundle") == com.catcode.desktop ]] || return 1
  [[ -x "$bundle/Contents/MacOS/Cat Code" ]] || return 1
  # Packaging seals the main script in ASAR; older rollback bundles were unpacked.
  (cd "$repo_root/app" && bun -e '
    const { extractFile } = await import("@electron/asar");
    const { existsSync, readFileSync } = await import("node:fs");
    const [bundle, commit] = process.argv.slice(1);
    const resources = `${bundle}/Contents/Resources`;
    const main = existsSync(`${resources}/app.asar`)
      ? extractFile(`${resources}/app.asar`, "main/main.js")
      : readFileSync(`${resources}/app/main/main.js`);
    process.exit(main.includes(commit) ? 0 : 1);
  ' "$bundle" "$commit")
}

unregister_bundle() {
  # Missing registrations (including paths inside .noindex) are harmless.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -u "$1" >/dev/null 2>&1 || true
}

register_bundle() {
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$1"
}

# Subshell-owned trap state survives Bash unwinding function locals on errexit.
install_bundle() (
  tx_built_app=$1 tx_installed_app=$2 tx_backup_dir=$3 tx_commit=$4
  tx_saved_app=''
  tx_promoted=0 tx_committed=0 tx_restored=1
  tx_stage_root="$(dirname "$tx_installed_app")/.cat-code-install.noindex"
  mkdir -p "$tx_stage_root" "$tx_backup_dir"
  mkdir "$tx_stage_root/lock" || fail 'Another install is active, or an interrupted install needs inspection in .cat-code-install.noindex.'
  tx_transaction=''
  cleanup_install() {
    tx_status=$?
    trap - EXIT
    if (( ! tx_committed )); then
      if (( tx_promoted )); then
        mv "$tx_installed_app" "$tx_transaction/failed.app" || tx_restored=0
      fi
      if (( tx_restored )) && [[ -n $tx_saved_app && -d $tx_saved_app ]]; then
        mv "$tx_saved_app" "$tx_installed_app" || tx_restored=0
      fi
      if (( tx_restored )) && [[ -d $tx_installed_app ]]; then
        register_bundle "$tx_installed_app" || tx_restored=0
      fi
    fi
    if (( tx_restored )); then
      [[ -z $tx_transaction ]] || rm -rf "$tx_transaction"
    else
      echo "[install:local] Recovery incomplete. Retained $tx_transaction and $tx_saved_app for manual recovery." >&2
      tx_status=1
    fi
    if (( tx_restored )); then rmdir "$tx_stage_root/lock"; fi
    exit "$tx_status"
  }
  trap cleanup_install EXIT
  tx_transaction=$(mktemp -d "$tx_stage_root/transaction.XXXXXX")
  tx_staging_app="$tx_transaction/Cat Code.app"
  tx_rollback_app="$tx_backup_dir/Cat Code.rollback-${tx_transaction##*.}.app"
  [[ ! -e $tx_rollback_app ]] || fail 'Rollback path already exists.'
  verify_bundle "$tx_built_app" "$tx_commit"
  cp -R "$tx_built_app" "$tx_staging_app"
  verify_bundle "$tx_staging_app" "$tx_commit"
  unregister_bundle "$tx_built_app"
  check_closed "$tx_installed_app"
  if [[ -d $tx_installed_app ]]; then
    unregister_bundle "$tx_installed_app"
    mv "$tx_installed_app" "$tx_transaction/previous.app"
    tx_saved_app="$tx_transaction/previous.app"
  fi
  unregister_bundle "$tx_staging_app"
  mv "$tx_staging_app" "$tx_installed_app"
  tx_promoted=1
  verify_bundle "$tx_installed_app" "$tx_commit"
  register_bundle "$tx_installed_app"
  if [[ -n $tx_saved_app ]]; then
    mv "$tx_saved_app" "$tx_rollback_app"
    tx_saved_app="$tx_rollback_app"
  fi
  tx_committed=1
  # Retire only inactive, identified backups created by this installer, and only
  # after the replacement verified and registered. Keep recovery on any failure.
  for tx_old in "$tx_backup_dir"/Cat\ Code.rollback-*.app; do
    [[ -d $tx_old && ! -L $tx_old && $tx_old != "$tx_saved_app" ]] || continue
    [[ $(bundle_identifier "$tx_old") == com.catcode.desktop ]] || continue
    check_closed "$tx_old"
    unregister_bundle "$tx_old"
    rm -rf "$tx_old"
  done
  # Existing visible duplicates must be resolved rather than silently declaring
  # a clean install. Do not sweep unknown bundles or another installer's staging.
  for tx_duplicate in "$(dirname "$tx_installed_app")"/Cat\ Code*.app; do
    [[ -d $tx_duplicate && $tx_duplicate != "$tx_installed_app" ]] || continue
    [[ $(bundle_identifier "$tx_duplicate") == com.catcode.desktop ]] || continue
    fail "Extra Cat Code app remains at $tx_duplicate; inspect it before cleanup."
  done
  # Unregistering an older copy can invalidate a shared bundle-ID binding.
  register_bundle "$tx_installed_app"
  echo "[install:local] Installed $tx_installed_app at ${tx_commit:0:8}"
  [[ -z $tx_saved_app ]] || echo "[install:local] Rollback: $tx_saved_app"
)

main() {
  local launch=1 built_app='' commit=''
  if [[ ${1:-} == --help ]]; then
    echo 'Usage: bun run --cwd app install:local [--no-launch] [--bundle PATH --commit SHA]'
    echo 'Builds committed HEAD (or installs an already verified bundle), verifies and replaces the closed app.'
    echo 'Keeps one previous build in ~/Library/Application Support/Cat Code Install Backups.noindex.'
    echo 'Opens Cat Code unless --no-launch is supplied. Run packaged headless smoke before --bundle.'
    return
  fi
  while (( $# )); do
    case $1 in
      --no-launch) launch=0; shift ;;
      --bundle|--commit)
        (( $# >= 2 )) || fail "Missing value for $1"
        if [[ $1 == --bundle ]]; then built_app=$2; else commit=$2; fi
        shift 2 ;;
      *) fail "Unknown argument: $1. Use --help." ;;
    esac
  done
  repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
  local installed_app='/Applications/Cat Code.app'
  local backup_dir="$HOME/Library/Application Support/Cat Code Install Backups.noindex"
  command -v bun >/dev/null || fail 'bun is required.'
  check_closed "$installed_app"
  if [[ -n $built_app || -n $commit ]]; then
    [[ -d $built_app && $commit =~ ^[a-f0-9]{40}$ ]] || fail '--bundle requires an existing bundle and --commit with the full SHA.'
    built_app=$(cd "$built_app" && pwd -P)
    [[ $built_app != "$installed_app" ]] || fail 'The source bundle must differ from the installed app.'
  else
    commit=$(git -C "$repo_root" rev-parse HEAD)
    scratch=$(mktemp -d "${TMPDIR:-/tmp}/cat-code-install.XXXXXX")
    trap 'rm -rf "$scratch"' EXIT
    local checkout="$scratch/source"
    echo "[install:local] Building committed revision ${commit:0:8}; uncommitted changes are excluded."
    git clone --shared --no-checkout --quiet "$repo_root" "$checkout"
    git -C "$checkout" checkout --detach --quiet "$commit"
    (cd "$checkout" && bun install --frozen-lockfile)
    (cd "$checkout/app" && bun install --frozen-lockfile)
    # Bundle verification must use the selected checkout's ASAR dependency too.
    repo_root=$checkout
    [[ -z $(git -C "$checkout" status --porcelain) ]] || fail 'Temporary checkout is dirty.'
    (cd "$checkout" && bun run --cwd app package)
    built_app="$checkout/app/dist-app/Cat Code.app"
    verify_bundle "$built_app" "$commit"
    (cd "$checkout" && bun run --cwd app smoke:packaged:headless)
  fi
  install_bundle "$built_app" "$installed_app" "$backup_dir" "$commit"
  if (( launch )); then
    /usr/bin/open -a "$installed_app" || fail 'Installed the update, but could not open it.'
    local attempt
    for attempt in {1..15}; do
      if /usr/sbin/lsof -t "$installed_app/Contents/MacOS/Cat Code" >/dev/null 2>&1; then
        echo "[install:local] Running $installed_app at ${commit:0:8}"
        return
      fi
      sleep 1
    done
    fail 'Installed the update, but Cat Code did not remain running.'
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
