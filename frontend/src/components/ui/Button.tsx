import { forwardRef } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "ghost-dark" | "destructive";
export type ButtonSize = "sm" | "md";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  "ghost-dark": "btn-ghost-dark",
  destructive: "btn-destructive",
};

const VARIANT_STYLES: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: "var(--color-cta)",
    color: "#ffffff",
    border: "none",
    fontFamily: "var(--font-sans)",
    letterSpacing: "-0.01em",
  },
  secondary: {
    background: "transparent",
    color: "var(--text-primary)",
    border: "1px solid var(--border-strong)",
    fontFamily: "var(--font-sans)",
    letterSpacing: "-0.01em",
  },
  ghost: {
    background: "transparent",
    color: "var(--text-secondary)",
    border: "none",
    fontFamily: "var(--font-sans)",
  },
  "ghost-dark": {
    background: "rgba(255,255,255,0.08)",
    color: "var(--text-inverse)",
    border: "1px solid rgba(255,255,255,0.14)",
    fontFamily: "var(--font-sans)",
  },
  destructive: {
    background: "var(--severity-critical)",
    color: "#ffffff",
    border: "none",
    fontFamily: "var(--font-sans)",
  },
};

const SIZE_STYLES: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: "6px 14px", fontSize: 12, borderRadius: "var(--radius-full)" },
  md: { padding: "8px 20px", fontSize: 13, borderRadius: "var(--radius-full)" },
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = "primary", size = "md", loading = false, icon, children, style, disabled, ...props },
    ref,
  ) => {
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={VARIANT_CLASS[variant]}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: isDisabled ? "not-allowed" : "pointer",
          opacity: isDisabled ? 0.5 : 1,
          transition: "background 150ms, border-color 150ms, box-shadow 150ms, opacity 150ms",
          lineHeight: 1,
          ...VARIANT_STYLES[variant],
          ...SIZE_STYLES[size],
          ...style,
        }}
        {...props}
      >
        {loading && (
          <span
            style={{
              width: 12,
              height: 12,
              border: "2px solid currentColor",
              borderTopColor: "transparent",
              borderRadius: "50%",
              display: "inline-block",
              animation: "btn-spin 0.6s linear infinite",
              flexShrink: 0,
            }}
          />
        )}
        {!loading && icon}
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";
