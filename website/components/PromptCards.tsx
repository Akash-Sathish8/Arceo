import Link from "next/link";

/* A grid of prompt cards linking to their public pages: Similar prompts on
   /p/[id] and Popular prompts on /prompts. Title, one line of what it does,
   category and author. No score or rank. */

export interface PromptCardData {
  id: string; title: string; description: string | null; use_case: string | null; author_name: string | null;
}

export default function PromptCards({ prompts }: { prompts: PromptCardData[] }) {
  if (prompts.length === 0) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-3">
      {prompts.map((p) => (
        <Link
          key={p.id}
          href={`/p/${encodeURIComponent(p.id)}`}
          className="flex min-w-0 flex-col gap-1 rounded-lg border bg-white p-4 shadow-xs transition-colors hover:border-ink-4"
        >
          {p.use_case && <span className="text-[12px] text-ink-3">{p.use_case}</span>}
          <span className="text-[15px] font-semibold leading-snug text-ink">{p.title}</span>
          {p.description && (
            <span className="line-clamp-2 text-[13px] leading-relaxed text-ink-3 [overflow-wrap:anywhere]">{p.description}</span>
          )}
          {p.author_name && <span className="mt-auto pt-2 text-[12px] text-ink-4">By {p.author_name}</span>}
        </Link>
      ))}
    </div>
  );
}
