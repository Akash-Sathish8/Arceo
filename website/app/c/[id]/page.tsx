import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Navbar from "../../../components/Navbar";
import Footer from "../../../components/Footer";
import { APP_URL, BAND, fetchComparison, runCost } from "../../../lib/prompts";

// Server-rendered public comparison: leaderboard ranked by blind votes, with
// each entry's cost per run and danger. Entry text stays hidden until closed.

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const c = await fetchComparison(id);
  if (!c) return { title: "Comparison not found · Arceo" };
  const lead = c.leaderboard[0];
  const description = `${c.entry_count} prompts, ${c.vote_count} blind votes on ${c.model}.${lead?.author_name ? ` Leading: ${lead.author_name}.` : ""}`;
  return {
    title: `${c.title} · Arceo compare`,
    description,
    openGraph: { title: c.title, description, url: `/c/${id}` },
    twitter: { card: "summary_large_image", title: c.title, description },
  };
}

export default async function ComparisonPage({ params }: Props) {
  const { id } = await params;
  const c = await fetchComparison(id);
  if (!c) notFound();
  const enter = APP_URL ? `${APP_URL}/prompt-compare/${c.id}` : "/book-demo";
  return (
    <>
      <Navbar />
      <main style={{ background: "var(--ground)", minHeight: "calc(100vh - 64px)" }}>
        <section className="container" style={{ padding: "56px 0 80px", maxWidth: 960 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.12em" }}>
            Compare · {c.status === "open" ? "open" : "closed"}
          </span>
          <h1 style={{ fontSize: "clamp(28px, 6vw, 40px)", fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ink)", margin: "10px 0 8px" }}>{c.title}</h1>
          <p style={{ fontSize: 15, color: "var(--muted)", maxWidth: 640, lineHeight: 1.6 }}>
            {c.task} · runs on {c.model} · {c.entry_count} entries · {c.vote_count} votes
          </p>
          {c.status === "open" && <div style={{ margin: "20px 0 28px" }}><a href={enter} className="btn-black">Enter or vote</a></div>}
          <div style={{ background: "var(--paper)", borderRadius: "var(--r-lg)", padding: 20, boxShadow: "0 1px 4px rgba(0,0,0,0.05)", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 480 }}>
              <thead>
                <tr style={{ color: "var(--muted-2)", textAlign: "left" }}>
                  {["Rank", "By", "Score", "Won · lost · tied", "Each time", "Danger"].map((h) => (
                    <th key={h} style={{ padding: "8px 6px", fontWeight: 600, borderBottom: "1px solid var(--rule)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.leaderboard.map((r) => (
                  <tr key={r.id}>
                    <td style={{ padding: "9px 6px", borderBottom: "1px solid var(--rule)" }}>{r.rank}</td>
                    <td style={{ padding: "9px 6px", borderBottom: "1px solid var(--rule)", color: "var(--ink)" }}>{r.author_name ?? "creator"}</td>
                    <td style={{ padding: "9px 6px", borderBottom: "1px solid var(--rule)", fontWeight: 700 }}>{r.elo}</td>
                    <td style={{ padding: "9px 6px", borderBottom: "1px solid var(--rule)", color: "var(--muted)" }}>{r.wins} · {r.losses} · {r.ties}</td>
                    <td style={{ padding: "9px 6px", borderBottom: "1px solid var(--rule)", fontVariantNumeric: "tabular-nums" }}>{runCost(r.cost?.usd_per_run)}</td>
                    <td style={{ padding: "9px 6px", borderBottom: "1px solid var(--rule)", fontWeight: 700, color: r.danger ? BAND[r.danger.band].ink : "var(--muted)" }}>
                      {r.danger ? `${BAND[r.danger.band].label}` : "n/a"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
