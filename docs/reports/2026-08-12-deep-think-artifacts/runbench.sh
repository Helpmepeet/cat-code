#!/bin/bash
SB=/private/tmp/claude-501/-Users-pt-cat-code/cde27359-d467-42af-a056-546d27e12279/scratchpad
cd "$SB"
CLI=/Users/pt/.local/bin/claude
SYS="Follow the user's output-format rules exactly."
P="$(cat task_bench.txt)"
MAX_THINKING_TOKENS=0 $CLI -p "$P" --tools "" --strict-mcp-config \
  --effort high --system-prompt "$SYS" --output-format json </dev/null > bench_C.json 2>&1
MAX_THINKING_TOKENS=0 $CLI -p "$P" --tools "" --mcp-config "$SB/claude_mcp.json" --strict-mcp-config \
  --effort high --system-prompt "$SYS" --output-format json </dev/null > bench_B.json 2>&1
$CLI -p "$P" --tools "" --strict-mcp-config \
  --effort high --system-prompt "$SYS" --output-format json </dev/null > bench_A.json 2>&1
echo DONE > runbench.done
