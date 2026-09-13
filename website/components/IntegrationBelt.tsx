/* The integrations conveyor.
 *
 * Every name here was read out of the backend on dev, not assembled from
 * marketing copy:
 *
 *   the eleven governed tools   authority/action_mapper.py — ACTION_CATALOG,
 *                               each with a sandbox mock and runtime
 *                               enforcement, which is what "full support"
 *                               in the lead line means
 *   the agent sources           main.py LLM_BASE_URLS, the /import and
 *                               /connect endpoints, and sandbox/runner.py's
 *                               model router
 *   the trace ingesters         ingestion/langsmith.py, ingestion/langfuse.py
 *
 * If a service is added to ACTION_CATALOG it belongs here too.
 *
 * ── On the logos ──────────────────────────────────────────────────────────
 * These are the vendors' real marks — the icon, not the wordmark — served
 * from public/brand/integrations/ as static files. They are NOT hotlinked —
 * nothing here makes a request to a third party at render time — and they
 * are NOT redrawn.
 *
 * They come from three places because no single set has all seventeen:
 *   gilbarbara/logos  Anthropic, OpenAI, MCP, GitHub, Slack, PagerDuty,
 *                     SendGrid, Zendesk, Salesforce, Gmail and AWS — the
 *                     `*-icon.svg` variants where the set has one, via
 *                     jsDelivr. AWS has no separate icon; the smile lockup IS
 *                     its mark.
 *   @lobehub/icons    LangSmith, Langfuse
 *   simple-icons      Calendly, HubSpot, Stripe, Ollama. simple-icons ships
 *                     single-colour paths with no fill, so each of those
 *                     files carries the vendor's own brand hex as published
 *                     in simple-icons' data (HubSpot #FF7A59, Stripe #635BFF,
 *                     Ollama #000000, Calendly #006BFF). That is the vendor's
 *                     colour, not a recolour.
 *
 * Worth knowing before this ships: OpenAI, Slack, Salesforce, AWS and
 * SendGrid have all been REMOVED from simple-icons at their owners' request,
 * which is a direct signal that those five police logo use. Showing a mark to
 * state a genuine integration is ordinary nominative use, but each of those
 * vendors publishes brand guidelines — clear space, minimum size, whether
 * recolouring is allowed — and somebody should read them before this is
 * public. That is the reason the marks are left in their own colours here
 * rather than being forced to one ink: recolouring is the rule most often
 * broken, and the one most easily avoided.
 *
 * Sizing: every file is now a roughly square mark. The widest (AWS) is 5:3
 * and the tallest (PagerDuty) is 2:3, so one shared box with object-fit is
 * enough to keep the belt's rhythm even. The old wordmark/glyph split, and
 * the per-kind box heights it needed, are gone with the wordmarks.
 */

type Integration = { name: string; file: string };

/* Ordered so the four a reader is looking for come first, then the rest of
   the surface. GitHub is both an agent source and a governed tool; it
   appears once. */
const INTEGRATIONS: Integration[] = [
  { name: "Anthropic", file: "anthropic" },
  { name: "OpenAI", file: "openai" },
  { name: "Model Context Protocol", file: "mcp" },
  { name: "GitHub", file: "github" },
  { name: "LangSmith", file: "langsmith" },
  { name: "Langfuse", file: "langfuse" },
  { name: "Ollama", file: "ollama" },
  { name: "Stripe", file: "stripe" },
  { name: "Salesforce", file: "salesforce" },
  { name: "Zendesk", file: "zendesk" },
  { name: "Slack", file: "slack" },
  { name: "Amazon Web Services", file: "aws" },
  { name: "PagerDuty", file: "pagerduty" },
  { name: "HubSpot", file: "hubspot" },
  { name: "SendGrid", file: "sendgrid" },
  { name: "Gmail", file: "gmail" },
  { name: "Calendly", file: "calendly" },
];

function Run({ hidden }: { hidden?: boolean }) {
  return (
    <div className="belt-run" aria-hidden={hidden || undefined}>
      {INTEGRATIONS.map((i) => (
        <span key={i.name} className="belt-item">
          {/* The names are gone from the surface, so the alt text is the only
              thing carrying them — it is doing real work here, not filling in
              a required attribute. The title shows the name on hover, when the
              belt is paused and someone is actually reading it. Decorative on
              the duplicate run. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="belt-logo"
            src={`/brand/integrations/${i.file}.svg`}
            alt={hidden ? "" : i.name}
            title={hidden ? undefined : i.name}
            loading="lazy"
            decoding="async"
          />
        </span>
      ))}
    </div>
  );
}

export default function IntegrationBelt() {
  return (
    <section className="belt" aria-label="Supported integrations">
      <p className="belt-lead">
        Arceo fully supports these agents and tools
      </p>

      <div className="belt-viewport">
        {/* Two identical runs, translated by exactly half the track, so the
            loop has no seam. The second is hidden from the a11y tree — it is
            the same seventeen logos a second time. */}
        <div className="belt-track">
          <Run />
          <Run hidden />
        </div>
      </div>
    </section>
  );
}
