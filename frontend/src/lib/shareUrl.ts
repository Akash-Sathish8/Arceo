/** Public share links. On a deploy, VITE_SHARE_URL points at the marketing site,
 *  which renders /p/:id and /c/:id with link previews (OG tags); locally the
 *  app's own public pages are used. */
const base = ((import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.VITE_SHARE_URL || "").replace(/\/$/, "")

export function shareUrl(kind: "p" | "c", id: string): string {
  return `${base || window.location.origin}/${kind}/${id}`
}
