"use client";

import { useState } from "react";
import {
  Banknote, Clock, FlaskConical, GitBranch, LayoutGrid, Plug, ScrollText, ShieldCheck, type LucideIcon,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LogoMark } from "@/components/Logo";
import { cn } from "@/lib/utils";
import { RiskScreen, EfficiencyScreen, CostScreen } from "./screens";

/* The homepage's one picture: the product itself. A faithful copy of the app
   shell (sidebar, top bar, page) with three of its real screens behind tabs.
   Nothing plays on its own; the visitor picks a tab. */

type View = "risk" | "efficiency" | "cost";

const VIEWS: { id: View; label: string; caption: string; crumb: string[]; nav: string }[] = [
  {
    id: "risk",
    label: "Risk",
    caption:
      "Each agent gets a score out of 100 for what it could break. Arceo flags actions that are risky together, and warns you before a prompt gives away a password.",
    crumb: ["Agents"],
    nav: "agents",
  },
  {
    id: "efficiency",
    label: "Efficiency",
    caption:
      "319 ready-made prompts for everyday work. One click sends a prompt to Claude Code, ChatGPT, Cursor or Lovable with the text already typed in.",
    crumb: ["Prompts", "Library"],
    nav: "library",
  },
  {
    id: "cost",
    label: "Cost",
    caption:
      "A monthly forecast for every agent, with a range that narrows as real usage comes in. Every prompt shows what it costs each time.",
    crumb: ["Spend", "Acme Support Copilot", "Cost portfolio"],
    nav: "spend",
  },
];

type NavItem = { id: string; label: string; Icon: LucideIcon; badge?: number };
const NAV: { group: string | null; items: NavItem[] }[] = [
  { group: null, items: [{ id: "agents", label: "Agents", Icon: LayoutGrid }] },
  {
    group: "Monitor",
    items: [
      { id: "approvals", label: "Approvals", Icon: ShieldCheck, badge: 3 },
      { id: "history", label: "History", Icon: Clock },
      { id: "spend", label: "Spend", Icon: Banknote },
    ],
  },
  {
    group: "Tools",
    items: [
      { id: "sandbox", label: "Sandbox", Icon: FlaskConical },
      { id: "workflows", label: "Workflows", Icon: GitBranch },
    ],
  },
  {
    group: "Prompts",
    items: [
      { id: "library", label: "Library", Icon: ScrollText },
      { id: "connect", label: "Connect your agent", Icon: Plug },
    ],
  },
];

export default function ProductWindow({ initial = "risk" }: { initial?: View }) {
  const [view, setView] = useState<View>(initial);
  const current = VIEWS.find((v) => v.id === view)!;

  return (
    <Tabs value={view} onValueChange={(v) => setView(v as View)} className="gap-0">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:gap-6">
        <TabsList aria-label="What Arceo shows" className="h-10 shrink-0 bg-[#ececee] p-1">
          {VIEWS.map((v) => (
            <TabsTrigger key={v.id} value={v.id} className="h-8 px-4 text-[14px]">
              {v.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <p aria-live="polite" className="max-w-[640px] text-[14px] leading-relaxed text-ink-3">
          {current.caption}
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border bg-white shadow-[0_24px_48px_-12px_rgb(0_0_0/0.12),0_2px_4px_rgb(0_0_0/0.04)]">
        <div className="flex">
          <Sidebar active={current.nav} />
          <div className="min-w-0 flex-1 bg-page">
            <div className="flex h-12 items-center justify-between border-b bg-white/80 px-4 sm:px-5">
              <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-3">
                {current.crumb.map((c, i) => (
                  <span key={c} className="flex min-w-0 items-center gap-1.5">
                    {i > 0 && <span aria-hidden>›</span>}
                    <span className={cn("truncate", i === current.crumb.length - 1 && "text-ink")}>{c}</span>
                  </span>
                ))}
              </nav>
              <span className="hidden text-[12px] text-ink-4 sm:inline">⌘K</span>
            </div>
            <div className="overflow-hidden p-4 sm:h-[600px] sm:p-6">
              <TabsContent value="risk" className="mt-0 h-full"><RiskScreen /></TabsContent>
              <TabsContent value="efficiency" className="mt-0 h-full"><EfficiencyScreen /></TabsContent>
              <TabsContent value="cost" className="mt-0 h-full"><CostScreen /></TabsContent>
            </div>
          </div>
        </div>
      </div>
    </Tabs>
  );
}

function Sidebar({ active }: { active: string }) {
  return (
    <aside aria-hidden className="hidden w-[208px] shrink-0 flex-col border-r bg-white min-[960px]:flex">
      <div className="flex h-12 items-center gap-2.5 border-b px-4">
        <span className="flex size-6 items-center justify-center rounded-md bg-[#0a0a0a]">
          <LogoMark height={9} navy="#fff" aqua="#fff" />
        </span>
        <span className="text-[13px] font-semibold tracking-[0.02em] text-ink">ARCEO</span>
      </div>
      <div className="flex flex-col gap-4 px-2.5 py-3">
        {NAV.map((g) => (
          <div key={g.group ?? "top"} className="flex flex-col gap-0.5">
            {g.group && (
              <div className="px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-4">{g.group}</div>
            )}
            {g.items.map(({ id, label, Icon, badge }) => (
              <div
                key={id}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px]",
                  id === active ? "bg-line-soft font-semibold text-[#1a1a1a]" : "text-ink-2",
                )}
              >
                <Icon className="size-4" strokeWidth={1.7} />
                <span className="flex-1 truncate">{label}</span>
                {badge && (
                  <span className="num rounded-full bg-critical px-1.5 text-[10.5px] font-semibold leading-[17px] text-white">{badge}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
