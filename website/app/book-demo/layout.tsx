import type { Metadata } from "next";

// The page itself is a client component and cannot export metadata, so the
// route's title/description live here.
export const metadata: Metadata = {
  // Bare title — the root layout's template appends "· Arceo".
  title: "Book a demo",
  description:
    "Bring one real AI agent and we'll put a monthly cost figure and a worst-case dollar number on it with you, on a live walkthrough.",
  alternates: { canonical: "/book-demo" },
};

export default function BookDemoLayout({ children }: { children: React.ReactNode }) {
  return children;
}
