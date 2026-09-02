import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/* Class merger used by the vendored motion-primitives components. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
