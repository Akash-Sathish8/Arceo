/**
 * Canonical public origin for the marketing site.
 *
 * Used for metadataBase, sitemap, robots and OG image URLs. Override with
 * NEXT_PUBLIC_SITE_URL per environment (preview deploys, staging).
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://arceo.io";

export const SITE_NAME = "Arceo";

export const SITE_TAGLINE = "Cost and risk forecasting for AI agents";

export const SITE_DESCRIPTION =
  "Arceo tells you what your AI agent will cost to run, and what happens if it goes wrong, before you put it in production. One report your finance team can read. Works with Anthropic, OpenAI, MCP, and GitHub.";
