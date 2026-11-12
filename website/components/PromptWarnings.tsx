import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Warning } from "@/lib/prompts";

/* A plain warning box for the public prompt page. It renders only when a
   warning applies; a prompt with nothing to flag shows nothing at all. */

export default function PromptWarnings({ warnings }: { warnings: Warning[] }) {
  if (warnings.length === 0) return null;
  const critical = warnings.some((w) => w.severity === "critical");
  return (
    <div
      role="note"
      aria-label="Read this before you use it"
      className={cn("rounded-lg border p-5", critical ? "border-critical-line bg-critical-bg" : "border-high-line bg-high-bg")}
    >
      <div className={cn("flex items-center gap-2 text-[15px] font-semibold", critical ? "text-critical" : "text-high")}>
        <AlertTriangle className="size-4" /> Read this before you use it
      </div>
      <ul className="mt-3 flex flex-col gap-3">
        {warnings.map((w) => (
          <li key={w.id}>
            <div className="text-[14px] font-semibold text-ink">{w.title}</div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{w.detail}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
