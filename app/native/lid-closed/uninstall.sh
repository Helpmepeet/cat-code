#!/bin/bash
set -euo pipefail
[[ $EUID == 0 && $# == 0 ]] || { echo 'Administrator authorization is required.' >&2; exit 1; }
helper=/Library/PrivilegedHelperTools/com.catcode.lid-closed
state='/Library/Application Support/Cat Code/LidClosed'
# Keep the watcher installed if restoration or observation fails.
"$helper" --restore-for-uninstall
/bin/launchctl bootout system/com.catcode.lid-closed 2>/dev/null || true
/bin/launchctl bootout system/com.catcode.lid-closed.recovery 2>/dev/null || true
/bin/rm -f /Library/LaunchDaemons/com.catcode.lid-closed.plist /Library/LaunchDaemons/com.catcode.lid-closed.recovery.plist "$helper"
# Keep the recovery journal and configuration as evidence. They cannot activate
# anything without an installed helper, and future setup first checks recovery.
echo 'Removed lid-closed authority after observed restoration. Recovery evidence was retained.'
