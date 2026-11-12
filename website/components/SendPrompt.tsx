"use client";

import { useRef, useState } from "react";
import { API_URL, SEND_TARGETS, TARGET_GROUPS, blankName, fillBlanks, wellFormed, type SendTarget } from "../lib/prompts";

/* "Send it to your agent": one button per agent, grouped the way the app's
   Send dialog groups them. Each button is a real link that opens the agent
   with the prompt typed in (the person still presses Enter: the agents make
   that step deliberate). A prompt too long for a link is copied instead and
   the agent opened, so it can be pasted. Blanks get a box each; whatever is
   typed goes into the link, and an empty one arrives as [its name]. */

type Status = { tone: "ok" | "error"; text: string; help?: string } | null;

const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.08em",
};
const button: React.CSSProperties = {
  justifyContent: "center", padding: "8px 14px", fontSize: 14, width: "100%", minHeight: 40,
};

function pasteKey(): string {
  if (typeof navigator === "undefined") return "Ctrl+V";
  return /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘V" : "Ctrl+V";
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the old way (no permission, or not a secure page) */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

const field: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "8px 10px", fontSize: 14, lineHeight: 1.5, fontFamily: "inherit",
  color: "var(--ink)", background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r-md)", resize: "vertical",
};

// Blanks that usually hold a paragraph or more get a taller box (same rule as the app).
const LONG_BLANK = /email|message|transcript|notes|document|article|page|review|ticket|post|resume|text|error|code|draft|content|thread/i;

export default function SendPrompt({ text: body, promptId, blanks }: { text: string; promptId?: string; blanks: string[] }) {
  const [status, setStatus] = useState<Status>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const counted = useRef(false);
  // What every button sends: the prompt with the boxes below filled in.
  const text = wellFormed(fillBlanks(body, values));
  const empty = blanks.filter((b) => !values[b]?.trim());

  // The public use counter (IP-limited on the backend). Once per page view.
  function countUse() {
    if (!promptId || !API_URL || counted.current) return;
    counted.current = true;
    fetch(`${API_URL}/api/public/prompts/${encodeURIComponent(promptId)}/use`, { method: "POST", keepalive: true })
      .catch(() => {});
  }

  function opened(t: SendTarget) {
    // Some links are known to drop part of the text (Cursor and "&"): copy it
    // too, started inside the click so the browser allows it.
    const backup = t.copyAlso?.(text) ? copyText(text) : null;
    countUse();
    const base = t.app ? `Opening ${t.name}. Check the prompt, then press Enter.` : `${t.name} opened in a new tab. Check the prompt, then press Enter.`;
    setStatus({ tone: "ok", text: base, help: t.help });
    void backup?.then((ok) => {
      if (ok) setStatus({ tone: "ok", text: base, help: `We copied it too, in case part of it goes missing: paste it with ${pasteKey()}. ${t.help}` });
    });
  }

  // Too long for a link: copy it, then open the agent so it can be pasted.
  async function copyOpen(t: SendTarget) {
    // Start the copy and open the tab in the same click, before any await:
    // browsers only allow both while the click is still "fresh".
    const copying = copyText(text);
    let tab: Window | null = null;
    if (t.openUrl && t.app) {
      window.location.href = t.openUrl;   // an app link: the system hands it to the app, the page stays
    } else if (t.openUrl) {
      tab = window.open(t.openUrl, "_blank");
      if (tab) tab.opener = null;   // no "noopener" flag: with it, open() returns null and we can't tell it worked
    }
    const ok = await copying;
    countUse();
    if (!ok) {
      setStatus({ tone: "error", text: "Couldn't copy it. Select the prompt text and copy it yourself." });
      return;
    }
    setStatus({
      tone: "ok",
      text: tab || (t.app && t.openUrl)
        ? `This prompt is too long to send straight to ${t.name}, so we copied it and opened ${t.name}. Paste it there with ${pasteKey()}.`
        : `This prompt is too long to send straight to ${t.name}, so we copied it. Open ${t.name} and paste it with ${pasteKey()}.`,
      help: t.app ? t.help : undefined,
    });
  }

  async function copyOnly() {
    const ok = await copyText(text);
    if (ok) countUse();
    setStatus(ok
      ? { tone: "ok", text: `Copied. Paste it into any AI app with ${pasteKey()}.` }
      : { tone: "error", text: "Couldn't copy it. Select the prompt text and copy it yourself." });
  }

  return (
    <div style={{ background: "var(--paper)", borderRadius: "var(--r-lg)", padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
      <div style={label}>Send it to your agent</div>
      <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.55, margin: "8px 0 0" }}>
        One click opens it with the prompt already typed in. Check it, then press Enter.
      </p>

      {blanks.length > 0 && (
        <div style={{ marginTop: 14, padding: "12px 12px 14px", borderRadius: "var(--r-md)", background: "var(--ground-2)" }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>Add your own details</div>
          <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.55, margin: "4px 0 10px" }}>
            They go into the prompt before it&apos;s sent. Leave one empty and it arrives as [its name], for you to fill in there.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {blanks.map((b) => (
              <div key={b}>
                <label htmlFor={`blank-${b}`} style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 4, overflowWrap: "anywhere" }}>
                  {blankName(b)}
                </label>
                <textarea id={`blank-${b}`} rows={LONG_BLANK.test(b) ? 4 : 1} style={field} value={values[b] ?? ""}
                  onChange={(e) => setValues((cur) => ({ ...cur, [b]: e.target.value }))} />
              </div>
            ))}
          </div>
          {empty.length > 0 && empty.length < blanks.length && (
            <p style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5, margin: "8px 0 0" }}>
              Still empty: {empty.map((b) => `[${blankName(b)}]`).join(", ")}.
            </p>
          )}
        </div>
      )}

      {TARGET_GROUPS.map((g) => {
        const targets = SEND_TARGETS.filter((t) => t.group === g);
        return (
          <div key={g} style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 8 }}>{g}</div>
            <div className="send-grid">
              {targets.map((t) => t.fits(text)
                ? (
                  <a key={t.id} href={t.build(text)} className="btn-outline" style={button}
                    {...(t.app ? {} : { target: "_blank", rel: "noopener noreferrer" })}
                    onClick={() => opened(t)}>
                    {t.name}
                  </a>
                )
                : (
                  <button key={t.id} type="button" className="btn-outline" style={button} onClick={() => void copyOpen(t)}>
                    {t.name}
                  </button>
                ))}
            </div>
          </div>
        );
      })}

      <div style={{ marginTop: 16, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
        <button type="button" className="btn-black" style={{ ...button, border: 0 }} onClick={() => void copyOnly()}>
          Copy prompt
        </button>
      </div>

      <div aria-live="polite" style={{ minHeight: 0 }}>
        {status && (
          <div style={{ marginTop: 12 }}>
            <p role={status.tone === "error" ? "alert" : undefined}
              style={{ fontSize: 13, lineHeight: 1.5, color: status.tone === "error" ? "var(--risk-critical)" : "var(--ink)" }}>
              {status.text}
            </p>
            {status.help && <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--muted)", marginTop: 2 }}>{status.help}</p>}
          </div>
        )}
      </div>

      <style>{`
        .send-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        @media (max-width: 360px) { .send-grid { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
