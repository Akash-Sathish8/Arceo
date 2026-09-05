/**
 * Fleet spend-forecast trend card — sits between the Agents page header and
 * the tab bar.
 *
 * ⚠️ SAMPLE DATA for layout review: the series below is hardcoded and badged
 * "Sample data" in the UI. The real series comes from the backend's
 * `forecast_snapshots` table (jobs/snapshot_forecasts.py) once an endpoint
 * exposes it — swap SAMPLE for that fetch and delete the badge.
 *
 * Chart decisions (dataviz pass): single series → no legend, the title names
 * it; line stroke uses --accent-ink (#092C6E, 13.15:1 on the card surface).
 * The contrast caveat here predated the brand palette — the old Carolina
 * --accent failed and only painted the area fill; brand deep blue #0E3C90 is
 * 10.16:1, so both members now clear it. Hover = crosshair + nearest-point
 * tooltip with a white-ringed dot.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { formatMoney } from "@/lib/format";

const SAMPLE: { week: string; value: number }[] = [
  { week: "Jun 8",  value: 3120 },
  { week: "Jun 15", value: 3180 },
  { week: "Jun 22", value: 3095 },
  { week: "Jun 29", value: 3240 },
  { week: "Jul 6",  value: 3310 },
  { week: "Jul 13", value: 3290 },
  { week: "Jul 20", value: 3455 },
  { week: "Jul 27", value: 3620 },
  { week: "Aug 3",  value: 3580 },
  { week: "Aug 10", value: 3790 },
  { week: "Aug 17", value: 4060 },
  { week: "Aug 24", value: 4280 },
];

const CHART_H = 150;
const PAD = { top: 10, right: 14, bottom: 22, left: 48 };
/** Weeks back for the headline delta ("vs 4 wks ago"). */
const DELTA_LOOKBACK = 4;

function useContainerWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export default function SpendTrendCard({ compact = false }: { compact?: boolean } = {}): React.ReactElement {
  const { ref, width } = useContainerWidth();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const series = SAMPLE;
  const values = series.map((d) => d.value);
  const last = values[values.length - 1];
  const prior = values[values.length - 1 - DELTA_LOOKBACK];
  const deltaPct = ((last - prior) / prior) * 100;
  const rising = deltaPct >= 0;

  const geom = useMemo(() => {
    const innerW = Math.max(0, width - PAD.left - PAD.right);
    const innerH = CHART_H - PAD.top - PAD.bottom;
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = Math.max(1, hi - lo);
    const yMin = Math.max(0, Math.floor((lo - span * 0.15) / 100) * 100);
    const yMax = Math.ceil((hi + span * 0.1) / 100) * 100;
    const x = (i: number) => PAD.left + (i / (values.length - 1)) * innerW;
    const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;
    const pts = values.map((v, i) => ({ x: x(i), y: y(v) }));
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
    const baseline = PAD.top + innerH;
    const area = `${line} L${pts[pts.length - 1].x},${baseline} L${pts[0].x},${baseline} Z`;
    const ticks = [yMin, (yMin + yMax) / 2, yMax];
    return { pts, line, area, baseline, ticks, yMin, yMax, y };
  }, [width, values]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = 0;
    for (let i = 1; i < geom.pts.length; i++) {
      if (Math.abs(geom.pts[i].x - mx) < Math.abs(geom.pts[best].x - mx)) best = i;
    }
    setHoverIdx(best);
  };

  const hover = hoverIdx !== null ? { ...series[hoverIdx], ...geom.pts[hoverIdx] } : null;

  return (
    <div
      style={compact
        ? { fontFamily: "var(--font-sans)" }
        : {
            background: "var(--card)",
            border: "1px solid var(--line)",
            borderRadius: 12,
            padding: "18px 24px 12px",
            boxShadow: "var(--shadow-card-new)",
            margin: "24px 0 0",
            fontFamily: "var(--font-sans)",
          }}
    >
      <div style={{ display: compact ? "none" : "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <div
            style={{
              fontSize: "var(--fs-micro)", fontWeight: 600, textTransform: "uppercase",
              letterSpacing: 0.5, color: "var(--ink-400)",
            }}
          >
            Fleet spend forecast
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 3 }}>
            <span className="mono" style={{ fontSize: 24, fontWeight: 700, letterSpacing: -0.4, color: "var(--ink-900)" }}>
              {formatMoney(last)}
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-500)" }}> / mo</span>
            </span>
            <span
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 12, fontWeight: 600,
                color: rising ? "var(--caution)" : "var(--safe)",
                background: rising ? "var(--caution-bg)" : "var(--safe-bg)",
                border: `1px solid ${rising ? "var(--caution-line)" : "var(--safe-line)"}`,
                borderRadius: 7, padding: "2px 8px",
              }}
            >
              {rising ? <TrendingUp size={12} strokeWidth={2} /> : <TrendingDown size={12} strokeWidth={2} />}
              {rising ? "+" : ""}{deltaPct.toFixed(1)}% vs {DELTA_LOOKBACK} wks ago
            </span>
          </div>
        </div>
        <span
          title="Placeholder series, to be wired to forecast snapshots"
          style={{
            fontSize: 11, fontWeight: 500, color: "var(--ink-400)",
            border: "1px dashed var(--line)", borderRadius: 6, padding: "3px 8px", whiteSpace: "nowrap",
          }}
        >
          Sample data
        </span>
      </div>

      {compact && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
          <span
            title="Placeholder series, to be wired to forecast snapshots"
            style={{
              fontSize: 11, fontWeight: 500, color: "var(--ink-400)",
              border: "1px dashed var(--line)", borderRadius: 6, padding: "3px 8px", whiteSpace: "nowrap",
            }}
          >
            Sample data
          </span>
        </div>
      )}
      <div ref={ref} style={{ position: "relative" }}>
        {width > 0 && (
          <svg
            width={width}
            height={CHART_H}
            role="img"
            aria-label={`Fleet spend forecast, sample data: last ${series.length} weeks from ${formatMoney(values[0])} to ${formatMoney(last)} per month`}
            onMouseMove={onMove}
            onMouseLeave={() => setHoverIdx(null)}
            style={{ display: "block", cursor: "crosshair" }}
          >
            {/* Recessive horizontal grid + $ tick labels */}
            {geom.ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={geom.y(t)} y2={geom.y(t)} stroke="var(--line-soft)" />
                <text x={PAD.left - 8} y={geom.y(t) + 3.5} textAnchor="end" fontSize={11} fill="var(--ink-400)">
                  {formatMoney(t, { compact: true })}
                </text>
              </g>
            ))}
            {/* Sparse x labels: every 3rd week + the last */}
            {series.map((d, i) =>
              i % 3 === 0 || i === series.length - 1 ? (
                <text key={d.week} x={geom.pts[i].x} y={CHART_H - 6} textAnchor="middle" fontSize={11} fill="var(--ink-400)">
                  {d.week}
                </text>
              ) : null,
            )}
            <path d={geom.area} fill="var(--accent)" opacity={0.1} />
            <path d={geom.line} fill="none" stroke="var(--accent-ink)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            {hover && (
              <g>
                <line x1={hover.x} x2={hover.x} y1={PAD.top} y2={geom.baseline} stroke="var(--ink-300)" strokeDasharray="3 3" />
                <circle cx={hover.x} cy={hover.y} r={4.5} fill="var(--accent-ink)" stroke="var(--card)" strokeWidth={2} />
              </g>
            )}
          </svg>
        )}
        {hover && (
          <div
            style={{
              position: "absolute",
              left: Math.min(Math.max(hover.x, 60), width - 60),
              top: hover.y - 12,
              transform: "translate(-50%, -100%)",
              background: "var(--ink-900)",
              color: "var(--card)",
              borderRadius: 7,
              padding: "5px 10px",
              fontSize: 12,
              whiteSpace: "nowrap",
              pointerEvents: "none",
              boxShadow: "var(--shadow-card-new)",
            }}
          >
            <span style={{ opacity: 0.75 }}>{hover.week}</span>{" "}
            <span className="mono" style={{ fontWeight: 600 }}>{formatMoney(hover.value)}/mo</span>
          </div>
        )}
      </div>
    </div>
  );
}
