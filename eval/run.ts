/**
 * npm run eval [-- --only <scenario>]
 *
 * Runs every scenario against the real API with an empty memory per
 * scenario, then reports pass/fail per check and latency (time to first
 * token, total) across turns. Results are written to eval/results/.
 *
 * Costs real tokens: each run is ~10 agent turns plus judge calls.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTurn } from "../src/agent.js";
import { config } from "../src/config.js";
import { Timeline, type Exchange } from "../src/store.js";
import { formatDateTime } from "../src/time.js";
import { scenarios, TZ, type Check } from "./scenarios.js";

const client = new Anthropic();

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "reason"],
  properties: { pass: { type: "boolean" }, reason: { type: "string" } },
} as const;

async function judge(rubric: string, transcript: Exchange[]): Promise<{ pass: boolean; reason: string }> {
  const convo = transcript
    .map((e) => `[${formatDateTime(new Date(e.askedAt), TZ)}]\nUSER: ${e.question}\nASSISTANT: ${e.answer}`)
    .join("\n\n---\n\n");
  const res = await client.messages.create({
    model: config.model,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: JUDGE_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `You are grading a chat assistant's LAST reply in this conversation against a rubric. Judge only what the rubric asks; don't check facts against your own knowledge.\n\n<conversation>\n${convo}\n</conversation>\n\n<rubric>${rubric}</rubric>`,
      },
    ],
  });
  const text = res.content.find((b) => b.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

function deterministic(check: Check, e: Exchange): string[] {
  const fails: string[] = [];
  if (check.searched === true && !e.searches.length) fails.push("expected a web search, none ran");
  if (check.searched === false && e.searches.length) fails.push(`expected no search, ran ${e.searches.length}`);
  for (const re of check.mustMatch ?? []) if (!re.test(e.answer)) fails.push(`answer should match ${re}`);
  for (const re of check.mustNotMatch ?? []) if (re.test(e.answer)) fails.push(`answer should not match ${re}`);
  return fails;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const sec = (ms: number) => (Number.isNaN(ms) ? "–" : `${(ms / 1000).toFixed(1)}s`);

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY (see .env.example) to run evals.");
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const list = scenarios().filter((s) => !only || s.name === only);
  const results: unknown[] = [];
  const ttft: number[] = [];
  const total: number[] = [];
  let passed = 0;
  let checks = 0;

  for (const sc of list) {
    console.log(`\n▶ ${sc.name} — ${sc.about}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `minimi-eval-${sc.name}-`));
    const timeline = new Timeline(path.join(dir, "u.jsonl"));

    for (const turn of sc.turns) {
      const { exchange, enrichment } = await runTurn({
        timeline,
        message: turn.message,
        tz: TZ,
        now: turn.at,
        emit: () => {},
        signal: new AbortController().signal,
      });
      await enrichment; // in real use there is a human-sized gap between turns

      const fails = deterministic(turn.check, exchange);
      let verdict: { pass: boolean; reason: string } | null = null;
      if (turn.check.judge) {
        verdict = await judge(turn.check.judge, timeline.exchanges);
        if (!verdict.pass) fails.push(`judge: ${verdict.reason}`);
      }
      const ok = fails.length === 0;
      checks++;
      if (ok) passed++;
      if (exchange.ms?.firstToken != null) ttft.push(exchange.ms.firstToken);
      if (exchange.ms) total.push(exchange.ms.total);

      console.log(
        `  ${ok ? "✓" : "✗"} [${formatDateTime(turn.at, TZ)}] ${turn.message.slice(0, 70)}` +
          `\n     ${exchange.searches.length} search(es) · first token ${sec(exchange.ms?.firstToken ?? NaN)} · total ${sec(exchange.ms?.total ?? NaN)}`,
      );
      for (const f of fails) console.log(`     ✗ ${f}`);
      if (ok && verdict) console.log(`     judge: ${verdict.reason}`);
      results.push({ scenario: sc.name, at: turn.at, message: turn.message, ok, fails, verdict, exchange });
    }
  }

  console.log(
    `\n${passed}/${checks} turns passed · first token p50 ${sec(pct(ttft, 50))}, p90 ${sec(pct(ttft, 90))}` +
      ` · total p50 ${sec(pct(total, 50))}, p90 ${sec(pct(total, 90))} · model ${config.model}, effort ${config.effort}`,
  );
  const out = path.resolve("eval/results");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ model: config.model, effort: config.effort, passed, checks, results }, null, 2));
  console.log(`results → ${path.relative(process.cwd(), file)}`);
  process.exitCode = passed === checks ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
