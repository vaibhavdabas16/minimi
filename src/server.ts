import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, runTurn, type AgentEvent } from "./agent.js";
import { config, now } from "./config.js";
import { Store } from "./store.js";
import { safeTimeZone } from "./time.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new Store(config.dataDir);
const ENRICH_WAIT_MS = 4000;

/** One turn at a time per user, so each turn sees the previous one in memory. */
const userQueues = new Map<string, Promise<unknown>>();
function serialize<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userQueues.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  userQueues.set(userId, next.catch(() => {}));
  return next;
}

const STATIC: Record<string, [string, string]> = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["public/styles.css", "text/css; charset=utf-8"],
  "/vendor/marked.js": ["node_modules/marked/lib/marked.esm.js", "text/javascript; charset=utf-8"],
};

function userIdFrom(req: http.IncomingMessage, res: http.ServerResponse): string {
  const m = /(?:^|;\s*)uid=([a-zA-Z0-9_-]{8,64})/.exec(req.headers.cookie ?? "");
  if (m) return m[1];
  const id = randomUUID().replace(/-/g, "");
  res.setHeader("Set-Cookie", `uid=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  return id;
}

async function readJson(req: http.IncomingMessage, limit = 64_000): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("request too large");
  }
  return body ? JSON.parse(body) : {};
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    const file = req.method === "GET" ? STATIC[url.pathname] : undefined;
    if (file) {
      res.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-cache" });
      fs.createReadStream(path.join(root, file[0])).pipe(res);
      return;
    }

    const userId = userIdFrom(req, res);

    if (url.pathname === "/api/history" && req.method === "GET") {
      return json(res, 200, { now: now().toISOString(), exchanges: store.for(userId).exchanges });
    }

    if (url.pathname === "/api/history" && req.method === "DELETE") {
      store.for(userId).clear();
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await readJson(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) return json(res, 400, { error: "message is required" });
      if (message.length > 20_000) return json(res, 400, { error: "message too long" });
      const tz = safeTimeZone(body.tz);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const emit = (e: AgentEvent) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
      };

      await serialize(userId, async () => {
        try {
          const { enrichment } = await runTurn({
            timeline: store.for(userId),
            message,
            tz,
            emit,
            signal: abort.signal,
          });
          // The answer is already on screen. Give background enrichment a short
          // window so the *next* turn sees this one's claims, but never let it
          // hold the queue for long.
          await Promise.race([enrichment, new Promise((r) => setTimeout(r, ENRICH_WAIT_MS))]);
        } catch (err) {
          if (abort.signal.aborted) return; // user navigated away; nothing to report
          console.error(err);
          emit({ type: "error", message: describeError(err) });
        }
      });
      res.end();
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: describeError(err) });
    else res.end();
  }
});

server.listen(config.port, () => {
  console.log(`minimi chat agent → http://localhost:${config.port}`);
  console.log(`model ${config.model} · effort ${config.effort} · data in ${config.dataDir}`);
  if (process.env.AGENT_NOW) console.log(`clock: pretending it is ${now().toISOString()}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠ ANTHROPIC_API_KEY is not set — copy .env.example to .env");
});
