#!/bin/bash
set -euo pipefail
umask 077
# One-time reviewed administrator setup. No sudoers entries are installed.
[[ $EUID == 0 ]] || { echo 'Run this reviewed installer with administrator authorization.' >&2; exit 1; }
[[ $# == 1 ]] || { echo 'Usage: install.sh prepared-directory' >&2; exit 1; }
prepared=$1
[[ $prepared = /private/tmp/cat-lid-install-* && ! -L $prepared && -d $prepared ]] || exit 1
helper=/Library/PrivilegedHelperTools/com.catcode.lid-closed
state='/Library/Application Support/Cat Code/LidClosed'
daemon=/Library/LaunchDaemons/com.catcode.lid-closed.plist
watcher=/Library/LaunchDaemons/com.catcode.lid-closed.recovery.plist
# Verify the reviewed payload, and verify installed copies again before executing
# root code. Recovery configuration and journal are never reset during upgrade.
[[ $(cd "$prepared" && pwd -P) = "$prepared" ]] || exit 1
lid_payload_stage=$(/usr/bin/mktemp -d /private/tmp/cat-lid-payload.XXXXXX)
lid_verified=false
lid_guard_pid=''
lid_install_exit() {
  lid_result=$?
  trap - EXIT
  if [[ $lid_result != 0 && $lid_verified = true ]]; then
    # Keep the recovery watcher if restoration remains unresolved. A started
    # guard exits on its own bound; verify its exit before a fresh installation.
    if "$helper" --restore-for-uninstall; then
      /bin/bash "$state/uninstall.sh" || true
    else
      echo 'Restoration unresolved; recovery jobs retained. Use the approved fallback and verify the kernel flag.' >&2
    fi
  fi
  /bin/rm -rf "$lid_payload_stage"
  exit "$lid_result"
}
trap lid_install_exit EXIT
# All verification inputs and destinations are now protected from the caller.
for payload in helper configuration.json daemon.plist recovery.plist uninstall.sh; do
  /usr/bin/install -o root -g wheel -m 0600 "$prepared/$payload" "$lid_payload_stage/$payload"
done
cd "$lid_payload_stage"
/bin/cat > expected-payload <<'PAYLOAD'
__EXPECTED_PAYLOAD__
PAYLOAD
/usr/bin/shasum -a 256 -c expected-payload
# Verify destinations before executing either installed generation. An existing
# directory can retain an ACL despite install -d setting its POSIX mode bits.
/bin/chmod 0755 "$lid_payload_stage/helper"
/usr/bin/codesign --verify --strict "$lid_payload_stage/helper"
"$lid_payload_stage/helper" --check-installation-paths
"$lid_payload_stage/helper" --check-configuration "$lid_payload_stage/configuration.json"
if [[ -e $helper ]]; then
  [[ -f $helper && ! -L $helper ]] || exit 1
  "$helper" --restore-for-uninstall
  /bin/launchctl bootout system/com.catcode.lid-closed 2>/dev/null || true
  /bin/launchctl bootout system/com.catcode.lid-closed.recovery 2>/dev/null || true
fi
[[ ! -L /Library/PrivilegedHelperTools && ! -L /Library/LaunchDaemons && ! -L '/Library/Application Support/Cat Code' && ! -L $state ]] || exit 1
/usr/bin/install -d -o root -g wheel -m 0755 /Library/PrivilegedHelperTools
/usr/bin/install -d -o root -g wheel -m 0755 '/Library/Application Support/Cat Code'
/usr/bin/install -d -o root -g wheel -m 0700 "$state"
/usr/bin/install -o root -g wheel -m 0755 helper "$helper"
/usr/bin/install -o root -g wheel -m 0600 configuration.json "$state/configuration.json"
/usr/bin/install -o root -g wheel -m 0644 daemon.plist "$daemon"
/usr/bin/install -o root -g wheel -m 0644 recovery.plist "$watcher"
/usr/bin/install -o root -g wheel -m 0755 uninstall.sh "$state/uninstall.sh"
# Trusted expected hashes are copied into this installer by prepare.ts. A
# post-copy mismatch leaves no newly installed job running.
/usr/bin/shasum -a 256 "$helper" "$state/configuration.json" "$daemon" "$watcher" "$state/uninstall.sh" > installed-hashes
/usr/bin/awk '{print $1}' installed-hashes > installed-digests
/usr/bin/awk '{print $1}' expected-payload > expected-digests
/usr/bin/cmp installed-digests expected-digests
/usr/bin/codesign --verify --strict "$helper"
"$lid_payload_stage/helper" --check-installation-paths
lid_verified=true
# On reinstall the old helper may be absent but the retained journal is still
# checked by the verified new executable before either job admits work.
"$helper" --restore-for-uninstall
"$helper" --resume-after-install
/bin/launchctl bootstrap system "$watcher"
/bin/launchctl bootstrap system "$daemon"
lid_installation_kind=$("$helper" --installation-kind)
if [[ $lid_installation_kind = application ]]; then
  echo 'Installed lid-closed helper and recovery watcher.'
  exit 0
fi
[[ $lid_installation_kind = experiment ]] || exit 1
/bin/rm -f "$state/experiment-guard-owner.json"
# macOS nohup calls a console-detachment SPI which fails in administrator
# authorization sessions. Ignore hangup in the shell and inherit it across exec;
# the guard needs neither a terminal nor that private console operation.
(
  trap '' HUP
  exec "$helper" --guard-experiment
) > "$state/experiment-cleanup.log" 2>&1 < /dev/null &
lid_guard_pid=$!
for ((lid_check=0; lid_check<20; lid_check++)); do
  kill -0 "$lid_guard_pid" || exit 1
  [[ ! -s "$state/experiment-guard-owner.json" ]] || break
  /bin/sleep 0.1
done
[[ -s "$state/experiment-guard-owner.json" ]] && kill -0 "$lid_guard_pid"
echo "Installed experimental helper and recovery watcher; temporary cleanup guardian PID $lid_guard_pid. Begin one lease within 30 seconds. Hardware is not qualified."
