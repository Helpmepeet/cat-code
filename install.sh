#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'MESSAGE'
This legacy installer is retired. It does not install Cat Code.

For Apple Silicon Macs, use the complete Cat Code.app download from this
repository's verified GitHub Actions delivery, or follow README.md to build
from source. The desktop compatibility target is macOS 13 or newer.

No files were installed or changed.
MESSAGE
exit 1
