#!/bin/zsh
# Builds and verifies every selected pair not yet verified (verify/<id>/result.json).
cd /Users/pt/workspace-map-study
for id in "$@"; do
  echo "== $id $(date -u +%H:%M:%S)"
  bun tools/makeSpecs.ts $id || continue
  if ! bun tools/buildPair.ts tasks-v2/$id/spec.json > verify/build-$id.log 2>&1; then echo "BUILD FAILED $id"; tail -5 verify/build-$id.log; continue; fi
  bun tools/verifyPair.ts $id --expect-unavailable statusline-setup
done
