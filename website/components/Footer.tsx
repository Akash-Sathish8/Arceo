import Link from "next/link";
import { LogoWordmark } from "./Logo";
import { APP_URL } from "@/lib/site";

export default function Footer() {
  return (
    <footer className="border-t bg-white">
      <div className="container-site flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <LogoWordmark height={14} title="Arceo" />
          <span className="text-[13px] text-ink-3">© {new Date().getFullYear()} Arceo</span>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[14px] text-ink-2">
          <Link href="/prompts" className="hover:text-ink">Prompts</Link>
          <Link href="/security" className="hover:text-ink">Security</Link>
          <Link href="/book-demo" className="hover:text-ink">Book a demo</Link>
          {APP_URL && <a href={`${APP_URL}/login`} className="hover:text-ink">Sign in</a>}
        </nav>
      </div>
    </footer>
  );
}
