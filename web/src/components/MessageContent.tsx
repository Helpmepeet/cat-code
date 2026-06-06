import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";

type MessageContentProps = {
  content: string;
  role: "user" | "assistant" | "system";
};

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void codeToHtml(code, {
      lang: language || "text",
      theme: "github-dark-default",
    })
      .then((next) => {
        if (!cancelled) {
          setHtml(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHtml(`<pre class=\"shiki github-dark-default\"><code>${escapeHtml(code)}</code></pre>`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group/code relative my-4 overflow-hidden rounded-2xl border border-white/10 bg-black/35">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-3 top-3 z-10 rounded-full border border-white/10 bg-black/50 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-zinc-200 opacity-0 transition group-hover/code:opacity-100"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <div
        className="overflow-x-auto [&_.shiki]:m-0 [&_.shiki]:bg-transparent [&_.shiki]:p-4 [&_.shiki]:text-[13px] [&_.shiki]:leading-6"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[0.92em] text-pink-200">
      {children}
    </code>
  );
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function MessageContent({ content, role }: MessageContentProps) {
  const markdown = useMemo(() => content, [content]);

  return (
    <div className={`message-markdown ${role === "system" ? "message-markdown-system" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children }) {
            const value = String(children).replace(/\n$/, "");
            const match = /language-(\w+)/.exec(className ?? "");

            if (!match) {
              return <InlineCode>{children}</InlineCode>;
            }

            return <CodeBlock code={value} language={match[1]} />;
          },
          table({ children }) {
            return (
              <div className="my-4 overflow-x-auto rounded-2xl border border-white/10">
                <table className="min-w-full border-collapse text-left text-sm">{children}</table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="bg-white/[0.04] text-zinc-200">{children}</thead>;
          },
          th({ children }) {
            return <th className="border-b border-white/10 px-4 py-3 font-medium">{children}</th>;
          },
          td({ children }) {
            return <td className="border-t border-white/10 px-4 py-3 align-top text-zinc-300">{children}</td>;
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                referrerPolicy="no-referrer"
                className="text-pink-300 underline decoration-pink-400/40 underline-offset-4 transition hover:text-pink-200"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
