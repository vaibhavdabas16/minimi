import fs from "node:fs";
import path from "node:path";
import { Bm25Index } from "./bm25.js";

export interface Source {
  url: string;
  title: string;
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
  model?: string;
  ms?: { firstToken: number | null; total: number };
}

/**
 * Per-user, append-only JSONL timeline, fully loaded in memory with a BM25
 * index over it. One file per user keeps it inspectable (`cat data/<id>.jsonl`)
 * and needs no native deps or database server, so `npm install && npm run dev`
 * works everywhere. A personal chat history is small (thousands of exchanges,
 * a few MB); scans are microseconds at that size.
 */
export class Timeline {
  readonly exchanges: Exchange[] = [];
  readonly index = new Bm25Index();

  constructor(private file: string) {
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.addInMemory(JSON.parse(line) as Exchange);
        } catch {
          /* skip a torn last line from a crash mid-write */
        }
      }
    }
  }

  private addInMemory(e: Exchange) {
    this.exchanges.push(e);
    // The question is what people search their memory by; weight it higher.
    this.index.add(this.exchanges.length - 1, `${e.question} ${e.question} ${e.answer.slice(0, 3000)}`);
  }

  append(e: Exchange) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(e) + "\n");
    this.addInMemory(e);
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
