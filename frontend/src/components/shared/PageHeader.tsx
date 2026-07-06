import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /** Optional deep-link-safe back link (never navigate(-1)). */
  back?: { to: string; label: string };
}

/**
 * The one page header. Replaces per-page marketing hero blocks (32px accent
 * "Welcome back" etc.) with a consistent title / description / actions row on
 * the --fs-page type scale.
 */
export default function PageHeader({ title, description, actions, back }: PageHeaderProps) {
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
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: "var(--fs-page)", fontWeight: 600, color: "var(--ink-900)", lineHeight: 1.2 }}>
            {title}
          </h1>
          {description && (
            <p style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)", marginTop: 5, maxWidth: 560, lineHeight: 1.5 }}>
              {description}
            </p>
          )}
        </div>
        {actions && <div style={{ flexShrink: 0, display: "flex", gap: 8, alignItems: "center" }}>{actions}</div>}
      </div>
    </div>
  );
}
