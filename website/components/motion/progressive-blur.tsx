"use client";

/* Vendored from motion-primitives (ibelick/motion-primitives), MIT.
 *
 * Stacked masked backdrop-filters that ramp blur across an edge. Used on the
 * top and bottom of the hero's audit tape so lines enter and leave the strip
 * instead of being cut off by a hard border. */

import { motion } from "motion/react";

export const GRADIENT_ANGLES = { top: 0, right: 90, bottom: 180, left: 270 };

export type ProgressiveBlurProps = {
  direction?: keyof typeof GRADIENT_ANGLES;
  blurLayers?: number;
  blurIntensity?: number;
  style?: React.CSSProperties;
};

export function ProgressiveBlur({
  direction = "bottom",
  blurLayers = 8,
  blurIntensity = 0.25,
  style,
}: ProgressiveBlurProps) {
  const layers = Math.max(blurLayers, 2);
  const segmentSize = 1 / (blurLayers + 1);

  return (
    <div style={{ position: "relative", ...style }}>
      {Array.from({ length: layers }).map((_, index) => {
        const angle = GRADIENT_ANGLES[direction];
        const gradientStops = [
          index * segmentSize,
          (index + 1) * segmentSize,
          (index + 2) * segmentSize,
          (index + 3) * segmentSize,
        ].map(
          (pos, posIndex) =>
            `rgba(255, 255, 255, ${posIndex === 1 || posIndex === 2 ? 1 : 0}) ${pos * 100}%`,
        );

        const gradient = `linear-gradient(${angle}deg, ${gradientStops.join(", ")})`;

        return (
          <motion.div
            key={index}
            style={{
              pointerEvents: "none",
              position: "absolute",
              inset: 0,
              borderRadius: "inherit",
              maskImage: gradient,
              WebkitMaskImage: gradient,
              backdropFilter: `blur(${index * blurIntensity}px)`,
              WebkitBackdropFilter: `blur(${index * blurIntensity}px)`,
            }}
          />
        );
      })}
    </div>
  );
}
