import Link from "next/link";
import { Button } from "@/components/ui/button";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import ProductWindow from "@/components/product/ProductWindow";
import { APP_URL } from "@/lib/site";

/* The whole homepage is the hero: a headline, one sentence, and the product
   itself in a window with three tabs. Then a short close. */

const WORKS_WITH = ["Claude Code", "ChatGPT", "Cursor", "Lovable", "Anthropic", "OpenAI", "MCP", "GitHub"];

export default function Home() {
  return (
    <>
      <a href="#main" className="skip-link">Skip to content</a>
      <Navbar />
      <main id="main">
        <section className="container-site pt-14 pb-16 sm:pt-20 sm:pb-24">
          <h1 className="text-[44px] font-semibold leading-[1.02] tracking-[-0.04em] text-ink sm:text-[64px] lg:text-[84px]">
            Safe, fast AI for every team.
          </h1>
          <div className="mt-6 flex flex-col gap-8 lg:mt-8 lg:flex-row lg:items-end lg:justify-between">
            <p className="max-w-[600px] text-[17px] leading-relaxed text-ink-2 sm:text-[19px]">
              Arceo warns you before a prompt or an AI agent does something risky. It gives every team prompts that
              already work, and shows what each one costs.
            </p>
            <div className="flex shrink-0 flex-wrap gap-3">
              <Button asChild className="h-11 px-5 text-[15px]">
                <Link href="/book-demo">Book a demo</Link>
              </Button>
              {APP_URL && (
                <Button asChild variant="outline" className="h-11 bg-white px-5 text-[15px]">
                  <a href={`${APP_URL}/login`}>Sign in</a>
                </Button>
              )}
            </div>
          </div>

          <div className="mt-14 sm:mt-16">
            <ProductWindow />
          </div>
        </section>

        <section className="border-t bg-white">
          <div className="container-site flex flex-col gap-8 py-14 sm:py-16 md:flex-row md:items-end md:justify-between">
            <div className="max-w-[620px]">
              <h2 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[32px]">
                See it on your own prompts and agents.
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-3">
                Works with {WORKS_WITH.slice(0, -1).join(", ")} and {WORKS_WITH.at(-1)}.
              </p>
            </div>
            <Button asChild className="h-11 w-fit px-5 text-[15px]">
              <Link href="/book-demo">Book a demo</Link>
            </Button>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
