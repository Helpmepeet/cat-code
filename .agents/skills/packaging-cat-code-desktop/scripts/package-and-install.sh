#!/bin/bash
set -euo pipefail

fail() {
  echo "[install] $*" >&2
  exit 1
}

verify_bundle() {
  local bundle="$1"
  codesign --verify --deep --strict --verbose=2 "$bundle"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Contents/Info.plist")" == "com.catcode.desktop" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$bundle/Contents/Info.plist")" == "Cat Code" ]]
  [[ -x "$bundle/Contents/Resources/sidecar/cat-code-sidecar" ]]
}

[[ "$(uname -s)" == "Darwin" ]] || fail "local desktop packaging targets macOS only"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "run from a Git checkout"
[[ -f "$REPO_ROOT/app/scripts/package-app.ts" ]] || fail "this checkout has no Cat Code desktop package script"

if command -v bun >/dev/null 2>&1; then
  BUN_DIR="$(dirname "$(command -v bun)")"
elif [[ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]]; then
  BUN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
else
  fail "Bun is unavailable; install it or set BUN_INSTALL to its parent directory"
fi
export PATH="$BUN_DIR:$PATH"

SOURCE="$REPO_ROOT/app/dist-app/Cat Code.app"
TARGET="/Applications/Cat Code.app"
BACKUP="${TARGET}.previous-build"
[[ ! -e "$BACKUP" ]] || fail "rollback path already exists: $BACKUP"

printf '[install] building from %s\n' "$REPO_ROOT"
bun run --cwd "$REPO_ROOT/app" package
[[ -d "$SOURCE" ]] || fail "package script completed without creating $SOURCE"
printf '[install] verifying built bundle\n'
verify_bundle "$SOURCE"

had_previous=0
restore_previous() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 ]]; then
    rm -rf "$TARGET"
    if [[ $had_previous -eq 1 && -d "$BACKUP" ]]; then
      mv "$BACKUP" "$TARGET"
      echo '[install] restored the previous app bundle' >&2
    fi
  fi
  exit "$status"
}
trap restore_previous EXIT

if [[ -d "$TARGET" ]]; then
  mv "$TARGET" "$BACKUP"
  had_previous=1
fi
ditto "$SOURCE" "$TARGET"
printf '[install] verifying installed bundle\n'
verify_bundle "$TARGET"

if [[ $had_previous -eq 1 ]]; then
  rm -rf "$BACKUP"
fi
trap - EXIT
printf '[install] installed %s\n' "$TARGET"
