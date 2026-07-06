import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import EmptyState from "@/components/shared/EmptyState";

/**
 * Real 404 — replaces the silent `<Navigate to="/" />` catch-all that dumped
 * users on the dashboard with no explanation.
 */
export default function NotFound() {
  return (
    <div style={{ padding: "80px 24px" }}>
      <EmptyState
        icon={<Compass size={22} />}
        title="Page not found"
        body="That URL doesn't match anything in Arceo. It may have moved, or the link was mistyped."
        action={
          <Link
            to="/"
            className="ag-btn"
            style={{
              display: "inline-flex", alignItems: "center",
              background: "var(--accent)", color: "#fff",
              padding: "9px 18px", borderRadius: "var(--radius-md)",
              fontSize: "var(--fs-small)", fontWeight: 600, textDecoration: "none",
            }}
          >
            Back to agents
          </Link>
        }
      />
    </div>
  );
}
