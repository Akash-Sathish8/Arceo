import { ImageResponse } from "next/og";
import C from "../../../lib/palette";
import { BAND, fetchPrompt, headline, runCost } from "../../../lib/prompts";

// Link preview for a shared prompt: title, danger band and score, and what it
// costs to run, so the card in Slack says something worth clicking.
export const alt = "Prompt cost and danger on Arceo";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 300;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await fetchPrompt(id);
  const band = p?.danger_summary ? BAND[p.danger_summary.band] : null;
  const h = p ? headline(p) : null;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: C.paper, padding: "64px 72px", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", fontSize: 28, fontWeight: 700, color: C.ink, letterSpacing: "4px" }}>ARCEO · PROMPTS</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 700, color: C.ink, lineHeight: 1.08, letterSpacing: "-2px", maxWidth: 1050 }}>
            {p ? p.title.slice(0, 80) : "Prompt not found"}
          </div>
          {p?.author_name && <div style={{ display: "flex", fontSize: 28, color: C.muted }}>{`by ${p.author_name}`}</div>}
        </div>
        <div style={{ display: "flex", gap: 24 }}>
          {band && p?.danger_summary && (
            <div style={{ display: "flex", alignItems: "center", gap: 14, background: band.fill, borderRadius: 16, padding: "18px 26px" }}>
              <div style={{ display: "flex", fontSize: 30, fontWeight: 800, color: band.ink, letterSpacing: "1px" }}>{`${band.label.toUpperCase()} DANGER`}</div>
              <div style={{ display: "flex", fontSize: 28, color: band.ink }}>{`${p.danger_summary.score}/100`}</div>
            </div>
          )}
          {h && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, background: C.ground, borderRadius: 16, padding: "18px 26px" }}>
              <div style={{ display: "flex", fontSize: 30, fontWeight: 800, color: C.ink }}>{h.perMonth ?? `${runCost(h.perRun)}/run`}</div>
              <div style={{ display: "flex", fontSize: 24, color: C.muted }}>{`on ${h.model}`}</div>
            </div>
          )}
        </div>
      </div>
    ),
    size,
  );
}
