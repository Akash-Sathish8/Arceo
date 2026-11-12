/** Canonical public origin. Override with NEXT_PUBLIC_SITE_URL per environment. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://arceoai.app";

export const SITE_NAME = "Arceo";

export const SITE_TAGLINE = "Safe, fast AI for every team";

export const SITE_DESCRIPTION =
  "Arceo warns you before a prompt or an AI agent does something risky. It gives every team prompts that already work, and shows what each one costs.";

/** The app. In dev it falls back to the local Vite server; a production build
 *  without NEXT_PUBLIC_APP_URL hides app links rather than ship localhost. */
export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? (process.env.NODE_ENV === "development" ? "http://localhost:5173" : null);
