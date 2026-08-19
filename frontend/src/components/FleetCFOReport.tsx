/**
 * Fleet CFO PDF report — a single letter-size page covering the whole fleet.
 *
 * The per-agent equivalent is components/CFOReport.tsx; this is the fleet
 * rollup the AI Spend dashboard exports. Same ink-and-paper idiom, same
 * Courier mono for dollar values. The only input is FleetReportData, shaped
 * by the SpendDashboard from data already fetched from the backend
 * forecaster — no estimation happens in this file, it is pure layout.
 */

import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer"

export interface FleetReportData {
  org: string
  dateString: string
  agentCount: number
  uncalibrated: number
  /** Per-agent confidence tier counts — the band sentence must reflect the
   * real mix, not assert "medium-confidence" for every fleet. */
  tierMix: { high: number; medium: number; low: number }
  totalMonthly: number
  monthlyLow: number
  monthlyHigh: number
  annualRunRate: number
  confidenceBand: string
  composition: { label: string; usd: number; pct: number }[]
  byModel: { name: string; amount: number; pctOfLlm: number }[]
  agents: { name: string; risk: number; monthly: number; annual: number }[]
}

const INK = "#0f172a"
const INK_MUTED = "#475569"
const INK_DIM = "#94a3b8"
const PAPER = "#ffffff"
const HAIRLINE = "#e2e8f0"
const SECTION_BG = "#f8fafc"
const ACCENT = "#0f172a"

const styles = StyleSheet.create({
  page: { backgroundColor: PAPER, padding: 48, fontFamily: "Helvetica", color: INK },

  topbar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderBottomWidth: 1,
    borderBottomColor: INK,
    paddingBottom: 12,
  },
  brand: { fontSize: 16, fontWeight: 700, letterSpacing: 1 },
  brandTagline: { fontSize: 9, color: INK_MUTED, marginTop: 2 },
  topbarMeta: { fontSize: 9, color: INK_MUTED, textAlign: "right", lineHeight: 1.4 },

  intro: { marginTop: 18, marginBottom: 22 },
  introLabel: { fontSize: 9, fontWeight: 700, letterSpacing: 1, color: INK_MUTED },
  introName: { fontSize: 18, fontWeight: 700, marginTop: 4 },
  introDescription: { fontSize: 10, color: INK_MUTED, marginTop: 4, lineHeight: 1.5 },

  section: { marginBottom: 18 },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1.2,
    color: INK_MUTED,
    marginBottom: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: HAIRLINE,
    paddingBottom: 4,
  },

  bigNumber: { fontSize: 32, fontWeight: 700, fontFamily: "Courier", letterSpacing: -0.5 },
  bigRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  bigSuffix: { fontSize: 11, color: INK_MUTED },
  numberRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  numberLabel: { fontSize: 10, color: INK_MUTED },
  numberValue: { fontSize: 10, fontFamily: "Courier", color: INK },
  confidenceLine: { fontSize: 9, color: INK_MUTED, marginTop: 8, lineHeight: 1.5 },

  barRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 },
  barLabel: { fontSize: 10, width: 110, color: INK },
  barValue: { fontSize: 10, fontFamily: "Courier", width: 70, color: INK },
  barPct: { fontSize: 9, color: INK_MUTED, width: 38, textAlign: "right" },
  barTrack: { flex: 1, height: 6, backgroundColor: SECTION_BG, borderRadius: 1, overflow: "hidden" },
  barFill: { height: "100%", backgroundColor: ACCENT },

  // Per-agent table
  tableHead: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: HAIRLINE,
    paddingBottom: 4,
    marginBottom: 2,
  },
  th: { fontSize: 8, fontWeight: 700, letterSpacing: 0.5, color: INK_DIM },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: "#f1f5f9",
    alignItems: "center",
  },
  tdName: { flex: 1, fontSize: 10, color: INK },
  tdRisk: { width: 50, fontSize: 9, fontFamily: "Courier", color: INK_MUTED, textAlign: "right" },
  tdMonthly: { width: 90, fontSize: 10, fontFamily: "Courier", color: INK, textAlign: "right" },
  tdAnnual: { width: 90, fontSize: 10, fontFamily: "Courier", color: INK_MUTED, textAlign: "right" },
  totalRow: { flexDirection: "row", paddingTop: 6, alignItems: "center" },
  totalLabel: { flex: 1, fontSize: 10, fontWeight: 700, color: INK },

  footer: {
    position: "absolute",
    bottom: 24,
    left: 48,
    right: 48,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: INK_DIM,
    borderTopWidth: 0.5,
    borderTopColor: HAIRLINE,
    paddingTop: 8,
  },
})

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString()}`
}

export function FleetCFOReport({ data }: { data: FleetReportData }) {
  const agentWord = data.agentCount === 1 ? "agent" : "agents"
  return (
    <Document title={`${data.org} — Fleet AI Spend Review`}>
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.topbar}>
          <View>
            <Text style={styles.brand}>ARCEO</Text>
            <Text style={styles.brandTagline}>Fleet AI Spend Review</Text>
          </View>
          <View style={styles.topbarMeta}>
            <Text>Prepared for {data.org}</Text>
            <Text>{data.dateString}</Text>
          </View>
        </View>

        {/* Intro */}
        <View style={styles.intro}>
          <Text style={styles.introLabel}>FLEET</Text>
          <Text style={styles.introName}>
            {data.agentCount} forecasted {agentWord}
          </Text>
          <Text style={styles.introDescription}>
            Projected monthly cost of every AI agent currently calibrated in your environment, rolled
            up from each agent's individual forecast.
            {data.uncalibrated > 0
              ? ` ${data.uncalibrated} additional ${data.uncalibrated === 1 ? "agent has" : "agents have"} not yet been simulated and ${data.uncalibrated === 1 ? "is" : "are"} excluded from these totals.`
              : ""}
          </Text>
        </View>

        {/* The number */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>THE NUMBER</Text>
          <View style={styles.bigRow}>
            <Text style={styles.bigNumber}>{fmtUsd(data.totalMonthly)}</Text>
            <Text style={styles.bigSuffix}> per month</Text>
          </View>
          <View style={[styles.numberRow, { marginTop: 8 }]}>
            <Text style={styles.numberLabel}>Likely range ({data.confidenceBand})</Text>
            <Text style={styles.numberValue}>
              {fmtUsd(data.monthlyLow)} – {fmtUsd(data.monthlyHigh)}
            </Text>
          </View>
          <View style={styles.numberRow}>
            <Text style={styles.numberLabel}>Annual run rate at this pace</Text>
            <Text style={styles.numberValue}>{fmtUsd(data.annualRunRate)}</Text>
          </View>
          <Text style={styles.confidenceLine}>
            The {data.confidenceBand} band reflects how much data backs each agent's forecast
            ({data.tierMix.high} high-, {data.tierMix.medium} medium-, {data.tierMix.low} low-confidence),
            not measured run-to-run variance. It tightens as agents accumulate live production data.
          </Text>
        </View>

        {/* Where the money goes */}
        {data.composition.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>WHERE THE MONEY GOES</Text>
            {data.composition.map(c => (
              <View key={c.label} style={styles.barRow}>
                <Text style={styles.barLabel}>{c.label}</Text>
                <Text style={styles.barValue}>{fmtUsd(c.usd)}</Text>
                <Text style={styles.barPct}>{c.pct}%</Text>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { width: `${Math.min(100, Math.max(2, c.pct))}%` }]} />
                </View>
              </View>
            ))}
          </View>
        )}

        {/* By model */}
        {data.byModel.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>BY MODEL (SHARE OF AI USAGE)</Text>
            {data.byModel.map(m => (
              <View key={m.name} style={styles.numberRow}>
                <Text style={styles.numberLabel}>{m.name}</Text>
                <Text style={styles.numberValue}>
                  {fmtUsd(m.amount)} ({m.pctOfLlm}%)
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Per-agent breakdown */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>PER-AGENT BREAKDOWN</Text>
          <View style={styles.tableHead}>
            <Text style={[styles.th, { flex: 1 }]}>AGENT</Text>
            <Text style={[styles.th, { width: 50, textAlign: "right" }]}>RISK</Text>
            <Text style={[styles.th, { width: 90, textAlign: "right" }]}>EST. / MO</Text>
            <Text style={[styles.th, { width: 90, textAlign: "right" }]}>ANNUAL</Text>
          </View>
          {data.agents.map((a, i) => (
            <View key={`${a.name}-${i}`} style={styles.tableRow}>
              <Text style={styles.tdName}>{a.name}</Text>
              <Text style={styles.tdRisk}>{a.risk}</Text>
              <Text style={styles.tdMonthly}>{fmtUsd(a.monthly)}</Text>
              <Text style={styles.tdAnnual}>{fmtUsd(a.annual)}</Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={[styles.tdRisk, { width: 50 }]} />
            <Text style={[styles.tdMonthly, { fontWeight: 700, color: INK }]}>{fmtUsd(data.totalMonthly)}</Text>
            <Text style={[styles.tdAnnual, { fontWeight: 700, color: INK }]}>{fmtUsd(data.annualRunRate)}</Text>
          </View>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <Text>Generated by Arceo · arceo.dev</Text>
          <Text>Fleet review · {data.dateString}</Text>
        </View>
      </Page>
    </Document>
  )
}
