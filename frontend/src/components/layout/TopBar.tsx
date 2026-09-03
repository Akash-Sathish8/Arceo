/**
 * Fixed top bar — ported from the Stitch canvas (every desktop screen carries
 * it): breadcrumb on the left, search + notifications on the right, sitting on
 * a translucent blur over the tinted `surface`.
 *
 * Stitch drew it with a placeholder crumb ("System › Active View") and inert
 * icons. Here the crumb is derived from the route and both controls do real
 * work — search opens the ⌘K palette, the bell routes to Approvals and shows
 * the same pending count the rail badges.
 */

import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Bell, ChevronRight, Search } from "lucide-react";
import { apiFetch, isLoggedIn } from "@/lib/api";
import { useCommandPaletteStore } from "@/store/commandPalette";

/** Top-level route → crumb. Deeper crumbs are appended by the route params. */
const SECTION: Record<string, string> = {
  "": "Agents",
  agent: "Agents",
  approvals: "Approvals",
  history: "History",
  executions: "History",
  audit: "History",
  spend: "Spend",
  sandbox: "Sandbox",
  sweep: "Sandbox",
  workflows: "Workflows",
  compare: "Compare",
  settings: "Settings",
};

const LEAF: Record<string, string> = {
  spend: "Cost portfolio",
  policies: "Policies",
};

function useCrumbs(): string[] {
  const { pathname } = useLocation();
  const params = useParams();
  const segments = pathname.split("/").filter(Boolean);
  const section = SECTION[segments[0] ?? ""] ?? "Arceo";

  // An id segment is noise in a breadcrumb; the page's own header names the
  // record. Only a trailing view name earns a second crumb.
  const last = segments[segments.length - 1];
  const isId = last !== undefined && Object.values(params).includes(last);
  const leaf = !isId && segments.length > 1 ? LEAF[last ?? ""] : undefined;

  return leaf ? [section, leaf] : [section];
}

export default function TopBar(): React.ReactElement {
  const crumbs = useCrumbs();
  const openPalette = useCommandPaletteStore((s) => s.setOpen);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    if (!isLoggedIn()) return;
    async function poll() {
      if (document.hidden) return;
      try {
        const data = await apiFetch<{ approvals?: { status: string }[] }>(
          "/api/approvals",
          { skipLogoutOn401: true }
        );
        setPending((data?.approvals ?? []).filter((a) => a.status === "PENDING_APPROVAL").length);
      } catch {
        /* a badge is not worth an error surface */
      }
    }
    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="sticky top-0 z-40 h-16 flex items-center justify-between px-container-padding bg-surface/80 backdrop-blur-xl border-b border-neutral-border">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-meta font-meta text-neutral-secondary">
        {crumbs.map((c, i) => (
          <span key={c} className="flex items-center gap-2">
            {i > 0 && <ChevronRight size={14} strokeWidth={2} />}
            <span className={i === crumbs.length - 1 ? "text-on-surface font-medium" : undefined}>{c}</span>
          </span>
        ))}
      </nav>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => openPalette(true)}
          aria-label="Search (⌘K)"
          title="Search  ⌘K"
          className="p-2 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors bg-transparent border-0 cursor-pointer"
        >
          <Search size={18} strokeWidth={1.8} />
        </button>
        <Link
          to="/approvals"
          aria-label={pending > 0 ? `${pending} approvals waiting` : "Approvals"}
          title={pending > 0 ? `${pending} waiting` : "Approvals"}
          className="p-2 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors relative"
        >
          <Bell size={18} strokeWidth={1.8} />
          {pending > 0 && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-error ring-2 ring-surface" />
          )}
        </Link>
      </div>
    </header>
  );
}
