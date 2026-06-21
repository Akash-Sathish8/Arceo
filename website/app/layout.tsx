import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Arceo — Forecast AI Agent Cost & Risk",
  description: "Arceo tells you how much your AI agent will cost — and what could go wrong with it — before you put it in production. One CFO-readable report. Any agent in.",
  openGraph: {
    title: "Arceo — Forecast AI Agent Cost & Risk",
    description: "How much will your AI agent cost, and what could go wrong? Get both in one CFO-readable report, before you deploy.",
    type: "website",
  },
};

// Runs before first paint: marks the page "fade-ready" so the scroll-fade
// animation plays when JS is alive, while leaving content visible-by-default
// if it isn't. Also force-reveals every fade-up element on a bfcache back-
// navigation (pageshow.persisted), where the React reveal can fail to re-fire
// and Safari/Chrome may keep elements stuck at opacity:0.
const FADE_BOOTSTRAP = `(function(){var d=document.documentElement;d.classList.add('fade-ready');window.addEventListener('pageshow',function(e){if(e.persisted){var f=document.querySelectorAll('.fade-up');for(var i=0;i<f.length;i++)f[i].classList.add('visible');}});})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={dmSans.variable} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: FADE_BOOTSTRAP }} />
        {children}
      </body>
    </html>
  );
}
