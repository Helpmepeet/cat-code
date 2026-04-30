import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWebSocket, type WebUIIncomingEvent } from "./hooks/useWebSocket";
import { MessageContent } from "./components/MessageContent";

type Role = "user" | "assistant" | "system";

type Message = {
  id: string;
  role: Role;
  content: string;
};

type StatusState = {
  connected: boolean;
  reconnecting: boolean;
  model?: string;
  effort?: string;
  contextTokens?: number;
  activeProfile?: string;
  inputEnabled: boolean;
  notice?: string;
};

const DRAFT_STORAGE_KEY = "cat-code:web:draft";

function messageId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function JumpToLatestButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pointer-events-auto rounded-full border border-white/12 bg-zinc-900/95 px-4 py-2 text-sm text-zinc-100 shadow-[0_12px_40px_rgba(0,0,0,0.45)] transition-all ${
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0"
      }`}
    >
      Jump to latest
    </button>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center px-6 pb-24 pt-16 text-center">
      <div className="max-w-md space-y-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-pink-300/75">
          Cat Code
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">
          Browser chat, same session feel.
        </h1>
        <p className="text-sm leading-7 text-zinc-400">
          The web UI mirrors the terminal flow, but with room to read, scroll,
          and come back later.
        </p>
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  return (
    <article
      className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`w-full max-w-full ${
          isUser ? "items-end" : "items-start"
        } flex flex-col gap-2`}
      >
        <span className="px-1 text-[11px] font-medium uppercase tracking-[0.24em] text-zinc-500">
          {message.role}
        </span>
        <div
          className={`w-full rounded-3xl border px-5 py-4 shadow-[0_22px_70px_rgba(0,0,0,0.28)] ${
            isUser
              ? "border-pink-400/20 bg-pink-500/[0.08] text-zinc-50"
              : isSystem
                ? "border-white/8 bg-white/[0.03] text-zinc-400"
                : "border-white/10 bg-white/[0.04] text-zinc-100"
          }`}
        >
          <MessageContent content={message.content} role={message.role} />
        </div>
      </div>
    </article>
  );
}

function FooterChip({
  label,
  value,
}: {
  label: string;
  value?: string | number;
}) {
  if (value === undefined || value === "") return null;

  return (
    <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-300">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-100">{value}</span>
    </div>
  );
}

function formatTokenCount(value?: number) {
  if (value === undefined) return undefined;
  return new Intl.NumberFormat("en", {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  })
    .format(value)
    .toLowerCase()
    .replace(".0", "");
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(DRAFT_STORAGE_KEY) ?? "";
  });
  const [status, setStatus] = useState<StatusState>({
    connected: false,
    reconnecting: true,
    inputEnabled: false,
  });
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  useEffect(() => {
    window.localStorage.setItem(DRAFT_STORAGE_KEY, input);
  }, [input]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setShowJumpToLatest(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 24;
    shouldStickToBottomRef.current = atBottom;
    if (atBottom) {
      setShowJumpToLatest(false);
    }
  }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    if (shouldStickToBottomRef.current) {
      scrollToLatest(messages.length <= 1 ? "auto" : "smooth");
      return;
    }

    setShowJumpToLatest(true);
  }, [messages, scrollToLatest]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const onMessage = useCallback((data: WebUIIncomingEvent) => {
    if (data.type === "message" && data.message) {
      setMessages((prev) => {
        const role = (data.message.role as Role) ?? "assistant";
        const content = data.message.content ?? "";
        if (data.message.replaceLast) {
          const last = prev[prev.length - 1];
          if (last?.role === role) {
            return [...prev.slice(0, -1), { ...last, content }];
          }
        }
        return [
          ...prev,
          {
            id: messageId(role),
            role,
            content,
          },
        ];
      });
      return;
    }

    if (data.type === "delta") {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + (data.delta ?? "") },
          ];
        }
        return [
          ...prev,
          { id: messageId("assistant"), role: "assistant", content: data.delta ?? "" },
        ];
      });
      return;
    }

    if (data.type === "status") {
      setStatus((prev) => ({
        ...prev,
        connected: Boolean(data.connected),
        reconnecting: Boolean(data.reconnecting),
        model: data.model ?? prev.model,
        effort: data.effort ?? prev.effort,
        contextTokens: data.contextTokens ?? prev.contextTokens,
        activeProfile: data.activeProfile ?? prev.activeProfile,
        inputEnabled: data.inputEnabled ?? prev.inputEnabled,
        notice: data.notice ?? prev.notice,
      }));
    }
  }, []);

  const { send, connected, reconnecting } = useWebSocket(onMessage);

  useEffect(() => {
    setStatus((prev) => ({
      ...prev,
      connected,
      reconnecting,
    }));
  }, [connected, reconnecting]);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text || !connected || !status.inputEnabled) return;

    setMessages((prev) => [
      ...prev,
      { id: messageId("user"), role: "user", content: text },
    ]);
    send({ type: "user_input", text });
    setInput("");
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    shouldStickToBottomRef.current = true;
    queueMicrotask(() => {
      resizeTextarea();
      textareaRef.current?.focus();
    });
  }, [connected, input, resizeTextarea, send, status.inputEnabled]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const connectionLabel = useMemo(() => {
    if (status.connected) return "Connected";
    if (status.reconnecting) return "Reconnecting";
    return "Disconnected";
  }, [status.connected, status.reconnecting]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(244,114,182,0.16),_transparent_28%),linear-gradient(180deg,_#09090b_0%,_#09090b_42%,_#050506_100%)] text-zinc-100">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:40px_40px] opacity-[0.18]" />
      <div className="relative mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 pb-28 pt-6 sm:px-6 lg:px-8">
        <main
          ref={scrollContainerRef}
          onScroll={onScroll}
          className="no-scrollbar flex-1 overflow-y-auto"
        >
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-16 pt-8">
              {messages.map((message) => (
                <MessageRow key={message.id} message={message} />
              ))}
            </div>
          )}
        </main>

        <div className="pointer-events-none absolute bottom-30 left-1/2 z-10 -translate-x-1/2">
          <JumpToLatestButton visible={showJumpToLatest} onClick={() => scrollToLatest()} />
        </div>

        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 px-4 pb-4 sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
            <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-full border border-white/8 bg-zinc-950/88 px-3 py-2 shadow-[0_-20px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl">
              <FooterChip label="Model" value={status.model} />
              <FooterChip label="Effort" value={status.effort} />
              <FooterChip
                label="Context"
                value={status.contextTokens !== undefined ? `${formatTokenCount(status.contextTokens)} tokens` : undefined}
              />
              <FooterChip label="Profile" value={status.activeProfile} />
              <FooterChip label="State" value={connectionLabel} />
            </div>

            <div className="mx-auto w-full max-w-3xl rounded-[28px] border border-white/10 bg-zinc-950/90 p-3 shadow-[0_24px_120px_rgba(0,0,0,0.5)] backdrop-blur-xl">
              <div className="flex items-end gap-3">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    !connected
                      ? "Waiting for connection..."
                      : status.inputEnabled
                        ? "Message Cat Code..."
                        : "Browser UI connected. Sending is not wired without the REPL backend yet."
                  }
                  disabled={!connected || !status.inputEnabled}
                  rows={1}
                  className="max-h-[40vh] min-h-12 flex-1 resize-none bg-transparent px-3 py-3 text-[15px] leading-7 text-zinc-100 outline-none placeholder:text-zinc-500 disabled:cursor-not-allowed disabled:text-zinc-500"
                />
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!connected || !status.inputEnabled || !input.trim()}
                  className="mb-1 inline-flex h-11 shrink-0 items-center justify-center rounded-full border border-pink-300/20 bg-pink-500 px-4 text-sm font-medium text-zinc-950 transition hover:bg-pink-400 disabled:border-white/8 disabled:bg-white/[0.06] disabled:text-zinc-500"
                >
                  Send
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between px-3 pb-1 text-xs text-zinc-500">
                <span>
                  {status.inputEnabled
                    ? "Enter to send · Shift+Enter for newline"
                    : status.notice ?? "Browser send is currently disabled in web mode."}
                </span>
                <span>{connectionLabel}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
