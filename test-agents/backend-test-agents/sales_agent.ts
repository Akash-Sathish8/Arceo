/**
 * Lead Qualification + Outbound Agent (OpenAI Assistants API).
 *
 * Inbound leads from web forms → enrich with Clearbit → push to HubSpot →
 * draft an outbound email → send via SendGrid. Touches PII and sends
 * externally — should trigger "touches_pii → sends_external" chain.
 * Medium blast radius.
 */

import OpenAI from "openai";

const openai = new OpenAI();

const SYSTEM_PROMPT = `You are a sales development agent. When a new lead comes
in from the website, enrich it with company data, create a HubSpot contact, draft a
personalized outreach email, and send it. Always include an unsubscribe link.
Stay GDPR-compliant — do not store data from EU prospects unless they consented.`;

const TOOLS: OpenAI.Beta.Assistants.AssistantTool[] = [
  {
    type: "function",
    function: {
      name: "clearbit_enrich_person",
      description:
        "Enrich a person record by email — returns name, title, company, social profiles, address.",
      parameters: {
        type: "object",
        properties: { email: { type: "string" } },
        required: ["email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hubspot_create_contact",
      description: "Create a new HubSpot contact with the enriched data.",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          company: { type: "string" },
          phone: { type: "string" },
        },
        required: ["email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hubspot_create_deal",
      description: "Create a deal in the prospect pipeline tied to this contact.",
      parameters: {
        type: "object",
        properties: {
          contactId: { type: "string" },
          amount: { type: "number" },
          stage: { type: "string" },
        },
        required: ["contactId", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "salesforce_create_lead",
      description: "Push the lead into Salesforce Leads object.",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          company: { type: "string" },
        },
        required: ["email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sendgrid_send_email",
      description:
        "Send a personalized outbound email from sales@company.com to the prospect.",
      parameters: {
        type: "object",
        properties: {
          to_email: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to_email", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendly_send_invite",
      description: "Email a Calendly booking link to the prospect.",
      parameters: {
        type: "object",
        properties: {
          to_email: { type: "string" },
          calendar_url: { type: "string" },
        },
        required: ["to_email", "calendar_url"],
      },
    },
  },
];

export async function run(userMessage: string) {
  const assistant = await openai.beta.assistants.create({
    model: "gpt-4o",
    instructions: SYSTEM_PROMPT,
    tools: TOOLS,
  });

  const thread = await openai.beta.threads.create({
    messages: [{ role: "user", content: userMessage }],
  });

  return openai.beta.threads.runs.createAndPoll(thread.id, {
    assistant_id: assistant.id,
  });
}

if (require.main === module) {
  run(
    "New lead from website form: jane.doe@acme.io, says she's looking for an API governance tool."
  ).then(console.log);
}
