import type { Metadata } from "next";
import { Poppins, Schibsted_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SITE_URL, SITE_NAME, SITE_TAGLINE, SITE_DESCRIPTION } from "@/lib/site";

/* Poppins stays: /security and /book-demo are still set in it, and the footer
   wordmark asks for it by name. The landing page uses the product app's two
   faces instead — sans carries the words, mono carries every figure and tool
   identifier, so the site and the thing you sign in to are set in the same
   type. */
const poppins = Poppins({
  subsets: ["latin"],
  variable: "--font-poppins",
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

const sans = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500", "600"],
});

const TITLE = `${SITE_NAME} · ${SITE_TAGLINE}`;

export const metadata: Metadata = {
  // Required for OG/twitter image URLs and canonicals to resolve absolutely.
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  keywords: [
    "AI agent governance",
    "AI agent cost forecasting",
    "LLM spend management",
    "pre-deployment risk assessment",
    "agent blast radius",
    "AI budget forecasting",
    "FinOps for AI",
  ],
  openGraph: {
    title: TITLE,
    description:
      "Know what an agent costs to run and what it could break, before it goes live. One report your finance team can read.",
    url: SITE_URL,
    siteName: SITE_NAME,
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description:
      "Know what an agent costs to run and what it could break, before it goes live. One report your finance team can read.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
};

// Organization markup so search engines resolve the brand rather than guessing.
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: SITE_URL,
  description: SITE_DESCRIPTION,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${poppins.variable} ${sans.variable} ${mono.variable}`}>
      <body className="grain">
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
      </body>
    </html>
  );
}
