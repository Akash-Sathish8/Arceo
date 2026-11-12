import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Navbar from "../../../components/Navbar";
import Footer from "../../../components/Footer";
import PromptCards from "../../../components/PromptCards";
import PromptWarnings from "../../../components/PromptWarnings";
import SendPrompt from "../../../components/SendPrompt";
import {
  APP_URL, blankName, bodyParts, fetchPrompt, fetchSimilar, headline, importantWarnings, runCost, summaryLine, variablesIn,
} from "../../../lib/prompts";

// Server-rendered public prompt page: what a shared link shows, and what
// Slack/LinkedIn/iMessage read for the preview (title, description, OG image).
// Read first, then send: the prompt text with its blanks, Send buttons, a
// warning only when one applies, what it costs, and similar prompts.

type Props = { params: Promise<{ id: string }> };

const card: React.CSSProperties = {
  background: "var(--paper)", borderRadius: "var(--r-lg)", padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
};
const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.08em",
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const p = await fetchPrompt(id);
  if (!p) return { title: "Prompt not found" };
  const what = p.description?.trim() ?? "";
  const summary = summaryLine(p);
  const description = (what && summary ? `${what}${/[.!?]$/.test(what) ? " " : " · "}${summary}` : what || summary)
    || "A ready-to-use AI prompt. Send it to your agent in one click.";
  return {
    title: `${p.title} · Prompts`,
    description,
    openGraph: { title: p.title, description, type: "article", url: `/p/${id}` },
    twitter: { card: "summary_large_image", title: p.title, description },
  };
}

export default async function PromptPage({ params }: Props) {
  const { id } = await params;
  const [p, similar] = await Promise.all([fetchPrompt(id), fetchSimilar(id, 6)]);
  if (!p) notFound();
  const h = headline(p);
  const warnings = importantWarnings(p.danger_summary);
  const blanks = variablesIn(p.body);
  const openHref = APP_URL ? `${APP_URL}/p/${encodeURIComponent(p.id)}` : null;

  return (
    <>
      <Navbar />
      <main style={{ background: "var(--ground)", minHeight: "calc(100vh - 64px)" }}>
        <section className="container" style={{ padding: "56px 24px 80px", maxWidth: 1040 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.12em" }}>
            Prompt{p.use_case ? ` · ${p.use_case}` : ""}
          </span>
          <h1 style={{ fontSize: "clamp(28px, 6vw, 40px)", fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ink)", margin: "10px 0 8px", overflowWrap: "anywhere" }}>
            {p.title}
          </h1>
          {(p.author_name || p.use_count > 0) && (
            <p style={{ fontSize: 15, color: "var(--muted)", overflowWrap: "anywhere" }}>
              {[p.author_name && `By ${p.author_name}`, p.use_count ? `used ${p.use_count.toLocaleString("en-US")} ${p.use_count === 1 ? "time" : "times"}` : null].filter(Boolean).join(" · ")}
            </p>
          )}
          {p.description && <p style={{ fontSize: 15, color: "var(--muted)", marginTop: 8, maxWidth: 640, lineHeight: 1.6, overflowWrap: "anywhere" }}>{p.description}</p>}

          <div className="share-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 20, alignItems: "start", marginTop: 28 }}>
            <div style={card}>
              <div style={label}>The prompt</div>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit", fontSize: 14, lineHeight: 1.6, color: "var(--ink)", margin: "10px 0 0" }}>
                {bodyParts(p.body).map((part, i) => part.blank
                  ? (
                    <mark key={i} title={`A blank: fill in the ${blankName(part.blank)}`}
                      style={{ background: "var(--amber-soft)", color: "var(--amber-ink)", border: "1px solid var(--amber-border)", borderRadius: "var(--r-xs)", padding: "0 4px", fontWeight: 600 }}>
                      [{blankName(part.blank)}]
                    </mark>
                  )
                  : <span key={i}>{part.text}</span>)}
              </pre>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
              <PromptWarnings warnings={warnings} />
              <SendPrompt text={p.body} promptId={p.id} blanks={blanks} />
              {h && (
                <div style={card}>
                  <div style={label}>What it costs</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "var(--ink)", marginTop: 8, fontVariantNumeric: "tabular-nums" }}>{h.perMonth ?? runCost(h.perRun)}</div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
                    {h.perMonth ? `Used ${p.runs_per_day} times a day on ${h.model} · ${runCost(h.perRun)} each time` : `each time, on ${h.model}`}
                  </div>
                </div>
              )}
              {openHref && (
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <a href={openHref} className="btn-outline">Save it to your library</a>
                  <a href={`${APP_URL}/login?for=prompts`} className="btn-outline">Browse more prompts</a>
                </div>
              )}
            </div>
          </div>

          {similar.length > 0 && (
            <section aria-labelledby="similar-heading" style={{ marginTop: 48 }}>
              <h2 id="similar-heading" style={{ fontSize: 20, fontWeight: 700, color: "var(--ink)", marginBottom: 14 }}>Similar prompts</h2>
              <PromptCards prompts={similar} />
            </section>
          )}
        </section>
      </main>
      <Footer />
      <style>{`@media (max-width: 860px) { .share-grid { grid-template-columns: minmax(0, 1fr) !important; } }`}</style>
    </>
  );
}
