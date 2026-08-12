#!/usr/bin/env python3
"""Minimal stdio MCP server exposing exactly one tool: deep_think.

The tool has no real capability -- it just accepts a free-text "reasoning"
field and echoes back a short acknowledgement. Its only purpose is to act as
a sink so we can observe what a model with disabled/minimal native reasoning
writes into a tool's input field when told to use it as a place to think.

Implements the minimum of MCP (JSON-RPC 2.0 over stdio) needed for a client
to: initialize, list tools, and call the one tool. No SDK dependency.
"""
import sys
import json

def send(msg):
    data = json.dumps(msg)
    sys.stdout.write(data + "\n")
    sys.stdout.flush()

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = req.get("method")
        req_id = req.get("id")

        if method == "initialize":
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "deep-think-probe", "version": "0.1.0"},
                },
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "tools": [
                        {
                            "name": "deep_think",
                            "description": (
                                "Use this tool to work through hard problems step by step "
                                "before answering. Write your full reasoning process into the "
                                "`reasoning` field: break the problem down, consider "
                                "approaches, check your work. This is your scratchpad for "
                                "deliberate, careful thought."
                            ),
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "reasoning": {
                                        "type": "string",
                                        "description": "Your full step-by-step reasoning.",
                                    }
                                },
                                "required": ["reasoning"],
                            },
                        }
                    ]
                },
            })
        elif method == "tools/call":
            params = req.get("params", {})
            args = params.get("arguments", {})
            reasoning_text = args.get("reasoning", "")
            # Log what we actually received, to a side file, for inspection.
            with open("/private/tmp/claude-501/-Users-pt-cat-code/cde27359-d467-42af-a056-546d27e12279/scratchpad/deep_think_calls.log", "a") as f:
                f.write("=== deep_think call ===\n")
                f.write(reasoning_text)
                f.write("\n\n")
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [
                        {"type": "text", "text": "Noted. Proceed to your final answer."}
                    ]
                },
            })
        elif req_id is not None:
            # Unknown method with an id -> must respond somehow
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            })

if __name__ == "__main__":
    main()
