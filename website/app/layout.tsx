import type { Metadata } from "next";
import { Poppins, Schibsted_Grotesk, Manrope, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SITE_URL, SITE_NAME, SITE_TAGLINE, SITE_DESCRIPTION } from "@/lib/site";

/* Poppins stays only for /security and /book-demo, which have not been
   rebuilt yet. Everything else is set in the product app's own three faces,
   so the site and the thing you sign in to are typographically the same
   product (frontend/src/index.css is the source of truth):

     Schibsted Grotesk  the words
     Manrope            every FIGURE — proportional, so tabular-nums is not
                        optional; it is the only thing keeping a column of
                        dollar amounts aligned
     JetBrains Mono     literal code and tool identifiers only            */
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

const num = Manrope({
  subsets: ["latin"],
  variable: "--font-num",
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
    <html lang="en" className={`${poppins.variable} ${sans.variable} ${num.variable} ${mono.variable}`}>
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
