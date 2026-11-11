import fs from "node:fs";
import path from "node:path";
import { Bm25Index } from "./bm25.js";

export interface Source {
  url: string;
  title: string;
}

/** A dated, checkable statement an answer made. Extracted after the fact (see enrich.ts). */
export interface Claim {
  entity: string;
  attribute: string;
  value: string;
  asOf: string | null; // YYYY-MM-DD if the answer dated it
  source: number | null; // 1-based index into the exchange's sources
}

/**
 * One question and the agent's answer to it — the unit of memory. Stored as a
 * pair (not as loose messages) because that is how people recall: "what did I
 * ask you on 3 Nov, and what did you say?"
 */
export interface Exchange {
  id: string;
  askedAt: string; // ISO-8601 UTC
  tz: string; // the user's timezone at the time; days are resolved in it
  question: string;
  answer: string; // markdown with [n] markers that index into `sources`
  sources: Source[];
  searches: string[]; // web queries the agent ran for this answer
  claims?: Claim[]; // filled in shortly after the answer, by enrichment
  model?: string;
  ms?: { firstToken: number | null; total: number };
}

/** Lines in the JSONL log. Exchanges have no `kind` (the original format). */
type Record =
  | (Exchange & { kind?: undefined })
  | { kind: "claims"; exchangeId: string; claims: Claim[] }
  | { kind: "profile"; at: string; facts: string[] };

export const claimText = (c: Claim) => `${c.entity} ${c.attribute} ${c.value}`;

/**
 * Per-user, append-only JSONL log, fully loaded in memory with a BM25 index
 * over it. Later records annotate earlier ones (claims → exchange, newest
 * profile wins) instead of rewriting them, so a crash can never corrupt
 * history. One file per user keeps it inspectable and needs no native deps
 * or database server, so `npm install && npm run dev` works everywhere. A
 * personal chat history is small (thousands of exchanges, a few MB); scans
 * are microseconds at that size.
 */
export class Timeline {
  readonly exchanges: Exchange[] = [];
  readonly index = new Bm25Index();
  profile: string[] = [];
  private byId = new Map<string, number>();

  constructor(private file: string) {
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.apply(JSON.parse(line) as Record);
        } catch {
          /* skip a torn last line from a crash mid-write */
        }
      }
    }
  }

  private apply(r: Record) {
    if (r.kind === "claims") {
      const i = this.byId.get(r.exchangeId);
      if (i === undefined) return;
      this.exchanges[i].claims = r.claims;
      this.index.add(i, r.claims.map(claimText).join(" "));
    } else if (r.kind === "profile") {
      this.profile = r.facts;
    } else {
      const { kind: _, ...e } = r;
      this.exchanges.push(e);
      const i = this.exchanges.length - 1;
      this.byId.set(e.id, i);
      // The question is what people search their memory by; weight it higher.
      this.index.add(i, `${e.question} ${e.question} ${e.answer.slice(0, 3000)}`);
      if (e.claims?.length) this.index.add(i, e.claims.map(claimText).join(" "));
    }
  }

  private write(r: Record) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(r) + "\n");
    this.apply(r);
  }

  append(e: Exchange) {
    this.write(e);
  }

  attachClaims(exchangeId: string, claims: Claim[]) {
    if (claims.length) this.write({ kind: "claims", exchangeId, claims });
  }

  setProfile(facts: string[]) {
    if (JSON.stringify(facts) !== JSON.stringify(this.profile)) {
      this.write({ kind: "profile", at: new Date().toISOString(), facts });
    }
  }

  /** Exchanges whose askedAt falls in [start, end). */
  between(start: Date, end: Date): number[] {
    const a = start.getTime();
    const b = end.getTime();
    const out: number[] = [];
    this.exchanges.forEach((e, i) => {
      const t = Date.parse(e.askedAt);
      if (t >= a && t < b) out.push(i);
    });
    return out;
  }

  clear() {
    this.exchanges.length = 0;
    this.byId.clear();
    this.profile = [];
    this.index.clear();
    if (fs.existsSync(this.file)) fs.rmSync(this.file);
  }
}

export class Store {
  private timelines = new Map<string, Timeline>();
  constructor(private dir: string) {}

  for(userId: string): Timeline {
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(userId)) throw new Error("bad user id");
    let t = this.timelines.get(userId);
    if (!t) {
      t = new Timeline(path.join(this.dir, `${userId}.jsonl`));
      this.timelines.set(userId, t);
    }
    return t;
  }
}
