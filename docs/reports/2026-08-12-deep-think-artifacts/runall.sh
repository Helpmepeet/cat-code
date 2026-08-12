#!/bin/bash
SB=/private/tmp/claude-501/-Users-pt-cat-code/cde27359-d467-42af-a056-546d27e12279/scratchpad
cd "$SB"
CLI=/Users/pt/.local/bin/claude
SYS="Follow the user's output-format rules exactly."
for rep in 1 2; do
  MAX_THINKING_TOKENS=0 $CLI -p "$(cat task_hard.txt)" --tools "" --strict-mcp-config \
    --effort high --system-prompt "$SYS" --output-format json </dev/null > "hard_C$rep.json" 2>&1
  MAX_THINKING_TOKENS=0 $CLI -p "$(cat task_hard.txt)" --tools "" --mcp-config "$SB/claude_mcp.json" \
    --strict-mcp-config --effort high --system-prompt "$SYS" --output-format json </dev/null > "hard_B$rep.json" 2>&1
  $CLI -p "$(cat task_hard.txt)" --tools "" --strict-mcp-config \
    --effort high --system-prompt "$SYS" --output-format json </dev/null > "hard_A$rep.json" 2>&1
done
echo DONE > runall.done
