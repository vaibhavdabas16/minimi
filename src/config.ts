import "dotenv/config";
import path from "node:path";

type Effort = "low" | "medium" | "high";

function effort(v: string | undefined): Effort {
  return v === "low" || v === "high" ? v : "medium";
}

const bootReal = Date.now();
const fakeStart = process.env.AGENT_NOW ? Date.parse(process.env.AGENT_NOW) : NaN;
if (process.env.AGENT_NOW && Number.isNaN(fakeStart)) {
  throw new Error(`AGENT_NOW is not a valid date: ${process.env.AGENT_NOW}`);
}

export const config = {
  model: process.env.MODEL || "claude-opus-5-5",
  effort: effort(process.env.EFFORT),
  port: Number(process.env.PORT) || 3000,
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  /** Max web searches the model may run in one turn. */
  maxSearchesPerTurn: 5,
  maxOutputTokens: 16000,
  /** History window: between HISTORY_MIN and HISTORY_MAX recent exchanges go in as real turns. */
  historyMax: 12,
  historyStep: 6,
};

/**
 * The agent's clock. Normally the wall clock; with AGENT_NOW set, time starts at
 * that instant and ticks forward from boot. Every "now" in the app goes through
 * here so dated memory can be exercised without waiting for real days to pass.
 */
export function now(): Date {
  if (Number.isNaN(fakeStart)) return new Date();
  return new Date(fakeStart + (Date.now() - bootReal));
}
