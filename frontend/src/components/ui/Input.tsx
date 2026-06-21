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
              left: 10,
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
            background: "var(--bg-sunken)",
            border: `2px solid ${focused ? "var(--border-focus)" : "transparent"}`,
            borderRadius: "var(--radius-md)",
            color: "var(--text-primary)",
            padding: icon ? "0 12px 0 34px" : "0 12px",
            height: 36,
            width: "100%",
            fontSize: 13,
            outline: "none",
            fontFamily: "inherit",
            transition: "border-color 100ms",
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
