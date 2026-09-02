/* The engine's risk labels, in the words a person actually uses.
 *
 * Internally these are snake_case identifiers — touches_pii, sends_external,
 * evades_detection — and that is what the API returns and what a customer sees
 * inside the product, where they have context and a glossary. A landing page
 * has about one second to be understood, and "touches_pii" spends all of it on
 * making the reader feel excluded.
 *
 * So the identifier stays in the product and the sentence lives here. One map,
 * used by every section, so the wording can never drift between the hero, the
 * ledger, the score and the matrix.
 *
 *   plain — for chips and lists, where there is room for a verb phrase
 *   short — for the 10 × 10 matrix, where the axis labels have to be scannable
 *           at 9px and rotated on their side
 */
export const RISK = {
  moves_money: { plain: "Moves money", short: "Money" },
  touches_pii: { plain: "Reads customer data", short: "Customer data" },
  deletes_data: { plain: "Deletes records", short: "Delete" },
  sends_external: { plain: "Sends data outside", short: "Send out" },
  changes_production: { plain: "Changes production", short: "Production" },
  changes_access: { plain: "Grants access", short: "Access" },
  reads_secrets: { plain: "Reads credentials", short: "Credentials" },
  evades_detection: { plain: "Turns off logging", short: "Hide tracks" },
  bulk_export: { plain: "Exports in bulk", short: "Bulk export" },
  executes_code: { plain: "Runs code", short: "Run code" },
} as const;

export type RiskKey = keyof typeof RISK;
