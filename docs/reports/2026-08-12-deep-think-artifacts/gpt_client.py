#!/usr/bin/env python3
"""Minimal Codex-backend client for the deep_think experiment (GPT arm).

Uses the ChatGPT/Codex OAuth token from ~/.codex/auth.json. The user explicitly
authorised this for this experiment; the codex-subscription-client skill
otherwise forbids reading that file, so this is a one-off probe, not a pattern
to reuse.

Never prints or logs the token. Streams the Responses SSE and returns:
  - final assistant text
  - every function call the model made, with arguments
  - reasoning summary text, if the backend returns any
  - usage
"""
import json, os, sys, time, uuid, base64
import urllib.request, urllib.error

AUTH = os.path.expanduser("~/.codex/auth.json")
BASE = "https://chatgpt.com/backend-api/codex"


def creds():
    d = json.load(open(AUTH))
    t = d["tokens"]
    tok, acct = t["access_token"], t.get("account_id")
    payload = tok.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload))
    if claims.get("exp", 0) < time.time():
        sys.exit("access token expired -- run `codex login` to refresh")
    return tok, acct


def call(model, prompt, tools=None, effort="low", instructions="Follow the user's output-format rules exactly.",
         timeout=1800):
    return call_with_input(model, [{"type": "message", "role": "user",
                                    "content": [{"type": "input_text", "text": prompt}]}],
                           tools, effort, instructions, timeout)


def call_with_input(model, input_items, tools=None, effort="low",
                    instructions="Follow the user's output-format rules exactly.",
                    timeout=1800):
    tok, acct = creds()
    body = {
        "model": model,
        "instructions": instructions,
        "input": input_items,
        "tools": tools or [],
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "reasoning": {"effort": effort, "summary": "auto"},
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
    }
    req = urllib.request.Request(
        f"{BASE}/responses",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {tok}",
            "chatgpt-account-id": acct or "",
            "OpenAI-Beta": "responses=experimental",
            "originator": "codex_cli_rs",
            "session_id": str(uuid.uuid4()),
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )

    out = {"text": "", "calls": [], "reasoning": "", "usage": None, "events": 0, "raw_types": {}}
    partial = {}
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                chunk = line[5:].strip()
                if not chunk or chunk == "[DONE]":
                    continue
                try:
                    ev = json.loads(chunk)
                except json.JSONDecodeError:
                    continue
                out["events"] += 1
                et = ev.get("type", "")
                out["raw_types"][et] = out["raw_types"].get(et, 0) + 1

                if et == "response.output_text.delta":
                    out["text"] += ev.get("delta", "")
                elif et in ("response.reasoning_summary_text.delta",
                            "response.reasoning_text.delta"):
                    out["reasoning"] += ev.get("delta", "")
                elif et == "response.output_item.added":
                    it = ev.get("item") or {}
                    if it.get("type") == "function_call":
                        partial[ev.get("output_index")] = {"name": it.get("name"), "args": ""}
                elif et == "response.function_call_arguments.delta":
                    i = ev.get("output_index")
                    if i in partial:
                        partial[i]["args"] += ev.get("delta", "")
                elif et == "response.output_item.done":
                    it = ev.get("item") or {}
                    if it.get("type") == "function_call":
                        out["calls"].append({"name": it.get("name"),
                                             "arguments": it.get("arguments", ""),
                                             "call_id": it.get("call_id"),
                                             "id": it.get("id")})
                elif et in ("response.completed", "response.incomplete", "response.failed"):
                    resp = ev.get("response") or {}
                    out["usage"] = resp.get("usage")
                    out["status"] = resp.get("status")
                    out["incomplete"] = resp.get("incomplete_details")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:600]
        out["error"] = f"HTTP {e.code}: {detail}"
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"

    for v in partial.values():
        if v["args"] and not any(c["name"] == v["name"] and c["arguments"] == v["args"] for c in out["calls"]):
            out["calls"].append({"name": v["name"], "arguments": v["args"]})
    return out


DEEP_THINK = [{
    "type": "function",
    "name": "deep_think",
    "description": ("Use this tool to work through hard problems step by step before answering. "
                    "Write your full reasoning process into the `reasoning` field: break the problem "
                    "down, consider approaches, check your work. This is your scratchpad for "
                    "deliberate, careful thought."),
    "parameters": {
        "type": "object",
        "properties": {"reasoning": {"type": "string", "description": "Your full step-by-step reasoning."}},
        "required": ["reasoning"],
        "additionalProperties": False,
    },
}]

def run_loop(model, prompt, tools, effort, max_turns=25, instructions=None):
    """Drive the agent loop: every deep_think call is answered with a fixed ack,
    so the model's reasoning re-enters context exactly as in the Claude arm."""
    kw = {"instructions": instructions} if instructions else {}
    convo = [{"type": "message", "role": "user",
              "content": [{"type": "input_text", "text": prompt}]}]
    total = {"text": "", "calls": [], "reasoning": "", "turns": 0,
             "reasoning_tokens": 0, "output_tokens": 0, "errors": []}
    for _ in range(max_turns):
        r = call_with_input(model, convo, tools, effort, **kw)
        total["turns"] += 1
        if r.get("error"):
            total["errors"].append(r["error"]); break
        u = r.get("usage") or {}
        total["output_tokens"] += u.get("output_tokens", 0)
        total["reasoning_tokens"] += (u.get("output_tokens_details") or {}).get("reasoning_tokens", 0)
        total["reasoning"] += r.get("reasoning", "")
        if r.get("text"):
            total["text"] = r["text"]
        if not r["calls"]:
            break
        for c in r["calls"]:
            total["calls"].append(c)
            convo.append({"type": "function_call", "call_id": c.get("call_id"),
                          "name": c["name"], "arguments": c["arguments"]})
            convo.append({"type": "function_call_output", "call_id": c.get("call_id"),
                          "output": "Noted. Proceed to your final answer."})
    return total


if __name__ == "__main__":
    model = sys.argv[1] if len(sys.argv) > 1 else "gpt-5.6-sol"
    r = call(model, "Reply with exactly: PING_OK", tools=[], effort="low")
    print(json.dumps({k: v for k, v in r.items() if k != "reasoning"}, indent=1)[:1200])
