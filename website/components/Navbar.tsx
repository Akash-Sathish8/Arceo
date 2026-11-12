"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { LogoWordmark } from "./Logo";
import { APP_URL } from "@/lib/site";

/* The site's top bar is the product's top bar: 64px, white with a blur,
   one hairline underneath. */

const LINKS = [
  { href: "/prompts", label: "Prompts" },
  { href: "/security", label: "Security" },
] as const;

export default function Navbar() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-50 border-b bg-white/80 backdrop-blur-xl">
      <div className="container-site flex h-16 items-center justify-between gap-6">
        <div className="flex items-center gap-8">
          <Link href="/" aria-label="Arceo home" className="rounded-sm">
            <LogoWordmark height={17} title="Arceo" />
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="rounded-md px-3 py-1.5 text-[14px] text-ink-2 transition-colors hover:bg-line-soft hover:text-ink">
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="hidden items-center gap-2 sm:flex">
          {APP_URL && (
            <Button asChild variant="ghost" className="h-9 px-3 text-[14px] font-normal text-ink-2">
              <a href={`${APP_URL}/login`}>Sign in</a>
            </Button>
          )}
          <Button asChild className="h-9 px-4 text-[14px]">
            <Link href="/book-demo">Book a demo</Link>
          </Button>
        </div>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="size-9 sm:hidden" aria-label="Open menu">
              <Menu className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-[280px] gap-0 p-0">
            <SheetTitle className="flex h-16 items-center border-b px-5">
              <LogoWordmark height={15} title="Arceo" />
            </SheetTitle>
            <nav aria-label="Mobile" className="flex flex-col p-3">
              {LINKS.map((l) => (
                <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="rounded-md px-3 py-2.5 text-[15px] text-ink hover:bg-line-soft">
                  {l.label}
                </Link>
              ))}
              {APP_URL && (
                <a href={`${APP_URL}/login`} className="rounded-md px-3 py-2.5 text-[15px] text-ink hover:bg-line-soft">Sign in</a>
              )}
              <Button asChild className="mt-3 h-10 text-[15px]">
                <Link href="/book-demo" onClick={() => setOpen(false)}>Book a demo</Link>
              </Button>
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
