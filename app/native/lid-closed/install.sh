#!/bin/bash
set -euo pipefail
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
trap '/bin/rm -rf "$lid_payload_stage"' EXIT
# All verification inputs and destinations are now protected from the caller.
for payload in helper configuration.json daemon.plist recovery.plist uninstall.sh; do
  /usr/bin/install -o root -g wheel -m 0600 "$prepared/$payload" "$lid_payload_stage/$payload"
done
cd "$lid_payload_stage"
/bin/cat > expected-payload <<'PAYLOAD'
__EXPECTED_PAYLOAD__
PAYLOAD
/usr/bin/shasum -a 256 -c expected-payload
if [[ -e $helper ]]; then
  [[ -f $helper && ! -L $helper ]] || exit 1
  "$helper" --restore-for-uninstall
  /bin/launchctl bootout system/com.catcode.lid-closed 2>/dev/null || true
  /bin/launchctl bootout system/com.catcode.lid-closed.recovery 2>/dev/null || true
fi
[[ ! -L /Library/PrivilegedHelperTools && ! -L /Library/LaunchDaemons && ! -L '/Library/Application Support/Cat Code' && ! -L $state ]] || exit 1
/usr/bin/install -d -o root -g wheel -m 0755 /Library/PrivilegedHelperTools
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
# On reinstall the old helper may be absent but the retained journal is still
# checked by the verified new executable before either job admits work.
"$helper" --restore-for-uninstall
/bin/launchctl bootstrap system "$watcher"
/bin/launchctl bootstrap system "$daemon"
"$helper" --resume-after-install
echo 'Installed bounded lid-closed helper and independent recovery watcher. Hardware is not qualified.'
