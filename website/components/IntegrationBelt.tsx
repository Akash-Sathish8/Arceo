/* The integrations conveyor.
 *
 * Every name here was read out of the backend on dev, not assembled from
 * marketing copy:
 *
 *   the eleven governed tools   authority/action_mapper.py — ACTION_CATALOG,
 *                               the same 11 services and 95 actions the strip
 *                               above this one counts
 *   the agent sources           main.py LLM_BASE_URLS, the /import and
 *                               /connect endpoints, and sandbox/runner.py's
 *                               model router
 *   the trace ingesters         ingestion/langsmith.py, ingestion/langfuse.py
 *
 * If a service is added to ACTION_CATALOG it belongs here too, and the count
 * in MetricStrip moves with it.
 *
 * ── On the logos ──────────────────────────────────────────────────────────
 * These are the vendors' real marks, served from public/brand/integrations/
 * as static files. They are NOT hotlinked — nothing here makes a request to
 * a third party at render time — and they are NOT redrawn.
 *
 * They come from three places because no single set has all seventeen:
 *   gilbarbara/logos  13 of them, via jsDelivr
 *   @lobehub/icons    LangSmith, Langfuse, Ollama
 *   simple-icons      Calendly
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
 * Sizes are normalised by BOX, not by height. The marks run from 1:1
 * (Calendly) to nearly 9:1 (Anthropic), so a shared height would make the
 * wordmarks enormous; a shared box with object-fit lets each one sit at its
 * own natural weight.
 */

/* A square glyph and a long wordmark set to the same HEIGHT do not read as
   the same size — the wordmark covers three or four times the area. So each
   mark declares which it is, and the glyphs get a taller box to even out the
   optical weight. This is the whole reason the belt does not look like a
   ransom note. */
type Integration = { name: string; file: string; glyph?: true };

/* Ordered so the four a reader is looking for come first, then the rest of
   the surface. GitHub is both an agent source and a governed tool; it
   appears once. */
const INTEGRATIONS: Integration[] = [
  { name: "Anthropic", file: "anthropic" },
  { name: "OpenAI", file: "openai" },
  { name: "Model Context Protocol", file: "mcp" },
  { name: "GitHub", file: "github" },
  { name: "LangSmith", file: "langsmith", glyph: true },
  { name: "Langfuse", file: "langfuse", glyph: true },
  { name: "Ollama", file: "ollama" },
  { name: "Stripe", file: "stripe" },
  { name: "Salesforce", file: "salesforce", glyph: true },
  { name: "Zendesk", file: "zendesk" },
  { name: "Slack", file: "slack" },
  { name: "Amazon Web Services", file: "aws", glyph: true },
  { name: "PagerDuty", file: "pagerduty" },
  { name: "HubSpot", file: "hubspot" },
  { name: "SendGrid", file: "sendgrid" },
  { name: "Gmail", file: "gmail", glyph: true },
  { name: "Calendly", file: "calendly", glyph: true },
];

function Run({ hidden }: { hidden?: boolean }) {
  return (
    <div className="belt-run" aria-hidden={hidden || undefined}>
      {INTEGRATIONS.map((i) => (
        <span key={i.name} className={`belt-item${i.glyph ? " belt-item-glyph" : ""}`}>
          {/* The names are gone from the surface, so the alt text is the only
              thing carrying them — it is doing real work here, not filling in
              a required attribute. Decorative on the duplicate run. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="belt-logo"
            src={`/brand/integrations/${i.file}.svg`}
            alt={hidden ? "" : i.name}
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
        <span className="belt-count">{INTEGRATIONS.length}</span> integrations —
        point Arceo at an agent and it maps every tool the agent can reach
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
