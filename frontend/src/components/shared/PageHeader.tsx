import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Optional deep-link-safe back link (never navigate(-1)). */
  back?: { to: string; label: string };
  /** Optional link under the description (e.g. a creator's page). */
  byline?: { to: string; label: string };
}

/**
 * The one page header. Replaces per-page marketing hero blocks (32px accent
 * "Welcome back" etc.) with a consistent title / description / actions row on
 * the --fs-page type scale.
 */
export default function PageHeader({ title, description, actions, back, byline }: PageHeaderProps) {
  return (
    <div style={{ marginBottom: 24 }}>
      {back && (
        <Link
          to={back.to}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            fontSize: "var(--fs-small)", color: "var(--ink-500)",
            textDecoration: "none", marginBottom: 10,
          }}
        >
          <ArrowLeft size={13} /> {back.label}
        </Link>
      )}
      {/* Wraps on narrow screens so actions drop below the title instead of overlapping it. */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: "var(--fs-page)", fontWeight: 600, color: "var(--ink-900)", lineHeight: 1.2 }}>
            {title}
          </h1>
          {description && (
            <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 5, maxWidth: 560, lineHeight: 1.5 }}>
              {description}
            </p>
          )}
          {byline && (
            <Link to={byline.to} style={{ display: "inline-block", fontSize: "var(--fs-small)", color: "var(--accent)", marginTop: 4, textDecoration: "none" }}>
              {byline.label} →
            </Link>
          )}
        </div>
        {actions && <div style={{ flexShrink: 0, maxWidth: "100%", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{actions}</div>}
      </div>
    </div>
  );
}
