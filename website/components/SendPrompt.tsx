"use client";

import { useRef, useState } from "react";
import { API_URL, SEND_TARGETS, TARGET_GROUPS, blankName, fillBlanks, wellFormed, type SendTarget } from "@/lib/prompts";
import { buttonVariants, Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/* "Send it to your agent": one button per agent, grouped the way the app's
   Send dialog groups them. Each button is a real link that opens the agent
   with the prompt typed in (the person still presses Enter: the agents make
   that step deliberate). A prompt too long for a link is copied instead and
   the agent opened, so it can be pasted. Blanks get a box each; whatever is
   typed goes into the link, and an empty one arrives as [its name]. */

type Status = { tone: "ok" | "error"; text: string; help?: string } | null;


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

  const targetClass = cn(buttonVariants({ variant: "outline" }), "h-10 w-full justify-center bg-white text-[14px]");

  return (
    <div className="rounded-lg border bg-white p-5 shadow-xs">
      <h2 className="text-[15px] font-semibold text-ink">Send it to your agent</h2>
      <p className="mt-1 text-[14px] leading-relaxed text-ink-3">
        One click opens it with the prompt already typed in. Check it, then press Enter.
      </p>

      {blanks.length > 0 && (
        <div className="mt-4 rounded-md bg-page p-3 ring-1 ring-border">
          <div className="text-[14px] font-semibold text-ink">Add your own details</div>
          <p className="mb-3 mt-1 text-[13px] leading-relaxed text-ink-3">
            They go into the prompt before it&apos;s sent. Leave one empty and it arrives as [its name], for you to fill in there.
          </p>
          <div className="flex flex-col gap-3">
            {blanks.map((b) => (
              <div key={b} className="flex flex-col gap-1.5">
                <Label htmlFor={`blank-${b}`} className="text-[13px] [overflow-wrap:anywhere]">{blankName(b)}</Label>
                <Textarea id={`blank-${b}`} rows={LONG_BLANK.test(b) ? 4 : 1} value={values[b] ?? ""}
                  className="min-h-9 bg-white text-[14px]"
                  onChange={(e) => setValues((cur) => ({ ...cur, [b]: e.target.value }))} />
              </div>
            ))}
          </div>
          {empty.length > 0 && empty.length < blanks.length && (
            <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
              Still empty: {empty.map((b) => `[${blankName(b)}]`).join(", ")}.
            </p>
          )}
        </div>
      )}

      {TARGET_GROUPS.map((g) => {
        const targets = SEND_TARGETS.filter((t) => t.group === g);
        return (
          <div key={g} className="mt-4">
            <div className="mb-2 text-[12.5px] font-medium text-ink-3">{g}</div>
            <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
              {targets.map((t) => t.fits(text)
                ? (
                  <a key={t.id} href={t.build(text)} className={targetClass}
                    {...(t.app ? {} : { target: "_blank", rel: "noopener noreferrer" })}
                    onClick={() => opened(t)}>
                    {t.name}
                  </a>
                )
                : (
                  <button key={t.id} type="button" className={targetClass} onClick={() => void copyOpen(t)}>
                    {t.name}
                  </button>
                ))}
            </div>
          </div>
        );
      })}

      <div className="mt-4 border-t pt-4">
        <Button type="button" className="h-10 w-full text-[14px]" onClick={() => void copyOnly()}>
          Copy prompt
        </Button>
      </div>

      <div aria-live="polite">
        {status && (
          <div className="mt-3">
            <p role={status.tone === "error" ? "alert" : undefined}
              className={cn("text-[13px] leading-relaxed", status.tone === "error" ? "text-critical" : "text-ink")}>
              {status.text}
            </p>
            {status.help && <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">{status.help}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
