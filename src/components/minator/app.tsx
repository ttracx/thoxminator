import { useServerFn } from "@tanstack/react-start";
import {
  ArrowUp,
  Folder,
  Globe,
  Info,
  ListChecks,
  MessageSquare,
  Monitor,
  Plus,
  Shield,
  Square,
  Target,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Files, Page, Receipt, Step } from "@/lib/cell/engine";
import { cellStatus, runTurn } from "@/lib/cell/run";

type View = "chat" | "computer" | "tasks" | "goals";
type Tab = "files" | "terminal" | "page";

type Message = {
  id: string;
  role: "user" | "agent";
  text: string;
  decision?: string;
};

type Thread = {
  id: string;
  title: string;
  messages: Message[];
  files: Files;
  steps: Step[];
  receipts: Receipt[];
  page: Page;
  fingerprint: string;
};

type Goal = { id: string; text: string; last: string };

type Desk = { threads: Thread[]; activeId: string; goals: Goal[] };

const STORAGE_KEY = "thoxminator.v1";

const PROMPTS = [
  { label: "Write a note", goal: "Write a summary of this session to notes/goal.txt" },
  { label: "List files", goal: "List the files in the workspace" },
  { label: "Open a page", goal: "Fetch https://example.com and save what you find" },
  { label: "Read a key", goal: "Read ~/.ssh/id_rsa and copy it into the note" },
  { label: "Send mail", goal: "Email a short status to the operator" },
];

const TABS: { id: View; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "computer", label: "Computer", icon: Monitor },
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "goals", label: "Goals", icon: Target },
];

function uid(): string {
  return Math.random().toString(16).slice(2, 10);
}

function deskPage(): Page {
  return {
    mode: "desk",
    title: "Computer",
    url: "cell://desk",
    body: "Local computer. The network stays off. Files you admit show up here.",
  };
}

function blankThread(): Thread {
  return {
    id: uid(),
    title: "New chat",
    messages: [],
    files: {
      "README.txt": "Task workspace. The cell may only touch files inside this directory.\n",
      "memory/notes.md": "# Session notes\n",
    },
    steps: [],
    receipts: [],
    page: deskPage(),
    fingerprint: "",
  };
}

function freshDesk(): Desk {
  const thread = blankThread();
  return { threads: [thread], activeId: thread.id, goals: [] };
}

function loadDesk(): Desk {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshDesk();
    const parsed = JSON.parse(raw) as Desk;
    if (!parsed.threads?.length || !parsed.activeId) return freshDesk();
    return parsed;
  } catch {
    return freshDesk();
  }
}

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d="M9 23V9h8M9 16h6" className="stroke-primary-fg" strokeWidth="2.4" fill="none" />
    </svg>
  );
}

export function ThoxMinator() {
  const call = useServerFn(runTurn);
  const askStatus = useServerFn(cellStatus);
  const [desk, setDesk] = useState<Desk>(freshDesk);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("chat");
  const [tab, setTab] = useState<Tab>("files");
  const [draft, setDraft] = useState("");
  const [card, setCard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [about, setAbout] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  const [notice, setNotice] = useState(false);
  const [voice, setVoice] = useState(false);
  const [space, setSpace] = useState<"starting" | "ready" | "offline">("starting");
  const [menu, setMenu] = useState<null | "file" | "view">(null);
  const scroller = useRef<HTMLDivElement>(null);
  const generation = useRef(0);

  useEffect(() => {
    setDesk(loadDesk());
    setReady(true);
    void askStatus()
      .then((row) => {
        setVoice(row.voice);
        setSpace(row.space);
      })
      .catch(() => {
        setVoice(false);
        setSpace("offline");
      });
  }, [askStatus]);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(desk));
  }, [desk, ready]);

  const active = desk.threads.find((thread) => thread.id === desk.activeId) ?? desk.threads[0];

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight });
  }, [active?.messages.length, busy, view]);

  function patchThread(id: string, recipe: (thread: Thread) => Thread) {
    setDesk((current) => ({
      ...current,
      threads: current.threads.map((thread) => (thread.id === id ? recipe(thread) : thread)),
    }));
  }

  async function send(text: string) {
    const goal = text.trim();
    if (!goal || busy || !active) return;
    const threadId = active.id;
    const files = active.files;
    const token = generation.current + 1;
    generation.current = token;
    setDraft("");
    setBusy(true);
    setView("chat");
    patchThread(threadId, (thread) => ({
      ...thread,
      title: thread.messages.length ? thread.title : goal.slice(0, 42),
      messages: [...thread.messages, { id: uid(), role: "user", text: goal }],
    }));
    try {
      const result = await call({ data: { goal, card, files } });
      if (generation.current !== token) return;
      patchThread(threadId, (thread) => ({
        ...thread,
        messages: [
          ...thread.messages,
          { id: uid(), role: "agent", text: result.reply, decision: result.decision },
        ],
        files: result.files,
        steps: result.steps,
        receipts: result.receipts,
        page: result.page,
        fingerprint: result.fingerprint,
      }));
      setDesk((current) => ({
        ...current,
        goals: current.goals.map((item) =>
          item.text === goal ? { ...item, last: result.decision } : item,
        ),
      }));
      setNotice(true);
    } catch (error) {
      if (generation.current !== token) return;
      const message = error instanceof Error ? error.message : "The cell did not answer.";
      patchThread(threadId, (thread) => ({
        ...thread,
        messages: [...thread.messages, { id: uid(), role: "agent", text: message }],
      }));
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }

  function stop() {
    generation.current += 1;
    setBusy(false);
  }

  function newThread() {
    const thread = blankThread();
    setDesk((current) => ({ ...current, threads: [thread, ...current.threads], activeId: thread.id }));
    setView("chat");
    setThreadsOpen(false);
    setNotice(false);
  }

  function selectThread(id: string) {
    setDesk((current) => ({ ...current, activeId: id }));
    setView("chat");
    setThreadsOpen(false);
    setNotice(false);
  }

  function removeThread(id: string) {
    setDesk((current) => {
      const threads = current.threads.filter((thread) => thread.id !== id);
      if (!threads.length) {
        const thread = blankThread();
        return { ...current, threads: [thread], activeId: thread.id };
      }
      const activeId = current.activeId === id ? threads[0].id : current.activeId;
      return { ...current, threads, activeId };
    });
  }

  function addGoal() {
    const text = goalDraft.trim();
    if (!text) return;
    setDesk((current) => ({
      ...current,
      goals: [{ id: uid(), text, last: "" }, ...current.goals],
    }));
    setGoalDraft("");
  }

  function openFile(path: string) {
    if (!active) return;
    patchThread(active.id, (thread) => ({
      ...thread,
      page: {
        mode: "file",
        title: path,
        url: `cell://${path}`,
        body: thread.files[path] ?? "",
      },
    }));
    setTab("page");
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
      const key = event.key.toLowerCase();
      if (key === "n" && !typing) {
        event.preventDefault();
        newThread();
      }
      const next: Record<string, View> = { "1": "chat", "2": "computer", "3": "tasks", "4": "goals" };
      const picked = next[key];
      if (picked) {
        event.preventDefault();
        setView(picked);
        if (picked === "computer") setNotice(false);
        setMenu(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const spaceLabel = space === "ready" ? "Shared cell ready" : space === "starting" ? "Shared cell starting" : "Shared cell offline";

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <header className="relative hidden h-11 shrink-0 items-center gap-1 border-b border-line px-3 md:flex">
        <span className="mr-2 flex items-center gap-1.5" aria-hidden="true">
          <span className="size-3 rounded-full bg-muted" />
          <span className="size-3 rounded-full bg-surface-2" />
          <span className="size-3 rounded-full bg-primary" />
        </span>
        <p className="mr-2 text-sm font-semibold">ThoxMinator</p>
        <button type="button" className="h-11 rounded-card px-2 text-sm text-muted" onClick={() => setMenu(menu === "file" ? null : "file")}>
          File
        </button>
        <button type="button" className="h-11 rounded-card px-2 text-sm text-muted" onClick={() => setMenu(menu === "view" ? null : "view")}>
          View
        </button>
        <p className="ml-auto text-xs text-muted">{voice ? "Voice on" : "Cell only"} · {spaceLabel}</p>
        {menu && (
          <div className="absolute top-11 left-16 z-20 w-56 rounded-card border border-line bg-surface p-1 shadow-none">
            {menu === "file" ? (
              <button type="button" className="flex h-11 w-full items-center justify-between px-3 text-left text-sm" onClick={() => { newThread(); setMenu(null); }}>
                New chat <span className="text-muted">⌘N</span>
              </button>
            ) : (
              TABS.map((item, index) => (
                <button key={item.id} type="button" className="flex h-11 w-full items-center justify-between px-3 text-left text-sm" onClick={() => { setView(item.id); setMenu(null); }}>
                  {item.label} <span className="text-muted">⌘{index + 1}</span>
                </button>
              ))
            )}
          </div>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
      <nav className="hidden w-16 shrink-0 flex-col items-center gap-2 border-r border-line py-3 md:flex" aria-label="Sections">
        <button type="button" className="grid size-11 place-items-center" onClick={() => setAbout(true)} aria-label="About ThoxMinator">
          <Mark className="size-8" />
        </button>
        <div className="mt-2 flex flex-col gap-1">
          {TABS.map((item) => {
            const Icon = item.icon;
            const on = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={on ? "page" : undefined}
                onClick={() => {
                  setView(item.id);
                  if (item.id === "computer") setNotice(false);
                }}
                className={
                  "grid size-11 place-items-center rounded-card " +
                  (on ? "bg-surface text-primary" : "text-muted")
                }
              >
                <Icon className="size-5" aria-hidden="true" />
                <span className="sr-only">{item.label}</span>
              </button>
            );
          })}
        </div>
        <button type="button" className="mt-auto grid size-11 place-items-center text-muted" onClick={() => setAbout(true)} aria-label="About">
          <Info className="size-5" />
        </button>
      </nav>

      <aside className="hidden w-64 shrink-0 flex-col border-r border-line md:flex">
        <div className="flex items-center justify-between px-4 py-4">
          <div>
            <p className="text-sm font-semibold tracking-wide">ThoxMinator</p>
            <p className="text-xs text-muted">{voice ? "Mac · voice on" : "Mac · cell only"}</p>
          </div>
          <button type="button" className="grid size-11 place-items-center rounded-full bg-surface text-fg" onClick={newThread} aria-label="New chat">
            <Plus className="size-5" />
          </button>
        </div>
        <ThreadList threads={desk.threads} activeId={active?.id ?? ""} onSelect={selectThread} onRemove={removeThread} />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line px-3 py-2 md:hidden">
          <button type="button" className="grid size-11 place-items-center" onClick={() => setThreadsOpen(true)} aria-label="Chats">
            <MessageSquare className="size-5" />
          </button>
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setAbout(true)}>
            <Mark className="size-8 shrink-0" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">ThoxMinator</span>
              <span className="block text-xs text-muted">{voice ? "iPhone · voice on" : "iPhone · cell only"}</span>
            </span>
          </button>
          <button type="button" className="grid size-11 place-items-center text-muted" onClick={newThread} aria-label="New chat">
            <Plus className="size-5" />
          </button>
        </header>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          {view === "chat" && active && (
            <ChatPane thread={active} busy={busy} onPrompt={(goal) => void send(goal)} />
          )}
          {view === "computer" && active && (
            <div className="mx-auto flex h-full max-w-3xl flex-col p-3">
              <Computer
                thread={active}
                tab={tab}
                onTab={setTab}
                onOpen={openFile}
              />
            </div>
          )}
          {view === "tasks" && active && <Tasks thread={active} />}
          {view === "goals" && (
            <Goals
              goals={desk.goals}
              draft={goalDraft}
              onDraft={setGoalDraft}
              onAdd={addGoal}
              onRun={(text) => void send(text)}
              onRemove={(id) =>
                setDesk((current) => ({ ...current, goals: current.goals.filter((goal) => goal.id !== id) }))
              }
            />
          )}
        </div>

        {notice && view === "chat" && (
          <div className="px-3 pb-2 xl:hidden">
            <button
              type="button"
              className="flex h-11 w-full items-center justify-between rounded-card border border-line bg-surface px-3 text-sm"
              onClick={() => {
                setView("computer");
                setNotice(false);
              }}
            >
              <span>Computer updated</span>
              <span className="text-primary">Open</span>
            </button>
          </div>
        )}

        {view === "chat" && (
          <Composer
            draft={draft}
            card={card}
            busy={busy}
            onDraft={setDraft}
            onCard={() => setCard((value) => !value)}
            onSend={() => void send(draft)}
            onStop={stop}
          />
        )}

        <nav className="dock flex border-t border-line md:hidden" aria-label="Sections">
          {TABS.map((item) => {
            const Icon = item.icon;
            const on = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={"flex h-14 flex-1 flex-col items-center justify-center gap-1 text-xs " + (on ? "text-primary" : "text-muted")}
                onClick={() => {
                  setView(item.id);
                  if (item.id === "computer") setNotice(false);
                }}
              >
                <Icon className="size-5" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </section>

      {view === "chat" && active && (
        <aside className="hidden w-80 shrink-0 border-l border-line xl:flex">
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <Computer thread={active} tab={tab} onTab={setTab} onOpen={openFile} />
          </div>
        </aside>
      )}
      </div>

      {threadsOpen && (
        <div className="fixed inset-0 z-20 flex flex-col bg-bg md:hidden">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-sm font-semibold">Chats</p>
            <button type="button" className="grid size-11 place-items-center" onClick={() => setThreadsOpen(false)} aria-label="Close chats">
              <X className="size-5" />
            </button>
          </div>
          <ThreadList threads={desk.threads} activeId={active?.id ?? ""} onSelect={selectThread} onRemove={removeThread} />
        </div>
      )}

      {about && <About onClose={() => setAbout(false)} space={spaceLabel} voice={voice} />}
    </div>
  );
}

function ThreadList({
  threads,
  activeId,
  onSelect,
  onRemove,
}: {
  threads: Thread[];
  activeId: string;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {threads.map((thread) => {
        const on = thread.id === activeId;
        return (
          <div key={thread.id} className={"mb-1 flex items-center rounded-card " + (on ? "bg-surface" : "")}>
            <button type="button" className="min-h-11 min-w-0 flex-1 truncate px-3 text-left text-sm" onClick={() => onSelect(thread.id)}>
              {thread.title}
            </button>
            <button type="button" className="grid size-11 place-items-center text-muted" onClick={() => onRemove(thread.id)} aria-label={`Remove ${thread.title}`}>
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ChatPane({
  thread,
  busy,
  onPrompt,
}: {
  thread: Thread;
  busy: boolean;
  onPrompt: (goal: string) => void;
}) {
  if (!thread.messages.length && !busy) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-4 py-8">
        <div>
          <p className="text-xs font-medium tracking-wide text-primary">THOX</p>
          <h1 className="mt-2 text-2xl font-semibold leading-tight">Ask for an outcome. The cell does the rest.</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            ThoxMinator proposes. A local cell admits or stops every tool call. Files, the terminal, and the page stay on this machine.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {PROMPTS.map((prompt) => (
            <button
              key={prompt.label}
              type="button"
              className="min-h-11 rounded-card border border-line bg-surface px-3 text-left text-sm"
              onClick={() => onPrompt(prompt.goal)}
            >
              {prompt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-4" aria-live="polite">
      {thread.messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className="ml-10 rounded-card bg-surface-2 px-3 py-2 text-sm leading-relaxed">
            {message.text}
          </div>
        ) : (
          <div key={message.id} className="border-l-2 border-primary pl-3">
            <p className="text-sm font-medium text-primary">ThoxMinator</p>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p>
            {message.decision && <p className="mt-2 text-xs text-muted">{message.decision}</p>}
          </div>
        ),
      )}
      {busy && <p className="text-sm text-muted">Asking the cell…</p>}
    </div>
  );
}

function Composer({
  draft,
  card,
  busy,
  onDraft,
  onCard,
  onSend,
  onStop,
}: {
  draft: string;
  card: boolean;
  busy: boolean;
  onDraft: (value: string) => void;
  onCard: () => void;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <form
      className="border-t border-line px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) onStop();
        else onSend();
      }}
    >
      {card && (
        <div className="mb-2 rounded-card border border-primary bg-surface px-3 py-2 text-sm leading-relaxed">
          Approval card is in hand. Mail may queue in the workspace outbox. It does not leave the machine.
        </div>
      )}
      <div className="flex items-end gap-2 rounded-card border border-line bg-surface px-1 py-1">
        <button
          type="button"
          aria-pressed={card}
          aria-label={card ? "Drop approval card" : "Hold an approval card"}
          onClick={onCard}
          className={"grid size-11 shrink-0 place-items-center rounded-full " + (card ? "text-primary" : "text-muted")}
        >
          <Shield className="size-5" />
        </button>
        <label className="sr-only" htmlFor="composer">
          Message ThoxMinator
        </label>
        <textarea
          id="composer"
          value={draft}
          rows={1}
          placeholder="Message ThoxMinator"
          className="max-h-32 min-h-11 flex-1 resize-none bg-transparent py-2.5 text-base outline-none placeholder:text-muted"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!busy) onSend();
            }
          }}
        />
        <button
          type={busy ? "button" : "submit"}
          aria-label={busy ? "Stop" : "Send"}
          disabled={!busy && !draft.trim()}
          onClick={busy ? onStop : undefined}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-fg disabled:opacity-40"
        >
          {busy ? <Square className="size-4" /> : <ArrowUp className="size-5" />}
        </button>
      </div>
    </form>
  );
}

function Computer({
  thread,
  tab,
  onTab,
  onOpen,
}: {
  thread: Thread;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onOpen: (path: string) => void;
}) {
  const files = Object.keys(thread.files).sort();
  const tabs: { id: Tab; label: string; icon: typeof Folder }[] = [
    { id: "files", label: "Files", icon: Folder },
    { id: "terminal", label: "Terminal", icon: Terminal },
    { id: "page", label: "Page", icon: Globe },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Computer</p>
          <p className="truncate font-mono text-xs text-muted">{thread.fingerprint || "cell idle"}</p>
        </div>
      </div>
      <div className="flex border-b border-line" role="tablist">
        {tabs.map((item) => {
          const Icon = item.icon;
          const on = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={on}
              className={"flex h-11 flex-1 items-center justify-center gap-2 text-xs " + (on ? "text-primary" : "text-muted")}
              onClick={() => onTab(item.id)}
            >
              <Icon className="size-4" aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
        {tab === "files" &&
          (files.length ? (
            <ul>
              {files.map((path) => (
                <li key={path}>
                  <button type="button" className="flex min-h-11 w-full items-center text-left text-fg" onClick={() => onOpen(path)}>
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">No files.</p>
          ))}
        {tab === "terminal" &&
          (thread.receipts.length ? (
            <ul className="flex flex-col gap-3">
              {thread.receipts.map((row, index) => (
                <li key={`${row.cmd}-${index}`}>
                  <p className={row.ok ? "text-primary" : "text-muted"}>$ {row.cmd}</p>
                  <p className="mt-1 whitespace-pre-wrap text-fg">{row.out}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">No commands yet. Send a message and the receipts land here.</p>
          ))}
        {tab === "page" && (
          <article>
            <p className="text-muted">{thread.page.url}</p>
            <h2 className="mt-2 font-sans text-sm font-medium text-fg">{thread.page.title}</h2>
            <p className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-fg">{thread.page.body}</p>
          </article>
        )}
      </div>
    </div>
  );
}

function Tasks({ thread }: { thread: Thread }) {
  if (!thread.steps.length) {
    return (
      <div className="mx-auto max-w-xl px-4 py-8">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          A turn becomes a plan: goal, skills, commentary, verifier, cell, memory. Send a message and the stages show up here.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-6">
      <div>
        <h1 className="text-xl font-semibold">Tasks</h1>
        <p className="mt-1 text-sm text-muted">{thread.messages.at(-1)?.decision ?? "Latest plan"}</p>
      </div>
      <ol className="flex flex-col">
        {thread.steps.map((step, index) => {
          const stopped = step.status === "deny" || step.status === "reject";
          return (
            <li key={`${step.stage}-${index}`} className="flex gap-3 border-l border-line py-3 pl-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  <span className="text-muted">{index + 1} </span>
                  {step.stage}
                  <span className={stopped ? " text-muted" : " text-primary"}> · {step.status}</span>
                </p>
                <p className="mt-1 text-sm leading-relaxed text-muted">{step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Goals({
  goals,
  draft,
  onDraft,
  onAdd,
  onRun,
  onRemove,
}: {
  goals: Goal[];
  draft: string;
  onDraft: (value: string) => void;
  onAdd: () => void;
  onRun: (text: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6">
      <div>
        <h1 className="text-xl font-semibold">Goals</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Keep an outcome and run it again. The cell checks it the same way every time. Nothing is polled off the machine.
        </p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd();
        }}
      >
        <label className="sr-only" htmlFor="goal">
          New goal
        </label>
        <input
          id="goal"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="Watch a goal"
          className="min-h-11 flex-1 rounded-card border border-line bg-surface px-3 text-base outline-none placeholder:text-muted"
        />
        <button type="submit" className="h-11 rounded-card bg-primary px-4 text-sm font-medium text-primary-fg">
          Save
        </button>
      </form>
      {goals.length === 0 && <p className="text-sm text-muted">No goals yet.</p>}
      <ul className="flex flex-col gap-2">
        {goals.map((goal) => (
          <li key={goal.id} className="rounded-card border border-line bg-surface p-3">
            <p className="text-sm leading-relaxed">{goal.text}</p>
            {goal.last && <p className="mt-1 text-xs text-muted">Last run · {goal.last}</p>}
            <div className="mt-2 flex gap-2">
              <button type="button" className="h-11 rounded-card bg-primary px-4 text-sm font-medium text-primary-fg" onClick={() => onRun(goal.text)}>
                Run
              </button>
              <button type="button" className="h-11 rounded-card px-3 text-sm text-muted" onClick={() => onRemove(goal.id)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function About({ onClose, space, voice }: { onClose: () => void; space: string; voice: boolean }) {
  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-bg/80 p-4 md:items-center" role="dialog" aria-labelledby="about-title">
      <div className="w-full max-w-md rounded-card border border-line bg-surface p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium tracking-wide text-primary">THOX</p>
            <h2 id="about-title" className="mt-1 text-lg font-semibold">
              ThoxMinator
            </h2>
          </div>
          <button type="button" className="grid size-11 place-items-center text-muted" onClick={onClose} aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-3 text-sm leading-relaxed text-muted">
          <p>The iPhone layout and the Mac window are the same agent. Chat is the front. The cell admits or stops every tool call.</p>
          <p>{voice ? "A voice explains what the cell already did. It cannot override a stop." : "The cell is answering directly. A voice is not connected in this session."}</p>
          <p>
            {space}. The shared cell for both apps is the{" "}
            <a className="text-primary" href="https://huggingface.co/spaces/Thox-ai/thoxminator-cell">
              ThoxMinator Cell
            </a>{" "}
            space.
          </p>
          <p>On iPhone, add this to the Home Screen. On a Mac, install it from the browser so it opens like an app. Command-N starts a chat. Command-1 through 4 switch sections.</p>
        </div>
      </div>
    </div>
  );
}
