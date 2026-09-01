import { useRef } from "react";
import type { CSSProperties } from "react";

export interface TabDef<T extends string = string> {
  id: T;
  label: string;
  /** Optional mono count rendered after the label (fleet/chain counts). */
  count?: number;
  /** Optional critical-severity dot (e.g. "needs attention" markers). */
  dot?: boolean;
}

interface TabsProps<T extends string> {
  tabs: TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Container style overrides (margins vary by page). */
  style?: CSSProperties;
}

/**
 * The one page-level tab bar — accent underline on a hairline rule (the
 * Authority pattern). Proper tablist semantics with roving tabindex:
 * Left/Right/Home/End move focus and select.
 */
export default function Tabs<T extends string>({ tabs, active, onChange, style }: TabsProps<T>) {
  const refs = useRef<Map<T, HTMLButtonElement>>(new Map());

  const focusAndSelect = (id: T) => {
    onChange(id);
    refs.current.get(id)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next !== null) {
      e.preventDefault();
      focusAndSelect(tabs[next].id);
    }
  };

  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 26,
        borderBottom: "1px solid var(--line)",
        margin: "24px 0 26px",
        ...style,
      }}
    >
      {tabs.map((t, idx) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className="ag-tab"
            style={{
              background: "transparent",
              border: "none",
              padding: "11px 2px",
              fontSize: 14.5,
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "var(--accent)" : "var(--ink-500)",
              borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
              marginBottom: -1,
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className="mono"
                style={{ fontSize: 12.5, color: isActive ? "var(--accent-ink)" : "var(--ink-400)" }}
              >
                {t.count}
              </span>
            )}
            {t.dot && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--critical)",
                  flexShrink: 0,
                  display: "inline-block",
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
