/**
 * CFO PDF report — a single letter-size page.
 *
 * The only input is CFOReportData from lib/cfoReport.ts. Everything in this
 * file is layout — no data shaping. If a string in the rendered PDF looks
 * wrong, the fix is in cfoReport.ts (translation) or this file (layout),
 * not in the calling component.
 */

import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer"
import type { CFOReportData } from "@/lib/cfoReport"

// ── Tokens ──────────────────────────────────────────────────────────────────
// Match the in-app Cost Portfolio idiom: ink-and-paper, Courier mono for
// dollar values (react-pdf's built-in), single accent color for the headline.

const INK = "#0f172a"
const INK_MUTED = "#475569"
const INK_DIM = "#94a3b8"
const PAPER = "#ffffff"
const HAIRLINE = "#e2e8f0"
const SECTION_BG = "#f8fafc"
const ACCENT = "#0f172a"
const WARN = "#b45309"
const WARN_BG = "#fef3c7"
const SAFE = "#15803d"

const styles = StyleSheet.create({
  page: {
    backgroundColor: PAPER,
    padding: 48,
    fontFamily: "Helvetica",
    color: INK,
  },

  // Header
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

  // Agent intro
  agentBlock: { marginTop: 18, marginBottom: 22 },
  agentLabel: { fontSize: 9, fontWeight: 700, letterSpacing: 1, color: INK_MUTED },
  agentName: { fontSize: 18, fontWeight: 700, marginTop: 4 },
  agentDescription: { fontSize: 10, color: INK_MUTED, marginTop: 4, lineHeight: 1.5 },

  // Section
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

  // The number
  bigNumber: { fontSize: 32, fontWeight: 700, fontFamily: "Courier", letterSpacing: -0.5 },
  bigRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  bigSuffix: { fontSize: 11, color: INK_MUTED },
  numberRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  numberLabel: { fontSize: 10, color: INK_MUTED },
  numberValue: { fontSize: 10, fontFamily: "Courier", color: INK },
  confidenceLine: { fontSize: 9, color: INK_MUTED, marginTop: 8, lineHeight: 1.5 },
  badge: {
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: 1,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 2,
    marginLeft: 6,
  },
  badgeLow:    { backgroundColor: WARN_BG, color: WARN },
  badgeMedium: { backgroundColor: WARN_BG, color: WARN },
  badgeHigh:   { backgroundColor: "#dcfce7", color: SAFE },

  // Composition (where money goes)
  barRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 3,
  },
  barLabel: { fontSize: 10, width: 110, color: INK },
  barValue: { fontSize: 10, fontFamily: "Courier", width: 60, color: INK },
  barPct: { fontSize: 9, color: INK_MUTED, width: 38, textAlign: "right" },
  barTrack: { flex: 1, height: 6, backgroundColor: SECTION_BG, borderRadius: 1, overflow: "hidden" },
  barFill: { height: "100%", backgroundColor: ACCENT },

  // Worst case
  worstCaseBox: {
    backgroundColor: WARN_BG,
    borderLeftWidth: 3,
    borderLeftColor: WARN,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 4,
  },
  worstUsd: { fontSize: 22, fontWeight: 700, fontFamily: "Courier", color: WARN },
  worstScenario: { fontSize: 10, color: INK, marginTop: 4, lineHeight: 1.5 },
  worstStatus: { fontSize: 9, color: WARN, fontWeight: 700, marginTop: 6, letterSpacing: 0.5 },
  worstStatusEnforced: { fontSize: 9, color: SAFE, fontWeight: 700, marginTop: 6, letterSpacing: 0.5 },
  otherRiskRow: { flexDirection: "row", paddingVertical: 3, alignItems: "flex-start" },
  otherRiskBullet: { fontSize: 10, color: INK_MUTED, width: 12 },
  otherRiskText: { flex: 1, fontSize: 10, color: INK_MUTED, lineHeight: 1.5 },
  otherRiskStatus: { fontSize: 8, fontWeight: 700, marginLeft: 4 },

  // Recommendations
  recRow: { flexDirection: "row", paddingVertical: 4, alignItems: "flex-start" },
  recNum: {
    fontSize: 10,
    fontWeight: 700,
    width: 20,
    color: INK,
    fontFamily: "Courier",
  },
  recText: { flex: 1, fontSize: 10, color: INK, lineHeight: 1.5 },

  // Footer
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

function Badge({ tone, label }: { tone: "low" | "medium" | "high"; label: string }) {
  const style =
    tone === "low" ? styles.badgeLow : tone === "medium" ? styles.badgeMedium : styles.badgeHigh
  return <Text style={[styles.badge, style]}>{label} CONFIDENCE</Text>
}

export function CFOReport({ data }: { data: CFOReportData }) {
  return (
    <Document title={`${data.agentDisplayName} — CFO Report`}>
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.topbar}>
          <View>
            <Text style={styles.brand}>ARCEO</Text>
            <Text style={styles.brandTagline}>AI Agent Spend & Risk Review</Text>
          </View>
          <View style={styles.topbarMeta}>
            <Text>Prepared for {data.org}</Text>
            <Text>{data.dateString}</Text>
          </View>
        </View>

        {/* Agent intro */}
        <View style={styles.agentBlock}>
          <Text style={styles.agentLabel}>AGENT</Text>
          <Text style={styles.agentName}>{data.agentDisplayName}</Text>
          <Text style={styles.agentDescription}>{data.whatItDoes}</Text>
        </View>

        {/* The number */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>THE NUMBER</Text>

          <View style={styles.bigRow}>
            <Text style={styles.bigNumber}>{fmtUsd(data.monthly)}</Text>
            <Text style={styles.bigSuffix}> per month</Text>
            <Badge tone={data.confidenceBadge.tone} label={data.confidenceBadge.label} />
          </View>

          <View style={[styles.numberRow, { marginTop: 8 }]}>
            <Text style={styles.numberLabel}>Likely range</Text>
            <Text style={styles.numberValue}>
              {fmtUsd(data.monthlyLow)} – {fmtUsd(data.monthlyHigh)}
            </Text>
          </View>
          <View style={styles.numberRow}>
            <Text style={styles.numberLabel}>Annualized at this rate</Text>
            <Text style={styles.numberValue}>{fmtUsd(data.annual)}</Text>
          </View>

          <Text style={styles.confidenceLine}>{data.confidenceLine}</Text>
        </View>

        {/* Where the money goes */}
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

          <View style={[styles.numberRow, { marginTop: 10 }]}>
            <Text style={styles.numberLabel}>Biggest single line item</Text>
            <Text style={styles.numberValue}>
              {data.topDriverLabel} · {fmtUsd(data.topDriverMonthly)}/mo
            </Text>
          </View>
          {data.topUnitCost && (
            <View style={styles.numberRow}>
              <Text style={styles.numberLabel}>{data.topUnitCost.label}</Text>
              <Text style={styles.numberValue}>{data.topUnitCost.value}</Text>
            </View>
          )}
        </View>

        {/* Worst-case exposure */}
        {data.worstCase && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>WORST-CASE EXPOSURE</Text>
            <Text style={[styles.numberLabel, { marginBottom: 6 }]}>
              The largest single-incident loss we've identified:
            </Text>
            <View style={styles.worstCaseBox}>
              <Text style={styles.worstUsd}>{fmtUsd(data.worstCase.usd)}</Text>
              <Text style={styles.worstScenario}>{data.worstCase.scenario}</Text>
              <Text style={data.worstCase.enforced ? styles.worstStatusEnforced : styles.worstStatus}>
                {data.worstCase.enforced
                  ? "STATUS: BLOCKED today by an existing rule."
                  : "STATUS: NOT yet blocked. See recommendations below."}
              </Text>
            </View>

            {data.otherRisks.length > 0 && (
              <View style={{ marginTop: 10 }}>
                <Text style={[styles.numberLabel, { marginBottom: 4 }]}>Other risks identified:</Text>
                {data.otherRisks.map((r, i) => (
                  <View key={i} style={styles.otherRiskRow}>
                    <Text style={styles.otherRiskBullet}>•</Text>
                    <Text style={styles.otherRiskText}>
                      {r.description} Worst case: {fmtUsd(r.maxUsd)}.{" "}
                      <Text style={[styles.otherRiskStatus, { color: r.enforced ? SAFE : WARN }]}>
                        {r.enforced ? "BLOCKED" : "NOT BLOCKED"}
                      </Text>
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Recommended actions */}
        {data.recommendedActions.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>RECOMMENDED ACTIONS</Text>
            {data.recommendedActions.map((rec, i) => (
              <View key={i} style={styles.recRow}>
                <Text style={styles.recNum}>{i + 1}.</Text>
                <Text style={styles.recText}>{rec}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Footer */}
        <View style={styles.footer}>
          <Text>Generated by Arceo · arceo.dev</Text>
          <Text>{data.agentDisplayName} · {data.dateString}</Text>
        </View>
      </Page>
    </Document>
  )
}
