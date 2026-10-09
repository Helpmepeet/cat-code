#!/bin/zsh
# Runs prepDirty.ts for every selected task in selection-v2/tasks.tsv.
# Extra arguments (e.g. --status-only) pass through.
cd /Users/pt/workspace-map-study
while IFS=$'\t' read id idx base; do
  [[ -f tasks-v2/$id/dirty.json ]] && continue
  sess=$(bun -e "const fs=require('fs');const t=JSON.parse(fs.readFileSync('selection-v2/tasks.json','utf8')).tasks[$idx];const h=require('os').homedir();const {execSync}=require('child_process');console.log(execSync(t.src==='codex'?\"find \"+h+\"/.codex/sessions -name '*\"+t.id+\".jsonl'\":\"ls \"+h+(t.src==='catcode'?'/.cat-code':'/.claude')+\"/projects/-Users-pt-cat-code*/\"+t.id+\".jsonl\",{encoding:'utf8'}).trim())")
  ts=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('selection-v2/tasks.json','utf8')).tasks[$idx].ts)")
  echo "== $id $ts"
  bun tools/prepDirty.ts tasks-v2/$id $base $ts $sess "$@" 2>&1
done < selection-v2/tasks.tsv
