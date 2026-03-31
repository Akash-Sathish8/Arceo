import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Arceo — AI Agent Security",
  description:
    "Know every action your AI agents can take. Arceo maps capabilities, scores blast radius, and enforces policies at runtime.",
  openGraph: {
    title: "Arceo — AI Agent Security",
    description:
      "Map every tool, score every risk, enforce every boundary. Ship AI agents confidently.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
