import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
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
      <main className="min-h-[calc(100vh-64px)]">
        <section className="container-site max-w-[1080px] pt-12 pb-20 sm:pt-16">
          <div className="text-[13px] text-ink-3">Prompt{p.use_case ? ` · ${p.use_case}` : ""}</div>
          <h1 className="mt-2 text-[30px] font-semibold leading-tight tracking-[-0.025em] text-ink [overflow-wrap:anywhere] sm:text-[40px]">
            {p.title}
          </h1>
          {(p.author_name || p.use_count > 0) && (
            <p className="mt-2 text-[15px] text-ink-3 [overflow-wrap:anywhere]">
              {[p.author_name && `By ${p.author_name}`, p.use_count ? `used ${p.use_count.toLocaleString("en-US")} ${p.use_count === 1 ? "time" : "times"}` : null].filter(Boolean).join(" · ")}
            </p>
          )}
          {p.description && <p className="mt-2 max-w-[640px] text-[15px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{p.description}</p>}

          <div className="mt-8 grid items-start gap-5 md:grid-cols-2">
            <div className="rounded-lg border bg-white p-5 shadow-xs">
              <h2 className="text-[15px] font-semibold text-ink">The prompt</h2>
              <pre className="mt-3 whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink [overflow-wrap:anywhere]">
                {bodyParts(p.body).map((part, i) => part.blank
                  ? (
                    <mark key={i} title={`A blank: fill in the ${blankName(part.blank)}`}
                      className="rounded-sm border border-caution-line bg-caution-bg px-1 font-semibold text-caution">
                      [{blankName(part.blank)}]
                    </mark>
                  )
                  : <span key={i}>{part.text}</span>)}
              </pre>
            </div>

            <div className="flex min-w-0 flex-col gap-5">
              <PromptWarnings warnings={warnings} />
              <SendPrompt text={p.body} promptId={p.id} blanks={blanks} />
              {h && (
                <div className="rounded-lg border bg-white p-5 shadow-xs">
                  <h2 className="text-[15px] font-semibold text-ink">What it costs</h2>
                  <div className="num mt-2 text-[28px] font-semibold tracking-[-0.02em] text-ink">{h.perMonth ?? runCost(h.perRun)}</div>
                  <div className="mt-1 text-[13px] text-ink-3">
                    {h.perMonth ? `Used ${p.runs_per_day} times a day on ${h.model} · ${runCost(h.perRun)} each time` : `each time, on ${h.model}`}
                  </div>
                </div>
              )}
              {openHref && (
                <div className="flex flex-wrap gap-3">
                  <Button asChild variant="outline" className="h-10 bg-white px-4 text-[14px]"><a href={openHref}>Save it to your library</a></Button>
                  <Button asChild variant="outline" className="h-10 bg-white px-4 text-[14px]"><a href={`${APP_URL}/login?for=prompts`}>Browse more prompts</a></Button>
                </div>
              )}
            </div>
          </div>

          {similar.length > 0 && (
            <section aria-labelledby="similar-heading" className="mt-14">
              <h2 id="similar-heading" className="mb-4 text-[20px] font-semibold tracking-[-0.01em] text-ink">Similar prompts</h2>
              <PromptCards prompts={similar} />
            </section>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}
