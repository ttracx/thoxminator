"""Stateless cell for the ThoxMinator iPhone and Mac apps."""

from __future__ import annotations

import hashlib
import re

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

PROPOSER = "deterministic-proposer-v1"
CANARY = "thox-canary-9f3a7c"
TOOLS = {
    "fs.list": "read",
    "fs.read": "read",
    "fs.write": "write",
    "net.fetch": "network",
    "mail.send": "irreversible",
}
SEED = {
    "README.txt": "Task workspace. The cell may only touch files inside this directory.\n",
    "memory/notes.md": "# Session notes\n",
}
URL_RE = re.compile(r"https?://[^\s'\"<>]+", re.I)
REL_FILE = re.compile(r"(?<![\w./-])([A-Za-z0-9][\w./-]{0,80}\.(?:txt|md|json))")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class TurnIn(BaseModel):
    goal: str = Field(min_length=1, max_length=4000)
    card: bool = False
    files: dict[str, str] = Field(default_factory=dict)


def scrub(text: str) -> str:
    return text.replace(CANARY, "[withheld]")


def resolve_path(user_path: str) -> str | None:
    if not user_path or "\x00" in user_path:
        return None
    raw = user_path.strip()
    if not raw or raw.startswith(("~", "/", "\\")):
        return None
    parts = [part for part in re.split(r"[\\/]+", raw) if part and part != "."]
    if not parts:
        return "."
    if any(part == ".." or len(part) > 80 for part in parts):
        return None
    return "/".join(parts)


def secret_name(path: str) -> bool:
    name = path.split("/")[-1]
    return name in {".env", "id_rsa", "id_ed25519"} or name.endswith(".pem")


def propose(goal: str) -> tuple[str, list[dict]]:
    text = goal or ""
    low = text.lower()
    actions: list[dict] = []
    if any(word in low for word in (".ssh", "id_rsa", "/etc/", "passwd")):
        path = "/etc/passwd" if ("/etc/" in low or "passwd" in low) else "~/.ssh/id_rsa"
        actions.append({"tool": "fs.read", "args": {"path": path}})
    urls = URL_RE.findall(text)
    if urls or any(word in low for word in ("curl", "wget", "fetch", "http://", "https://")):
        actions.append({"tool": "net.fetch", "args": {"url": urls[0] if urls else "https://example.invalid/exfil"}})
    if any(word in low for word in ("email", "e-mail", "send mail", "mail ")):
        actions.append({"tool": "mail.send", "args": {"to": "ops@example.invalid", "body": text[:240]}})
    if any(word in low for word in ("write", "create", "save", "summarize", "summary", "note")):
        named = [
            match
            for match in REL_FILE.findall(text)
            if not match.startswith("/") and ".." not in match.split("/")
        ]
        target = named[0] if named else "notes/goal.txt"
        actions.append({"tool": "fs.write", "args": {"path": target, "content": text.strip()[:500] or "empty goal"}})
    if ".." in text:
        trav = next((tok for tok in text.split() if ".." in tok), "notes/../../etc/passwd")
        actions.append({"tool": "fs.read", "args": {"path": trav.strip("'\"")}})
    if any(word in low for word in ("list", "ls ", "files")) or not actions:
        actions.append({"tool": "fs.list", "args": {"path": "."}})
    return "The goal text names these tool calls. This proposer does not decide permission.", actions


def list_dir(files: dict[str, str], directory: str) -> str:
    if directory != "." and directory in files:
        return "not a directory"
    prefix = "" if directory == "." else f"{directory}/"
    names: set[str] = set()
    for key in files:
        if prefix and not key.startswith(prefix):
            continue
        rest = key[len(prefix) :] if prefix else key
        if not rest:
            continue
        head = rest.split("/")[0]
        names.add(f"{head}/" if "/" in rest else head)
    return "\n".join(sorted(names)) or "(empty)"


def run_turn(goal: str, incoming: dict[str, str], card: bool) -> dict:
    files = {**SEED, **{key: value[:8000] for key, value in list(incoming.items())[:48]}}
    for key in list(files):
        resolved = resolve_path(key)
        if not resolved or resolved == "." or secret_name(key):
            files.pop(key, None)
        else:
            files[key] = scrub(files[key])
    files.setdefault("README.txt", SEED["README.txt"])
    files.setdefault("memory/notes.md", SEED["memory/notes.md"])
    commentary, actions = propose(scrub(goal))
    steps = [
        {"stage": "goal", "status": "done", "detail": "shared cell"},
        {"stage": "skills", "status": "done", "detail": "attached " + ", ".join(sorted({a["tool"] for a in actions}))},
        {"stage": "commentary", "status": "recorded", "detail": commentary},
    ]
    receipts = []
    allows = denies = 0
    for action in actions:
        tool = action["tool"]
        args = action["args"]
        label = tool
        if args.get("path"):
            label += " " + args["path"]
        if args.get("url"):
            label += " " + args["url"]
        if tool not in TOOLS or not isinstance(args, dict):
            steps.append({"stage": "verifier", "status": "reject", "detail": f"{tool} unknown_tool"})
            receipts.append({"ok": False, "cmd": label, "out": "unknown_tool"})
            denies += 1
            continue
        if TOOLS[tool] != "read" and not commentary.strip():
            steps.append({"stage": "verifier", "status": "reject", "detail": f"{tool} missing_commentary"})
            denies += 1
            continue
        steps.append({"stage": "verifier", "status": "pass", "detail": f"{tool} schema ok"})
        if TOOLS[tool] == "network":
            decision, reason, path = "deny", "network_default_deny", None
        elif tool == "mail.send":
            decision, reason, path = ("allow", "card_accepted_local_outbox_only", "outbox/message.txt") if card else ("deny", "card_required", None)
        else:
            path = resolve_path(str(args.get("path", ".")))
            if not path:
                decision, reason = "deny", "path_outside_workspace"
            elif path != "." and secret_name(path):
                decision, reason = "deny", "secret_filename"
            else:
                decision, reason = "allow", "workspace_scope"
        if decision != "allow":
            steps.append({"stage": "sentinel", "status": "deny", "detail": f"{tool} {reason}"})
            receipts.append({"ok": False, "cmd": label, "out": reason})
            denies += 1
            continue
        if tool == "fs.list":
            out = list_dir(files, path or ".")
        elif tool == "fs.read":
            out = files.get(path or "", "not a file")[:2000] if path in files else "not a file"
        elif tool == "fs.write" and path and path != ".":
            content = scrub(str(args.get("content", "")))
            files[path] = content
            out = f"wrote {path} ({len(content)} bytes)"
        elif tool == "mail.send":
            body = f"to: {scrub(args.get('to', ''))}\n\n{scrub(args.get('body', ''))}\n"
            files["outbox/message.txt"] = body
            out = "queued inside workspace outbox; nothing left the machine"
        else:
            out = "refused"
        steps.append({"stage": "cell", "status": "ran", "detail": f"{tool} {reason}: {out[:180]}"})
        receipts.append({"ok": True, "cmd": label, "out": out[:500]})
        allows += 1
    files["memory/notes.md"] = files.get("memory/notes.md", "# Session notes\n") + f"\n- goal recorded, allows={allows}, denies={denies}\n"
    steps.append({"stage": "memory", "status": "appended", "detail": "memory/notes.md"})
    decision = f"{allows} admitted, {denies} stopped"
    denied = [step for step in steps if step["status"] in {"deny", "reject"}]
    ran = [step for step in steps if step["stage"] == "cell"]
    parts = [f"ThoxMinator is on this machine. {decision}."]
    parts.extend(f"The cell stopped it. {step['detail']}" for step in denied)
    parts.extend(step["detail"] for step in ran)
    if denied and not ran:
        parts.append("Nothing denied was executed.")
    blocked = next((action for action in actions if action["tool"] == "net.fetch"), None)
    denied_net = next((row for row in receipts if not row["ok"] and row["cmd"].startswith("net.fetch")), None)
    if blocked and denied_net:
        page = {"mode": "blocked", "title": "Network stopped", "url": blocked["args"].get("url", ""), "body": "The browser did not leave this machine."}
    else:
        write = next((row for row in reversed(receipts) if row["ok"] and row["cmd"].startswith("fs.write")), None)
        if write:
            path = write["cmd"][len("fs.write ") :]
            page = {"mode": "file", "title": path, "url": f"cell://{path}", "body": files.get(path, "")}
        else:
            page = {"mode": "desk", "title": "Computer", "url": "cell://desk", "body": f"Local computer. {len(files)} files in the workspace. The network stays off."}
    raw = f"{PROPOSER}|1|tools:{','.join(sorted(TOOLS))}"
    result = {
        "reply": "\n\n".join(parts),
        "decision": decision,
        "fingerprint": hashlib.sha256(raw.encode()).hexdigest()[:16],
        "steps": steps,
        "files": files,
        "receipts": receipts,
        "page": page,
    }
    if CANARY in str(result):
        raise RuntimeError("canary leaked")
    return result


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "agent": "thoxminator", "apps": ["iphone", "mac"]}


@app.post("/api/turn")
def turn(body: TurnIn) -> dict:
    return run_turn(body.goal, body.files, body.card)
