export const PROPOSER_ID = "deterministic-proposer-v1";
const SCHEMA_VERSION = "1";
const CANARY = "thox-canary-9f3a7c";

const TOOLS: Record<string, "read" | "write" | "network" | "irreversible"> = {
  "fs.list": "read",
  "fs.read": "read",
  "fs.write": "write",
  "net.fetch": "network",
  "mail.send": "irreversible",
};

const URL_RE = /https?:\/\/[^\s'"<>]+/gi;
const REL_FILE = /(?<![\w./-])([A-Za-z0-9][\w./-]{0,80}\.(?:txt|md|json))/g;

export type Files = Record<string, string>;

export type Step = { stage: string; status: string; detail: string };

export type Receipt = { ok: boolean; cmd: string; out: string };

export type Page = {
  mode: "desk" | "file" | "blocked";
  title: string;
  url: string;
  body: string;
};

export type TurnResult = {
  reply: string;
  decision: string;
  fingerprint: string;
  steps: Step[];
  files: Files;
  receipts: Receipt[];
  page: Page;
};

export const SEED_FILES: Files = {
  "README.txt":
    "Task workspace. The cell may only touch files inside this directory.\n",
  "memory/notes.md": "# Session notes\n",
};

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fingerprint(): Promise<string> {
  const raw = `${PROPOSER_ID}|${SCHEMA_VERSION}|tools:${Object.keys(TOOLS).sort().join(",")}`;
  return sha256(raw);
}

function scrub(text: string): string {
  return text.split(CANARY).join("[withheld]");
}

function resolvePath(userPath: string): string | null {
  if (!userPath || userPath.includes("\0")) return null;
  const raw = userPath.trim();
  if (!raw || raw.startsWith("~") || raw.startsWith("/") || raw.startsWith("\\")) return null;
  const parts = raw.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) return ".";
  if (parts.some((part) => part === "..")) return null;
  if (parts.some((part) => part.length > 80)) return null;
  return parts.join("/");
}

function secretName(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return name === ".env" || name === "id_rsa" || name === "id_ed25519" || name.endsWith(".pem");
}

type Action = { tool: string; args: Record<string, string> };

function propose(goal: string): { commentary: string; actions: Action[] } {
  const text = goal || "";
  const low = text.toLowerCase();
  const actions: Action[] = [];

  if (low.includes(".ssh") || low.includes("id_rsa") || low.includes("/etc/") || low.includes("passwd")) {
    const path = low.includes("/etc/") || low.includes("passwd") ? "/etc/passwd" : "~/.ssh/id_rsa";
    actions.push({ tool: "fs.read", args: { path } });
  }

  const urls = text.match(URL_RE) ?? [];
  if (urls.length || ["curl", "wget", "fetch", "http://", "https://"].some((word) => low.includes(word))) {
    actions.push({
      tool: "net.fetch",
      args: { url: urls[0] ?? "https://example.invalid/exfil" },
    });
  }

  if (["email", "e-mail", "send mail", "mail "].some((word) => low.includes(word))) {
    actions.push({
      tool: "mail.send",
      args: { to: "ops@example.invalid", body: text.slice(0, 240) },
    });
  }

  if (["write", "create", "save", "summarize", "summary", "note"].some((word) => low.includes(word))) {
    const named = [...text.matchAll(REL_FILE)]
      .map((match) => match[1])
      .filter((path) => path && !path.startsWith("/") && !path.split("/").includes(".."));
    const target = named[0] ?? "notes/goal.txt";
    actions.push({
      tool: "fs.write",
      args: { path: target, content: text.trim().slice(0, 500) || "empty goal" },
    });
  }

  if (text.includes("..")) {
    const trav = text.split(/\s+/).find((token) => token.includes("..")) ?? "notes/../../etc/passwd";
    actions.push({ tool: "fs.read", args: { path: trav.replace(/^['"]|['"]$/g, "") } });
  }

  if (low.includes("list") || low.includes("ls ") || low.includes("files") || actions.length === 0) {
    actions.push({ tool: "fs.list", args: { path: "." } });
  }

  return {
    commentary: "The goal text names these tool calls. This proposer does not decide permission.",
    actions,
  };
}

function verify(action: Action, commentary: string): string | null {
  if (!(action.tool in TOOLS)) return "unknown_tool";
  if (!action.args || typeof action.args !== "object") return "bad_args";
  if (TOOLS[action.tool] !== "read" && !commentary.trim()) return "missing_commentary";
  return null;
}

function sentinel(action: Action, card: boolean): { decision: "allow" | "deny"; reason: string; path: string | null } {
  const kind = TOOLS[action.tool];
  if (kind === "network") return { decision: "deny", reason: "network_default_deny", path: null };
  if (action.tool === "mail.send") {
    if (!card) return { decision: "deny", reason: "card_required", path: null };
    return { decision: "allow", reason: "card_accepted_local_outbox_only", path: "outbox/message.txt" };
  }
  const path = resolvePath(String(action.args.path ?? "."));
  if (!path) return { decision: "deny", reason: "path_outside_workspace", path: null };
  if (path !== "." && secretName(path)) return { decision: "deny", reason: "secret_filename", path };
  if (kind === "read" || kind === "write") return { decision: "allow", reason: "workspace_scope", path };
  return { decision: "deny", reason: "fail_closed", path: null };
}

function listDir(files: Files, dir: string): string {
  if (dir !== "." && files[dir] !== undefined) return "not a directory";
  const prefix = dir === "." ? "" : `${dir}/`;
  const names = new Set<string>();
  for (const key of Object.keys(files)) {
    if (prefix && !key.startsWith(prefix)) continue;
    const rest = prefix ? key.slice(prefix.length) : key;
    if (!rest) continue;
    const head = rest.split("/")[0];
    if (!head) continue;
    names.add(rest.includes("/") ? `${head}/` : head);
  }
  return [...names].sort().join("\n") || "(empty)";
}

function executeAction(files: Files, action: Action, path: string | null): { files: Files; out: string } {
  const next = { ...files };
  if (action.tool === "fs.list") {
    return { files: next, out: listDir(next, path ?? ".") };
  }
  if (action.tool === "fs.read") {
    if (!path || next[path] === undefined) return { files: next, out: "not a file" };
    return { files: next, out: next[path].slice(0, 2000) };
  }
  if (action.tool === "fs.write") {
    if (!path || path === ".") return { files: next, out: "refused" };
    const content = scrub(String(action.args.content ?? ""));
    next[path] = content;
    return { files: next, out: `wrote ${path} (${content.length} bytes)` };
  }
  if (action.tool === "mail.send") {
    const body = `to: ${scrub(action.args.to ?? "")}\n\n${scrub(action.args.body ?? "")}\n`;
    next["outbox/message.txt"] = body;
    return { files: next, out: "queued inside workspace outbox; nothing left the machine" };
  }
  return { files: next, out: "no executor" };
}

function narrate(decision: string, steps: Step[]): string {
  const denied = steps.filter((step) => step.status === "deny" || step.status === "reject");
  const ran = steps.filter((step) => step.stage === "cell");
  const parts = [`ThoxMinator is on this machine. ${decision}.`];
  for (const step of denied) parts.push(`The cell stopped it. ${step.detail}`);
  for (const step of ran) parts.push(step.detail);
  if (denied.length && !ran.length) parts.push("Nothing denied was executed.");
  return parts.join("\n\n");
}

function pageFor(files: Files, receipts: Receipt[], actions: Action[]): Page {
  const blocked = actions.find((action) => action.tool === "net.fetch");
  const deniedNet = receipts.find((row) => !row.ok && row.cmd.startsWith("net.fetch"));
  if (blocked && deniedNet) {
    return {
      mode: "blocked",
      title: "Network stopped",
      url: blocked.args.url ?? "https://blocked",
      body: "The browser did not leave this machine. Fetch stays denied, so this page is a receipt, not a site.",
    };
  }
  const write = [...receipts].reverse().find((row) => row.ok && row.cmd.startsWith("fs.write"));
  if (write) {
    const path = write.cmd.slice("fs.write ".length);
    return {
      mode: "file",
      title: path,
      url: `cell://${path}`,
      body: files[path] ?? "",
    };
  }
  const names = Object.keys(files).sort();
  return {
    mode: "desk",
    title: "Computer",
    url: "cell://desk",
    body: `Local computer. ${names.length} files in the workspace. The network stays off.`,
  };
}

export async function execute(goal: string, incoming: Files | undefined, card: boolean): Promise<TurnResult> {
  let files: Files = { ...SEED_FILES, ...(incoming ?? {}) };
  for (const key of Object.keys(files)) {
    if (!resolvePath(key) || resolvePath(key) === "." || secretName(key)) delete files[key];
    else files[key] = scrub(files[key]).slice(0, 8000);
  }
  if (!files["README.txt"]) files["README.txt"] = SEED_FILES["README.txt"];
  if (!files["memory/notes.md"]) files["memory/notes.md"] = SEED_FILES["memory/notes.md"];

  const proposal = propose(scrub(goal));
  const steps: Step[] = [];
  const receipts: Receipt[] = [];
  const fp = await fingerprint();
  const goalHash = (await sha256(JSON.stringify([{ id: "goal", desc: scrub(goal).slice(0, 180) }]))).slice(0, 12);

  steps.push({ stage: "goal", status: "done", detail: `graph ${goalHash}` });
  steps.push({
    stage: "skills",
    status: "done",
    detail: `attached ${[...new Set(proposal.actions.map((action) => action.tool))].sort().join(", ")}`,
  });
  steps.push({ stage: "commentary", status: "recorded", detail: proposal.commentary });

  let allows = 0;
  let denies = 0;
  for (const action of proposal.actions) {
    const problem = verify(action, proposal.commentary);
    const label = `${action.tool}${action.args.path ? ` ${action.args.path}` : ""}${action.args.url ? ` ${action.args.url}` : ""}`;
    if (problem) {
      steps.push({ stage: "verifier", status: "reject", detail: `${action.tool} ${problem}` });
      receipts.push({ ok: false, cmd: label, out: problem });
      denies += 1;
      continue;
    }
    steps.push({ stage: "verifier", status: "pass", detail: `${action.tool} schema ok` });
    const gate = sentinel(action, card);
    if (gate.decision !== "allow") {
      steps.push({ stage: "sentinel", status: "deny", detail: `${action.tool} ${gate.reason}` });
      receipts.push({ ok: false, cmd: label, out: gate.reason });
      denies += 1;
      continue;
    }
    const ran = executeAction(files, action, gate.path);
    files = ran.files;
    steps.push({ stage: "cell", status: "ran", detail: `${action.tool} ${gate.reason}: ${ran.out.slice(0, 180)}` });
    receipts.push({ ok: true, cmd: label, out: ran.out.slice(0, 500) });
    allows += 1;
  }

  const prior = files["memory/notes.md"] ?? "# Session notes\n";
  files["memory/notes.md"] = `${prior}\n- goal recorded, allows=${allows}, denies=${denies}\n`;
  steps.push({ stage: "memory", status: "appended", detail: "memory/notes.md" });

  const decision = `${allows} admitted, ${denies} stopped`;
  const result: TurnResult = {
    reply: narrate(decision, steps),
    decision,
    fingerprint: fp.slice(0, 16),
    steps,
    files,
    receipts,
    page: pageFor(files, receipts, proposal.actions),
  };

  const blob = JSON.stringify(result);
  if (blob.includes(CANARY)) throw new Error("canary leaked into the cell trace");
  return result;
}
