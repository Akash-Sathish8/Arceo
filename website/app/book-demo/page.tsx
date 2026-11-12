"use client";

import { useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/* Demo request. Posts to /api/demo-request, which records the lead and only
   reports success once it is stored somewhere we control. On failure the
   visitor gets a prefilled email instead of a false confirmation. */

const FALLBACK_EMAIL = "akakash.sathish@gmail.com";

type Status = "idle" | "submitting" | "success" | "error";

export default function BookDemoPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    role: "",
    message: "",
    website: "", // honeypot: hidden from people, bots fill it in
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError("");
    try {
      const res = await fetch("/api/demo-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(data.error || "We couldn't send that just now.");
        setStatus("error");
        return;
      }
      setStatus("success");
    } catch {
      setError("We couldn't reach the server.");
      setStatus("error");
    }
  }

  const update = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const mailtoFallback =
    `mailto:${FALLBACK_EMAIL}` +
    `?subject=${encodeURIComponent("Arceo demo request: " + (form.name || form.email))}` +
    `&body=${encodeURIComponent(
      [
        `Name: ${form.name}`,
        `Email: ${form.email}`,
        `Company: ${form.company || "(not provided)"}`,
        `Role: ${form.role || "(not provided)"}`,
        "",
        "Message:",
        form.message || "(none)",
      ].join("\n"),
    )}`;

  return (
    <>
      <Navbar />
      <main className="container-site grid gap-12 pt-14 pb-20 sm:pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,520px)] lg:gap-20">
        <div>
          <h1 className="text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] text-ink sm:text-[52px]">Book a demo</h1>
          <p className="mt-5 max-w-[460px] text-[17px] leading-relaxed text-ink-2">
            Thirty minutes on a call. Bring a prompt your team uses or an agent you are building, and we will run it
            through Arceo with you.
          </p>
          <ul className="mt-8 flex max-w-[460px] flex-col gap-3 border-t pt-6 text-[14.5px] leading-relaxed text-ink-2">
            <li>We show what it could break and which warnings it trips.</li>
            <li>You leave with a monthly cost forecast and its range.</li>
          </ul>
        </div>

        <div className="rounded-xl border bg-white p-6 shadow-sm sm:p-8">
          {status === "success" ? (
            <div role="status">
              <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Thanks, we have it.</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
                We will email {form.email || "you"} to find a time.
              </p>
              <Button asChild variant="outline" className="mt-6 h-10 bg-white px-4 text-[14px]">
                <Link href="/">Back to the homepage</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <Field id="name" label="Full name" required>
                <Input id="name" required autoComplete="name" value={form.name} onChange={update("name")} className="h-10 text-[15px]" />
              </Field>
              <Field id="email" label="Work email" required>
                <Input id="email" type="email" required autoComplete="email" value={form.email} onChange={update("email")} className="h-10 text-[15px]" />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field id="company" label="Company">
                  <Input id="company" autoComplete="organization" value={form.company} onChange={update("company")} className="h-10 text-[15px]" />
                </Field>
                <Field id="role" label="Role">
                  <Input id="role" autoComplete="organization-title" value={form.role} onChange={update("role")} className="h-10 text-[15px]" />
                </Field>
              </div>
              <Field id="message" label="What would you like to see?">
                <Textarea id="message" rows={4} value={form.message} onChange={update("message")} className="text-[15px]" />
              </Field>

              <input
                type="text"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={form.website}
                onChange={update("website")}
                className="absolute -left-[9999px] h-px w-px opacity-0"
              />

              {status === "error" && (
                <div role="alert" className="rounded-md border border-critical-line bg-critical-bg p-3 text-[14px] leading-relaxed text-critical">
                  {error}{" "}
                  <a href={mailtoFallback} className="font-medium underline underline-offset-2">Email us instead</a>.
                </div>
              )}

              <Button type="submit" disabled={status === "submitting"} className="h-11 text-[15px]">
                {status === "submitting" ? "Sending…" : "Request a demo"}
              </Button>
            </form>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}

function Field({ id, label, required, children }: { id: string; label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="text-[13.5px] text-ink">
        {label}
        {required && <span className="text-ink-4"> (required)</span>}
      </Label>
      {children}
    </div>
  );
}
