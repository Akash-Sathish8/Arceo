import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";

/* Every line here is checked against the code:
   - hosting: docs/DEPLOYMENT_CONTRACT.md §9 (Vercel + Neon Postgres)
   - tenant isolation: alembic 0002_rls_tenant_isolation, ENABLE + FORCE RLS
   - credentials: vault.encrypt_credential, AES-256-GCM per-value keys
   - audit log: alembic 0007_audit_hash_chain (hash chain + append-only trigger)
   - SDK: sdk/arceo/_capture.py sends token usage and request shape only
   - prompt inbox: prompts/agent_router.py, kept 24 hours
   - review: docs/security/backend (2026-07-28), HIGH-001..004 fixed in PRs #124–#126 */

export const metadata: Metadata = {
  title: "Security",
  description: "How Arceo is hosted, what it stores, how tenants are kept apart, and what the last security review found.",
  alternates: { canonical: "/security" },
};

const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: "Where it runs",
    items: [
      "The hosted app runs on Vercel, with data in Postgres on Neon.",
      "Companies that need it inside their own network can run the same product from our Docker image.",
    ],
  },
  {
    title: "Keeping companies apart",
    items: [
      "Every request is checked against the signed-in company, and asking for another company's record returns not found.",
      "Postgres row-level security is switched on and forced on every company-owned table, so the database refuses cross-company reads even if the app gets it wrong.",
    ],
  },
  {
    title: "What we store",
    items: [
      "The Python SDK sends token counts and the shape of each AI call (model, number of messages). It does not send the prompt or the reply unless you turn that on.",
      "Keys you add for your AI accounts are encrypted with AES-256-GCM, each with its own key.",
      "Prompts sent to your agent from the library wait in your inbox for 24 hours, then they are gone.",
      "Passwords are hashed with bcrypt.",
    ],
  },
  {
    title: "Audit log",
    items: [
      "Each entry carries a hash of the one before it, so editing or removing a past entry breaks the chain. Arceo can verify the whole chain at any time.",
      "The database refuses updates and deletes on the log, including from Arceo's own account.",
    ],
  },
  {
    title: "Last review",
    items: [
      "Our July 2026 security review of the backend found no critical issues. The four high-severity findings were fixed in the following days.",
      "We share the full report on request.",
    ],
  },
];

export default function SecurityPage() {
  return (
    <>
      <Navbar />
      <main className="container-site max-w-[880px] pt-14 pb-20 sm:pt-20">
        <h1 className="text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] text-ink sm:text-[52px]">Security</h1>
        <p className="mt-5 max-w-[620px] text-[17px] leading-relaxed text-ink-2">
          What Arceo stores, where it lives, and who can see it.
        </p>

        <div className="mt-12 divide-y rounded-xl border bg-white">
          {SECTIONS.map((s) => (
            <section key={s.title} className="grid gap-3 p-6 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-8 sm:p-8">
              <h2 className="text-[16px] font-semibold text-ink">{s.title}</h2>
              <ul className="flex flex-col gap-3">
                {s.items.map((i) => (
                  <li key={i} className="text-[15px] leading-relaxed text-ink-2">{i}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[15px] text-ink-2">Questions for your security team, or want the report?</p>
          <Button asChild className="h-11 w-fit px-5 text-[15px]">
            <Link href="/book-demo">Get in touch</Link>
          </Button>
        </div>
      </main>
      <Footer />
    </>
  );
}
