import Link from "next/link";

/* A grid of prompt cards linking to their public pages: the Similar prompts
   section on /p/[id] and the popular list on /prompts. Title, one line of
   what it does, category and author. Nothing else: no score or rank. */

export interface PromptCardData {
  id: string; title: string; description: string | null; use_case: string | null; author_name: string | null;
}

export default function PromptCards({ prompts }: { prompts: PromptCardData[] }) {
  if (prompts.length === 0) return null;
  return (
    <div className="prompt-cards">
      {prompts.map((p) => (
        <Link key={p.id} href={`/p/${encodeURIComponent(p.id)}`} className="prompt-card">
          {p.use_case && (
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {p.use_case}
            </span>
          )}
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)", lineHeight: 1.35 }}>{p.title}</span>
          {p.description && <span className="prompt-card-desc">{p.description}</span>}
          {p.author_name && <span style={{ fontSize: 12, color: "var(--muted-2)", marginTop: "auto" }}>By {p.author_name}</span>}
        </Link>
      ))}
      <style>{`
        .prompt-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 16px; }
        .prompt-card {
          display: flex; flex-direction: column; gap: 6px; min-width: 0;
          background: var(--paper); border: 1px solid var(--rule); border-radius: var(--r-lg);
          padding: 16px 18px; box-shadow: var(--shadow-xs);
          transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s;
        }
        .prompt-card:hover { border-color: var(--brand-border); box-shadow: var(--shadow-sm); transform: translateY(-1px); }
        .prompt-card-desc {
          font-size: 13px; color: var(--muted); line-height: 1.5;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
          overflow-wrap: anywhere;
        }
      `}</style>
    </div>
  );
}
