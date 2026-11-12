import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Navbar from "../../../components/Navbar";
import Footer from "../../../components/Footer";
import { APP_URL, fetchComparison, modelName, runCost } from "../../../lib/prompts";

// Server-rendered public comparison. The prompts product no longer ranks
// prompts, so this is a neutral list of who took part (alphabetical, never
// the vote order) and what each costs. The route stays so old links work.

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const c = await fetchComparison(id);
  if (!c) return { title: "Comparison not found" };
  const description = `${c.entry_count} ${c.entry_count === 1 ? "prompt" : "prompts"} for the same job, on ${modelName(c.model)}.`;
  return {
    title: `${c.title} · Prompts`,
    description,
    openGraph: { title: c.title, description, url: `/c/${id}` },
    twitter: { card: "summary_large_image", title: c.title, description },
  };
}

export default async function ComparisonPage({ params }: Props) {
  const { id } = await params;
  const c = await fetchComparison(id);
  if (!c) notFound();
  const open = APP_URL ? `${APP_URL}/prompt-compare/${encodeURIComponent(c.id)}` : null;
  const entries = [...(c.leaderboard ?? [])].sort((a, b) =>
    Number(!a.author_name) - Number(!b.author_name)
    || (a.author_name ?? "").localeCompare(b.author_name ?? "", "en", { sensitivity: "base" })
    || a.id.localeCompare(b.id));
  return (
    <>
      <Navbar />
      <main style={{ background: "var(--ground)", minHeight: "calc(100vh - 64px)" }}>
        <section className="container" style={{ padding: "56px 24px 80px", maxWidth: 960 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.12em" }}>
            Prompts for the same job
          </span>
          <h1 style={{ fontSize: "clamp(28px, 6vw, 40px)", fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ink)", margin: "10px 0 8px", overflowWrap: "anywhere" }}>{c.title}</h1>
          <p style={{ fontSize: 15, color: "var(--muted)", maxWidth: 640, lineHeight: 1.6, overflowWrap: "anywhere" }}>{c.task}</p>
          <p style={{ fontSize: 13, color: "var(--muted-2)", marginTop: 6 }}>
            {c.entry_count} {c.entry_count === 1 ? "prompt" : "prompts"} · on {modelName(c.model)}
          </p>
          {open && <div style={{ margin: "20px 0 28px" }}><a href={open} className="btn-black">Open in Arceo</a></div>}
          {entries.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: open ? 0 : "24px 0 0", background: "var(--paper)", borderRadius: "var(--r-lg)", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
              {entries.map((e, i) => (
                <li key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "14px 20px", borderTop: i ? "1px solid var(--rule)" : "none", fontSize: 14 }}>
                  <span style={{ color: "var(--ink)", minWidth: 0, overflowWrap: "anywhere" }}>{e.author_name ? `By ${e.author_name}` : "A creator"}</span>
                  {e.cost?.usd_per_run != null && (
                    <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{runCost(e.cost.usd_per_run)} each time</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}
