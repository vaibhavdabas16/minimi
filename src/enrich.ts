import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Claim, Exchange } from "./store.js";

/**
 * Write-time memory enrichment. After an answer has been streamed and saved,
 * a small fast model reads the exchange once and extracts:
 *
 *   - claims:  dated, checkable statements the answer made
 *              ("Neon · Launch plan price · $19/month · as of 2026-11-03 · [1]")
 *              so "has anything changed since?" can be checked item by item;
 *   - profile: durable facts about the user ("20-person sales team").
 *
 * It runs off the hot path (the user already has their answer), so it costs
 * no latency, and the read path stays deterministic: claims and profile are
 * rendered into context, never fetched by the model.
 */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims", "profile"],
  properties: {
    claims: {
      type: "array",
      description: "Checkable, time-sensitive factual claims the ANSWER makes (prices, plans, versions, launches, dates, who-holds-what). Not opinions, not stable facts.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entity", "attribute", "value", "asOf", "source"],
        properties: {
          entity: { type: "string", description: "Product, company, person or thing, e.g. 'Neon'" },
          attribute: { type: "string", description: "What about it, e.g. 'Launch plan price'" },
          value: { type: "string", description: "The value as stated, with units, e.g. '$19/month'" },
          asOf: { type: ["string", "null"], description: "YYYY-MM-DD the claim refers to if the answer says so, else null" },
          source: { type: ["integer", "null"], description: "The [n] citation number backing it, else null" },
        },
      },
    },
    profile: {
      type: "array",
      description: "The complete, updated list of durable facts about the USER (role, team, company, constraints, decisions, preferences). Start from the existing profile; add, update or drop items. Max 15 short items. Never include anything about third parties only.",
      items: { type: "string" },
    },
  },
} as const;

export interface Enrichment {
  claims: Claim[];
  profile: string[];
}

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

export async function enrich(e: Exchange, profile: string[]): Promise<Enrichment> {
  const res = await anthropic().messages.create({
    model: config.enrichModel,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Extract memory from this exchange between a user and an assistant (asked ${e.askedAt}).

<existing_profile>
${profile.map((f) => `- ${f}`).join("\n") || "(empty)"}
</existing_profile>

<question>${e.question}</question>

<answer>${e.answer}</answer>

<sources>
${e.sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n") || "(none)"}
</sources>`,
      },
    ],
  });
  if (res.stop_reason !== "end_turn") throw new Error(`enrichment stopped: ${res.stop_reason}`);
  const text = res.content.find((b) => b.type === "text")?.text ?? "{}";
  const out = JSON.parse(text) as Enrichment;
  return {
    claims: (out.claims ?? []).slice(0, 30),
    profile: (out.profile ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 15),
  };
}
