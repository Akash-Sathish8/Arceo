import { forwardRef, useState } from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ icon, style, onFocus, onBlur, ...props }, ref) => {
    const [focused, setFocused] = useState(false);

    return (
      <div style={{ position: "relative", display: "flex", alignItems: "center", width: "100%" }}>
        {icon && (
          <span
            style={{
              position: "absolute",
              left: 12,
              color: "var(--text-muted)",
              pointerEvents: "none",
              display: "flex",
              alignItems: "center",
            }}
          >
            {icon}
          </span>
        )}
        <input
          ref={ref}
          style={{
            background: "var(--paper)",
            border: `1px solid ${focused ? "var(--accent)" : "var(--line)"}`,
            boxShadow: focused ? "0 0 0 1px var(--accent)" : "var(--shadow-2xs)",
            borderRadius: "var(--radius-md)",
            color: "var(--text-primary)",
            padding: icon ? "8px 12px 8px 36px" : "8px 12px",
            width: "100%",
            fontSize: 14,
            lineHeight: "20px",
            outline: "none",
            fontFamily: "inherit",
            transition: "border-color 200ms, box-shadow 200ms",
            ...style,
          }}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          {...props}
        />
      </div>
    );
  },
);

Input.displayName = "Input";
