import { ImageResponse } from "next/og";
import C from "../../../lib/palette";
import { fetchPrompt, headline, runCost } from "../../../lib/prompts";

// Link preview for a shared prompt: its title and category, the one-click
// send promise, and what it costs, so the card in Slack says something worth
// clicking. No rating or score.
export const alt = "A ready-to-use prompt on Arceo";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 300;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await fetchPrompt(id);
  const h = p ? headline(p) : null;
  const title = p ? (p.title.length > 80 ? `${p.title.slice(0, 79)}…` : p.title) : "Prompt not found";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: C.paper, padding: "64px 72px", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 28, fontWeight: 700, color: C.ink, letterSpacing: "4px" }}>ARCEO · PROMPTS</div>
          {p?.use_case && (
            <div style={{ display: "flex", fontSize: 24, fontWeight: 600, color: C.muted, background: C.ground, borderRadius: 999, padding: "8px 20px" }}>
              {p.use_case.slice(0, 40)}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 700, color: C.ink, lineHeight: 1.08, letterSpacing: "-2px", maxWidth: 1050 }}>
            {title}
          </div>
          {p?.author_name && <div style={{ display: "flex", fontSize: 28, color: C.muted }}>{`by ${p.author_name}`}</div>}
        </div>
        <div style={{ display: "flex", gap: 24 }}>
          {p && (
            <div style={{ display: "flex", alignItems: "center", background: C.brand, borderRadius: 16, padding: "18px 26px" }}>
              <div style={{ display: "flex", fontSize: 30, fontWeight: 700, color: "#FFFFFF" }}>Send it to your agent in one click</div>
            </div>
          )}
          {h && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, background: C.ground, borderRadius: 16, padding: "18px 26px" }}>
              <div style={{ display: "flex", fontSize: 30, fontWeight: 800, color: C.ink }}>{h.perMonth ?? `${runCost(h.perRun)} each time`}</div>
              <div style={{ display: "flex", fontSize: 24, color: C.muted }}>{`on ${h.model}`}</div>
            </div>
          )}
        </div>
      </div>
    ),
    size,
  );
}
