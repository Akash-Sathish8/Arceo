import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8000";

// Published community prompts are public pages worth indexing. If the backend
// is unreachable at build/revalidate time the static pages still ship.
async function promptUrls(): Promise<MetadataRoute.Sitemap> {
  try {
    const r = await fetch(`${BACKEND}/api/public/prompts`, { next: { revalidate: 3600 } });
    if (!r.ok) return [];
    const data = (await r.json()) as { prompts: { id: string; updated_at: string }[] };
    return data.prompts.map((p) => ({
      url: `${SITE_URL}/p/${p.id}`, lastModified: p.updated_at, changeFrequency: "weekly", priority: 0.5,
    }));
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return [
    { url: SITE_URL, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/security`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/book-demo`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/prompts`, changeFrequency: "monthly", priority: 0.7 },
    ...(await promptUrls()),
  ];
}
