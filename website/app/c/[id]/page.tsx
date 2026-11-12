import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
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
      <main className="min-h-[calc(100vh-64px)]">
        <section className="container-site max-w-[960px] pt-12 pb-20 sm:pt-16">
          <div className="text-[13px] text-ink-3">Prompts for the same job</div>
          <h1 className="mt-2 text-[30px] font-semibold leading-tight tracking-[-0.025em] text-ink [overflow-wrap:anywhere] sm:text-[40px]">{c.title}</h1>
          <p className="mt-2 max-w-[640px] text-[15px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{c.task}</p>
          <p className="mt-1.5 text-[13px] text-ink-3">
            {c.entry_count} {c.entry_count === 1 ? "prompt" : "prompts"} · on {modelName(c.model)}
          </p>
          {open && (
            <Button asChild className="mt-6 h-10 px-4 text-[14px]"><a href={open}>Open in Arceo</a></Button>
          )}
          {entries.length > 0 && (
            <ul className="mt-6 divide-y rounded-lg border bg-white shadow-xs">
              {entries.map((e) => (
                <li key={e.id} className="flex justify-between gap-4 px-5 py-3.5 text-[14px]">
                  <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{e.author_name ? `By ${e.author_name}` : "A creator"}</span>
                  {e.cost?.usd_per_run != null && (
                    <span className="num whitespace-nowrap text-ink-3">{runCost(e.cost.usd_per_run)} each time</span>
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
