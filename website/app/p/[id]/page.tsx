import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Navbar from "../../../components/Navbar";
import Footer from "../../../components/Footer";
import { APP_URL, BAND, fetchPrompt, headline, runCost, summaryLine } from "../../../lib/prompts";

// Server-rendered public prompt page: what a shared link shows, and what
// Slack/LinkedIn/iMessage read for the preview (title, description, OG image).

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const p = await fetchPrompt(id);
  if (!p) return { title: "Prompt not found · Arceo" };
  const description = summaryLine(p);
  return {
    title: `${p.title} · Arceo prompts`,
    description,
    openGraph: { title: p.title, description, type: "article", url: `/p/${id}` },
    twitter: { card: "summary_large_image", title: p.title, description },
  };
}

export default async function PromptPage({ params }: Props) {
  const { id } = await params;
  const p = await fetchPrompt(id);
  if (!p) notFound();
  const h = headline(p);
  const band = p.danger_summary ? BAND[p.danger_summary.band] : null;
  const reasons = (p.danger_summary?.reasons ?? []).filter((r) => !r.dismissed).slice(0, 3);
  const useHref = APP_URL ? `${APP_URL}/p/${p.id}` : "/book-demo";

  return (
    <>
      <Navbar />
      <main style={{ background: "var(--ground)", minHeight: "calc(100vh - 64px)" }}>
        <section className="container" style={{ padding: "56px 0 80px", maxWidth: 1040 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.12em" }}>
            Prompt{p.use_case ? ` · ${p.use_case}` : ""}
          </span>
          <h1 style={{ fontSize: "clamp(28px, 6vw, 40px)", fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ink)", margin: "10px 0 8px" }}>{p.title}</h1>
          <p style={{ fontSize: 15, color: "var(--muted)" }}>
            {[p.author_name && `By ${p.author_name}`, `version ${p.published_version}`, p.use_count ? `used ${p.use_count} times` : null].filter(Boolean).join(" · ")}
          </p>
          {p.description && <p style={{ fontSize: 15, color: "var(--muted)", marginTop: 8, maxWidth: 640, lineHeight: 1.6 }}>{p.description}</p>}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "24px 0 32px" }}>
            <a href={useHref} className="btn-black">Use this prompt</a>
            {APP_URL && <a href={`${APP_URL}/login?for=prompts`} className="btn-outline">Score your own prompts free</a>}
          </div>

          <div className="share-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>
            <div style={{ background: "var(--paper)", borderRadius: "var(--r-lg)", padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Prompt</div>
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 13, lineHeight: 1.6, color: "var(--ink)", margin: "10px 0 0" }}>{p.body}</pre>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {band && p.danger_summary && (
                <div style={{ background: "var(--paper)", borderRadius: "var(--r-lg)", padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.08em" }}>How dangerous</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: band.ink }}>{band.label} danger</span>
                    <span style={{ fontSize: 13, color: "var(--muted-2)" }}>{p.danger_summary.score} / 100 · {p.danger_summary.status === "probed" ? "red-teamed" : "static check"}</span>
                  </div>
                  {reasons.length === 0
                    ? <p style={{ fontSize: 14, color: "var(--muted)", marginTop: 10 }}>No risky patterns found.</p>
                    : <ul style={{ margin: "12px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
                        {reasons.map((r, i) => (
                          <li key={i} style={{ borderLeft: `3px solid ${BAND[r.severity].ring}`, paddingLeft: 10 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{r.title}</div>
                            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2, lineHeight: 1.5 }}>{r.detail}</div>
                          </li>
                        ))}
                      </ul>}
                </div>
              )}
              {h && (
                <div style={{ background: "var(--paper)", borderRadius: "var(--r-lg)", padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Cost to run</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "var(--ink)", marginTop: 8, fontVariantNumeric: "tabular-nums" }}>{h.perMonth ?? runCost(h.perRun)}</div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
                    {h.perMonth ? `${p.runs_per_day} runs a day on ${h.model} · ${runCost(h.perRun)} a run` : `a run on ${h.model}`}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <style>{`@media (max-width: 860px) { .share-grid { grid-template-columns: 1fr !important; } }`}</style>
    </>
  );
}
