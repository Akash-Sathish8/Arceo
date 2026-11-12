import { AlertTriangle, ArrowRight, Plus, Search, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AGENTS, CHAIN, FLEET, FORECAST, PROMPTS, PROMPT_COUNT, PROMPT_WARNING, SEND_TO, band, type Band } from "@/lib/demo";

/* Three screens of the product, rebuilt from its own labels and layout:
   Agents (frontend/src/pages/Authority.tsx), the Prompts library
   (PromptLibrary.tsx) and the Cost portfolio (CostPortfolio.tsx).
   All figures come from lib/demo.ts. */

const BAND_STYLE: Record<Band, { text: string; bg: string; line: string; ring: string }> = {
  Low: { text: "text-safe", bg: "bg-safe-bg", line: "border-safe-line", ring: "#16A34A" },
  Medium: { text: "text-caution", bg: "bg-caution-bg", line: "border-caution-line", ring: "#F59E0B" },
  High: { text: "text-high", bg: "bg-high-bg", line: "border-high-line", ring: "#EA580C" },
  Critical: { text: "text-critical", bg: "bg-critical-bg", line: "border-critical-line", ring: "#DC2626" },
};

function PageHead({ title, sub, actions }: { title: string; sub: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[19px] font-semibold tracking-[-0.01em] text-ink">{title}</div>
        <div className="mt-0.5 max-w-[520px] text-[12.5px] leading-snug text-ink-3">{sub}</div>
      </div>
      {actions && <div className="hidden shrink-0 items-center gap-2 sm:flex">{actions}</div>}
    </div>
  );
}

function FakeButton({ children, primary }: { children: React.ReactNode; primary?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium",
        primary ? "border-transparent bg-primary text-white" : "bg-white text-ink",
      )}
    >
      {children}
    </span>
  );
}

function Panel({ className, children, style }: { className?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className={cn("rounded-lg border bg-white shadow-xs", className)} style={style}>{children}</div>;
}

function Ring({ score }: { score: number }) {
  const s = BAND_STYLE[band(score)];
  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" className="shrink-0" aria-hidden>
      <circle cx="20" cy="20" r={r} fill="none" stroke="#F4F4F5" strokeWidth="3.5" />
      <circle
        cx="20" cy="20" r={r} fill="none" stroke={s.ring} strokeWidth="3.5" strokeLinecap="round"
        strokeDasharray={`${(c * Math.max(score, 3)) / 100} ${c}`} transform="rotate(-90 20 20)"
      />
      <text x="20" y="24.5" textAnchor="middle" fontSize="12" fontWeight="600" fill="#09090B" className="num">{score}</text>
    </svg>
  );
}

/* ── Risk: the Agents page ─────────────────────────────────────────── */

export function RiskScreen() {
  const stats = [
    { label: "Agents", value: String(FLEET.agents) },
    { label: "Forecast / mo", value: FLEET.forecastPerMonth },
    { label: "Critical chains", value: String(FLEET.criticalChains), tone: "text-critical" },
    { label: "Unguarded", value: String(FLEET.unguarded), tone: "text-caution" },
  ];
  return (
    <div className="flex h-full flex-col">
      <PageHead
        title="Agents"
        sub="Every action your AI agents can take, scored and governed before they reach production."
        actions={<FakeButton primary><Plus className="size-3.5" />Connect agent</FakeButton>}
      />
      <Panel className="mb-4 grid grid-cols-2 overflow-hidden sm:grid-cols-4">
        {stats.map((s, i) => (
          <div key={s.label} className={cn("px-4 py-3", i % 2 === 1 && "border-l", i >= 2 && "border-t sm:border-t-0 sm:border-l")}>
            <div className="text-[11.5px] text-ink-3">{s.label}</div>
            <div className={cn("num mt-0.5 text-[20px] font-semibold tracking-[-0.01em] text-ink", s.tone)}>{s.value}</div>
          </div>
        ))}
      </Panel>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-2">
          {AGENTS.map((a) => {
            const b = band(a.score);
            const s = BAND_STYLE[b];
            return (
              <Panel key={a.name} className="flex items-center gap-3 border-l-[3px] px-3 py-2.5" style={{ borderLeftColor: s.ring }}>
                <span className="sr-only">{b}</span>
                <Ring score={a.score} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold text-ink">{a.name}</div>
                  <div className="truncate text-[12px] text-ink-3">
                    <span className={cn("font-semibold uppercase", s.text)}>{b}</span> · {a.tools}
                  </div>
                </div>
                <span className="hidden shrink-0 text-[12px] text-ink-3 sm:inline">{a.state}</span>
              </Panel>
            );
          })}
        </div>

        <div className="hidden min-w-0 flex-col gap-3 lg:flex">
          <Panel className="p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[13px] font-semibold text-ink">{CHAIN.name}</div>
              <Badge className="h-5 rounded-md border-critical-line bg-critical-bg px-1.5 text-[11px] text-critical" variant="outline">
                {CHAIN.severity}
              </Badge>
            </div>
            <div className="mt-1 text-[12px] text-ink-3">{CHAIN.agent}</div>
            <ol className="mt-3 flex flex-col gap-1.5">
              {CHAIN.steps.map((st, i) => (
                <li key={st.action} className="flex items-center gap-2 text-[12px]">
                  <span className="num flex size-5 items-center justify-center rounded-full bg-line-soft text-[11px] font-semibold text-ink-2">{i + 1}</span>
                  <code className="font-mono text-[11.5px] text-ink">{st.action}</code>
                  <span className="text-ink-4">{st.label}</span>
                </li>
              ))}
            </ol>
            <p className="mt-2.5 text-[12px] leading-snug text-ink-2">{CHAIN.why}</p>
            <div className="mt-3 flex items-center gap-1.5 border-t pt-3 text-[12px] font-medium text-ink">
              <ArrowRight className="size-3.5" /> {CHAIN.fix}
            </div>
          </Panel>

          <div role="note" className="rounded-lg border border-high-line bg-high-bg p-4">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-high">
              <AlertTriangle className="size-3.5" /> Read this before you use it
            </div>
            <div className="mt-2 text-[12.5px] font-semibold leading-snug text-ink">{PROMPT_WARNING.title}</div>
            <div className="mt-1 text-[12px] leading-snug text-ink-2">{PROMPT_WARNING.detail}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Efficiency: the Prompts library ────────────────────────────────── */

export function EfficiencyScreen() {
  return (
    <div className="flex h-full flex-col">
      <PageHead
        title="Prompts"
        sub="Ready-made prompts for everyday work. Send one to your AI with the text already typed in."
        actions={<><FakeButton>Connect your agent</FakeButton><FakeButton primary><Plus className="size-3.5" />New prompt</FakeButton></>}
      />
      <div className="mb-3 flex h-9 items-center gap-2 rounded-lg border bg-white px-3 text-[13px] text-ink-4">
        <Search className="size-4 shrink-0" />
        <span className="truncate">What do you want to do? e.g. fix a bug, sum up an email</span>
      </div>
      <div className="mb-4 flex items-center justify-between text-[12.5px]">
        <div className="flex gap-1">
          {["All", "Mine", "Community"].map((f, i) => (
            <span key={f} className={cn("rounded-md px-2.5 py-1", i === 0 ? "bg-white font-medium text-ink shadow-xs ring-1 ring-border" : "text-ink-3")}>{f}</span>
          ))}
        </div>
        <span className="num text-ink-3">{PROMPT_COUNT} prompts</span>
      </div>

      <div className="grid min-h-0 flex-1 content-start gap-3 sm:grid-cols-2">
        {PROMPTS.map((p, i) => (
          <Panel key={p.title} className={cn("relative flex flex-col gap-1 p-4", i > 1 && "hidden sm:flex")}>
            <div className="text-[11.5px] text-ink-3">{p.category}</div>
            <div className="text-[14px] font-semibold leading-snug text-ink">{p.title}</div>
            <div className="mt-2 flex items-center justify-between">
              <span className="num text-[12px] text-ink-3">{p.cost}</span>
              <span className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium",
                i === 0 ? "border-ink bg-ink text-white" : "bg-white text-ink",
              )}>
                <Send className="size-3" /> Send to
              </span>
            </div>
            {i === 0 && (
              <div className="absolute right-3 top-[calc(100%-6px)] z-10 w-[190px] rounded-lg border bg-white p-1 shadow-lg">
                {SEND_TO.map((t, j) => (
                  <div key={t} className={cn("rounded-md px-2.5 py-1.5 text-[12.5px]", j === 0 ? "bg-line-soft font-medium text-ink" : "text-ink-2")}>
                    {t}
                  </div>
                ))}
                <div className="mt-1 border-t px-2.5 pb-1 pt-1.5 text-[12px] text-ink-3">Copy prompt</div>
              </div>
            )}
          </Panel>
        ))}
      </div>

      <Panel className="mt-auto hidden items-center justify-between gap-4 px-4 py-3 md:flex">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-ink">Leaner agents</div>
          <div className="text-[12px] text-ink-3">Triage for Acme Support Copilot on Claude Haiku 4.5 instead of Sonnet 4.6</div>
        </div>
        <div className="num shrink-0 text-right text-[12.5px]">
          <span className="text-ink-4 line-through">$812 / mo</span>{" "}
          <span className="font-semibold text-ink">$271 / mo</span>
        </div>
      </Panel>
    </div>
  );
}

/* ── Cost: one agent's cost portfolio ───────────────────────────────── */

export function CostScreen() {
  const f = FORECAST;
  return (
    <div className="flex h-full flex-col">
      <PageHead
        title="Operational spend forecast"
        sub={`${f.agent} · based on ${f.basis}`}
        actions={<FakeButton>Export report</FakeButton>}
      />
      <div className="mb-4 grid gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Panel className="p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-ink-3">Monthly forecast</span>
            <Badge variant="outline" className="h-5 rounded-md border-safe-line bg-safe-bg px-1.5 text-[10.5px] font-semibold text-safe">
              {f.confidence} CONFIDENCE
            </Badge>
          </div>
          <div className="num mt-1 text-[34px] font-semibold leading-tight tracking-[-0.02em] text-ink">
            {f.point}<span className="text-[15px] font-medium text-ink-3"> / mo</span>
          </div>
          <div className="num text-[12.5px] text-ink-3">Range {f.low}–{f.high}</div>
          <div className="relative mt-3 h-1.5 rounded-full bg-line-soft" aria-hidden>
            <div className="absolute inset-y-0 left-[15%] right-[15%] rounded-full bg-ink-4/50" />
            <div className="absolute -top-1 left-1/2 h-3.5 w-0.5 -translate-x-1/2 rounded bg-ink" />
          </div>
          <div className="mt-4 flex items-center justify-between border-t pt-3 text-[12px]">
            <span className="text-ink-3">Budget cap</span>
            <span className="num font-medium text-ink">{f.budget} / mo · blocks at the cap</span>
          </div>
        </Panel>
        <Panel className="hidden p-4 md:block">
          <div className="text-[12px] text-ink-3">Inputs</div>
          <ul className="mt-2 flex flex-col divide-y">
            {f.inputs.map((x) => (
              <li key={x.name} className="flex items-center justify-between gap-2 py-2 text-[12.5px]">
                <span className="text-ink-2">{x.name}</span>
                <span className="flex items-center gap-2">
                  <span className="num font-medium text-ink">{x.value}</span>
                  <span className={cn(
                    "rounded border px-1.5 text-[10.5px] leading-[16px]",
                    x.source === "measured" ? "border-safe-line bg-safe-bg text-safe" : "border-border bg-line-soft text-ink-2",
                  )}>{x.source}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel className="min-h-0 overflow-hidden">
        <div className="border-b px-4 py-2.5 text-[13px] font-semibold text-ink">Where the money goes</div>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[11.5px] text-ink-3">
              <th className="px-4 py-2 font-medium">Tool &amp; action</th>
              <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Calls / mo</th>
              <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">$ / call</th>
              <th className="px-4 py-2 text-right font-medium">$ / mo</th>
            </tr>
          </thead>
          <tbody>
            {f.rows.map((r) => (
              <tr key={r.item} className="border-t">
                <td className="max-w-0 truncate px-4 py-2 text-ink">{r.item}</td>
                <td className="num hidden px-4 py-2 text-right text-ink-2 sm:table-cell">{r.calls}</td>
                <td className="num hidden px-4 py-2 text-right text-ink-2 sm:table-cell">{r.perCall}</td>
                <td className="num px-4 py-2 text-right font-medium text-ink">{r.perMonth}</td>
              </tr>
            ))}
            <tr className="border-t bg-page">
              <td className="px-4 py-2 font-semibold text-ink">Total</td>
              <td className="hidden sm:table-cell" />
              <td className="hidden sm:table-cell" />
              <td className="num px-4 py-2 text-right font-semibold text-ink">{f.point}</td>
            </tr>
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
