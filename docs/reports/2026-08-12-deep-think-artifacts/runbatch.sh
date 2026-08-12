#!/bin/bash
SB=/private/tmp/claude-501/-Users-pt-cat-code/cde27359-d467-42af-a056-546d27e12279/scratchpad
cd "$SB"
CLI=/Users/pt/.local/bin/claude
SYS="Follow the user's output-format rules exactly."
for b in 1 2 3; do
  P="$(cat task_batch$b.txt)"
  timeout 1200 $CLI -p "$P" --tools "" --strict-mcp-config \
    --effort high --system-prompt "$SYS" --output-format json </dev/null > "bA_b$b.json" 2>&1
  echo "A batch $b done rc=$?" >> runbatch.progress
  MAX_THINKING_TOKENS=0 timeout 1200 $CLI -p "$P" --tools "" --mcp-config "$SB/claude_mcp.json" \
    --strict-mcp-config --effort high --system-prompt "$SYS" --output-format json </dev/null > "bB_b$b.json" 2>&1
  echo "B batch $b done rc=$?" >> runbatch.progress
done
echo DONE > runbatch.done
