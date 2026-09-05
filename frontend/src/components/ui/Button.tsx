/**
 * The product's action button.
 *
 * Shape and voice come from one place — the `.btn` classes in index.css,
 * taken from the Sandbox "New Simulation" button (the label type step, 4px
 * corner, 16/8 padding). Variants only change colour; nothing here
 * may change the geometry, or the buttons drift apart again.
 *
 * This is for ACTIONS. Tabs, segmented controls and icon-only toggles are
 * different controls and should not use it.
 */

import { forwardRef } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "ghost-dark" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn--primary",
  secondary: "btn--secondary",
  ghost: "btn--ghost",
  // Kept under its old name so existing callers on dark surfaces don't break.
  "ghost-dark": "btn--on-dark",
  destructive: "btn--danger",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "btn--sm",
  md: "",
  lg: "btn--lg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = "primary", size = "md", loading = false, icon, children, className, disabled, ...props },
    ref,
  ) => {
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={["btn", VARIANT_CLASS[variant], SIZE_CLASS[size], className]
          .filter(Boolean)
          .join(" ")}
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
