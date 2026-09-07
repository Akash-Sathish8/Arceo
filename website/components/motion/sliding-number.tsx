"use client";

/* Vendored from motion-primitives (ibelick/motion-primitives), MIT.
 *
 * A mechanical odometer: each digit is a column of 0–9 that springs to the
 * right offset. Used for every dollar figure on the site — the numbers are
 * the product, so they arrive the way a meter arrives, not the way a label
 * fades in. */

import { useEffect, useId } from "react";
import { MotionValue, motion, useSpring, useTransform, motionValue } from "motion/react";
import useMeasure from "react-use-measure";

const TRANSITION = {
  type: "spring" as const,
  stiffness: 280,
  damping: 18,
  mass: 0.3,
};

function Digit({ value, place }: { value: number; place: number }) {
  const valueRoundedToPlace = Math.floor(value / place) % 10;
  const initial = motionValue(valueRoundedToPlace);
  const animatedValue = useSpring(initial, TRANSITION);

  useEffect(() => {
    animatedValue.set(valueRoundedToPlace);
  }, [animatedValue, valueRoundedToPlace]);

  return (
    <div
      style={{
        position: "relative",
        display: "inline-block",
        width: "1ch",
        overflowX: "visible",
        overflowY: "clip",
        lineHeight: 1,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <div style={{ visibility: "hidden" }}>0</div>
      {Array.from({ length: 10 }, (_, i) => (
        <Num key={i} mv={animatedValue} number={i} />
      ))}
    </div>
  );
}

function Num({ mv, number }: { mv: MotionValue<number>; number: number }) {
  const uniqueId = useId();
  const [ref, bounds] = useMeasure();

  const y = useTransform(mv, (latest) => {
    if (!bounds.height) return 0;
    const placeValue = latest % 10;
    const offset = (10 + number - placeValue) % 10;
    let memo = offset * bounds.height;
    if (offset > 5) memo -= 10 * bounds.height;
    return memo;
  });

  if (!bounds.height) {
    return (
      <span ref={ref} style={{ visibility: "hidden", position: "absolute" }}>
        {number}
      </span>
    );
  }

  return (
    <motion.span
      style={{
        y,
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      layoutId={`${uniqueId}-${number}`}
      transition={TRANSITION}
      ref={ref}
    >
      {number}
    </motion.span>
  );
}

type SlidingNumberProps = {
  value: number;
  padStart?: boolean;
  decimalSeparator?: string;
};

export function SlidingNumber({
  value,
  padStart = false,
  decimalSeparator = ".",
}: SlidingNumberProps) {
  const absValue = Math.abs(value);
  const [integerPart, decimalPart] = absValue.toString().split(".");
  const integerValue = parseInt(integerPart, 10);
  const paddedInteger = padStart && integerValue < 10 ? `0${integerPart}` : integerPart;
  const integerDigits = paddedInteger.split("");
  const integerPlaces = integerDigits.map((_, i) => Math.pow(10, integerDigits.length - i - 1));

  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {value < 0 && "-"}
      {integerDigits.map((_, index) => (
        <Digit key={`pos-${integerPlaces[index]}`} value={integerValue} place={integerPlaces[index]} />
      ))}
      {decimalPart && (
        <>
          <span>{decimalSeparator}</span>
          {decimalPart.split("").map((_, index) => (
            <Digit
              key={`decimal-${index}`}
              value={parseInt(decimalPart, 10)}
              place={Math.pow(10, decimalPart.length - index - 1)}
            />
          ))}
        </>
      )}
    </div>
  );
}
