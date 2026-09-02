"use client";

/* Vendored from motion-primitives (ibelick/motion-primitives), MIT.
 *
 * A light that travels the border of its container. Spent once on the whole
 * site, on the card where a dangerous chain is being detected: the trail is
 * the scan, so the motion means something. */

import { motion, Transition } from "motion/react";

export type BorderTrailProps = {
  size?: number;
  transition?: Transition;
  onAnimationComplete?: () => void;
  style?: React.CSSProperties;
};

export function BorderTrail({
  size = 60,
  transition,
  onAnimationComplete,
  style,
}: BorderTrailProps) {
  const defaultTransition: Transition = {
    repeat: Infinity,
    duration: 5,
    ease: "linear",
  };

  return (
    <div
      style={{
        pointerEvents: "none",
        position: "absolute",
        inset: 0,
        borderRadius: "inherit",
        border: "1px solid transparent",
        maskClip: "padding-box, border-box",
        maskComposite: "intersect",
        WebkitMaskComposite: "source-in",
        maskImage:
          "linear-gradient(transparent, transparent), linear-gradient(#000, #000)",
        WebkitMaskImage:
          "linear-gradient(transparent, transparent), linear-gradient(#000, #000)",
      }}
    >
      <motion.div
        style={{
          position: "absolute",
          aspectRatio: "1 / 1",
          width: size,
          offsetPath: `rect(0 auto auto 0 round ${size}px)`,
          ...style,
        }}
        animate={{ offsetDistance: ["0%", "100%"] }}
        transition={transition || defaultTransition}
        onAnimationComplete={onAnimationComplete}
      />
    </div>
  );
}
