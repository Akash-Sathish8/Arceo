import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/Button";

export interface CodeTab {
  label: string;
  code: string;
  lang: string;
}

// ── CopyButton ────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={copy}
      icon={copied ? <Check size={12} /> : <Copy size={12} />}
    >
      {copied ? "Copied!" : "Copy"}
    </Button>
  );
}

// ── CodeBlock ─────────────────────────────────────────────────────────────────

interface CodeBlockProps {
  code: string;
  language?: string;
}

/**
 * The one code sample surface: sunken light panel, hairline border, language
 * tag + copy button header. No terminal-green-on-black variants — code samples
 * are quiet chrome, not a costume.
 */
export function CodeBlock({ code, language = "bash" }: CodeBlockProps) {
  return (
    <div
      style={{
        background: "var(--bg-sunken)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-sunken)",
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
          {language}
        </span>
        <CopyButton text={code} />
      </div>
      <pre
        style={{
          overflowX: "auto",
          padding: 16,
          fontSize: 12,
          fontFamily: "var(--font-mono)",
          color: "var(--text-primary)",
          background: "var(--bg-sunken)",
          lineHeight: 1.6,
          margin: 0,
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ── CodeTabs ──────────────────────────────────────────────────────────────────

/**
 * The one code-snippet tab group (pill segmented control + CodeBlock).
 * Extracted from Settings so AgentDetail and future surfaces stop growing
 * their own variants.
 */
export default function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  const [active, setActive] = useState(0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "4px",
          background: "var(--bg-sunken)",
          borderRadius: "var(--radius-full)",
          width: "fit-content",
          marginBottom: 8,
        }}
      >
        {tabs.map((t, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            style={{
              padding: "5px 14px",
              fontSize: 13,
              fontWeight: active === i ? 600 : 400,
              borderRadius: "var(--radius-full)",
              border: "none",
              cursor: "pointer",
              background: active === i ? "var(--color-cta)" : "transparent",
              color: active === i ? "var(--text-inverse)" : "var(--text-secondary)",
              transition: "background 0.15s, color 0.15s",
              fontFamily: "inherit",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <CodeBlock code={tabs[active].code} language={tabs[active].lang} />
    </div>
  );
}
