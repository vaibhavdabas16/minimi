/**
 * End-to-end test of one agent turn against a fake Messages API that streams a
 * web search + a cited answer, the way the real API does. Checks what we send
 * (cache breakpoints, context, tool) and what we emit and persist.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AgentEvent } from "../src/agent.js";
import { Timeline } from "../src/store.js";

let server: http.Server;
const requests: any[] = [];

function sse(events: object[]): string {
  return events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const URL_ = "https://neon.com/pricing";
const reply = sse([
  {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"Neon pricing November 2026"}' } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: URL_, title: "Neon pricing", encrypted_content: "x", page_age: null }] },
  },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "text", text: "", citations: null } },
  { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: URL_, title: "Neon pricing", cited_text: "Launch $19/mo", encrypted_index: "x" } } },
  { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Neon's Launch plan is $19/month." } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } },
  { type: "message_stop" },
]);

const enrichmentReply = {
  id: "msg_2",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
  content: [
    {
      type: "text",
      text: JSON.stringify({
        claims: [{ entity: "Neon", attribute: "Launch plan price", value: "$19/month", asOf: null, source: 1 }],
        profile: ["Choosing Postgres hosting for their product"],
      }),
    },
  ],
};

before(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const parsed = JSON.parse(body);
    requests.push({ url: req.url, headers: req.headers, body: parsed });
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(reply);
      return;
    }
    // Non-streaming call = background enrichment (structured output)
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(enrichmentReply));
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});
after(() => server.close());

test("a turn searches, streams a cited answer, and is remembered with its time", async () => {
  const { runTurn } = await import("../src/agent.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimi-e2e-"));
  const timeline = new Timeline(path.join(dir, "u.jsonl"));
  timeline.append({
    id: "old",
    askedAt: "2026-11-03T08:32:00Z",
    tz: "Asia/Kolkata",
    question: "What does Neon charge for Postgres hosting?",
    answer: "Neon Launch was $19/month [1]",
    sources: [{ url: URL_, title: "Neon pricing" }],
    searches: ["neon pricing"],
  });

  const events: AgentEvent[] = [];
  const { enrichment } = await runTurn({
    timeline,
    message: "On 3 November I asked about Postgres hosting. Has the price changed since?",
    tz: "Asia/Kolkata",
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
  });

  // --- what we sent
  const sent = requests.find((r) => r.body.stream).body;
  assert.equal(sent.tools[0].type, "web_search_20260209");
  assert.equal(sent.tools.length, 1, "exactly one tool: web search");
  assert.deepEqual(sent.system.at(-1).cache_control, { type: "ephemeral" });
  const lastHistory = sent.messages.at(-2);
  assert.equal(lastHistory.role, "assistant");
  assert.deepEqual(lastHistory.content[0].cache_control, { type: "ephemeral" });
  const turn = sent.messages.at(-1).content.map((b: any) => b.text).join("\n");
  assert.match(turn, /Current time: /);
  assert.match(turn, /"On 3 November" → Tue, 3 Nov 2026: 1 exchange\(s\) on record/);
  assert.doesNotMatch(sent.system[0].text, /2026/, "system prompt must be date-free to stay cacheable");

  // --- what we streamed
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["context", "searching", "search", "results", "text", "cite", "done"]);
  const search = events.find((e) => e.type === "search") as Extract<AgentEvent, { type: "search" }>;
  assert.equal(search.query, "Neon pricing November 2026");

  // --- what we remembered
  const saved = timeline.exchanges.at(-1)!;
  assert.equal(saved.answer, "Neon's Launch plan is $19/month.[1]");
  assert.deepEqual(saved.sources, [{ url: URL_, title: "Neon pricing" }]);
  assert.deepEqual(saved.searches, ["Neon pricing November 2026"]);
  assert.ok(Date.parse(saved.askedAt) > Date.parse("2026-01-01"));

  // --- background enrichment: claims attached to the exchange, profile learned
  await enrichment;
  const enrichReq = requests.find((r) => !r.body.stream).body;
  assert.equal(enrichReq.model, "claude-haiku-5-5");
  assert.equal(enrichReq.output_config.format.type, "json_schema");
  assert.equal(events.at(-1)!.type, "memory");
  assert.deepEqual(saved.claims?.[0].value, "$19/month");
  assert.deepEqual(timeline.profile, ["Choosing Postgres hosting for their product"]);

  // all of it survives a restart: exchange + claims record + profile record
  const reloaded = new Timeline(path.join(dir, "u.jsonl"));
  assert.equal(reloaded.exchanges.length, 2);
  assert.equal(reloaded.exchanges[1].claims?.[0].entity, "Neon");
  assert.deepEqual(reloaded.profile, timeline.profile);
  assert.equal(reloaded.index.search("Launch plan", 1)[0].id, 1);
});
