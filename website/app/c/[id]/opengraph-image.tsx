import { ImageResponse } from "next/og";
import C from "../../../lib/palette";
import { fetchComparison, modelName } from "../../../lib/prompts";

// Link preview for an old comparison link: title and how many prompts took
// part. No leader, votes or ranking.
export const alt = "Prompts for the same job on Arceo";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 300;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await fetchComparison(id);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: C.paper, padding: "64px 72px", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", fontSize: 28, fontWeight: 700, color: C.ink, letterSpacing: "1px" }}>ARCEO · PROMPTS</div>
        <div style={{ display: "flex", fontSize: 64, fontWeight: 700, color: C.ink, lineHeight: 1.08, letterSpacing: "-2px", maxWidth: 1050 }}>
          {c ? (c.title.length > 80 ? `${c.title.slice(0, 79)}…` : c.title) : "Comparison not found"}
        </div>
        <div style={{ display: "flex", gap: 24, fontSize: 28, color: C.muted }}>
          {c && <div style={{ display: "flex" }}>{`${c.entry_count} ${c.entry_count === 1 ? "prompt" : "prompts"} for the same job · on ${modelName(c.model)}`}</div>}
        </div>
      </div>
    ),
    size,
  );
}
