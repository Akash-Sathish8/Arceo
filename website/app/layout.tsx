import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

const poppins = Poppins({
  subsets: ["latin"],
  variable: "--font-poppins",
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "Arceo · Cost and risk forecasting for AI agents",
  description: "Arceo tells you what your AI agent will cost to run, and what happens if it goes wrong, before you put it in production. One report your finance team can read. Works with Anthropic, OpenAI, MCP, and GitHub.",
  openGraph: {
    title: "Arceo · Cost and risk forecasting for AI agents",
    description: "Know what an agent costs to run and what it could break, before it goes live. One report your finance team can read.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={poppins.variable}>
      <body>{children}</body>
    </html>
  );
}
