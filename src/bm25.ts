/**
 * Small in-memory BM25 keyword index. Recall in a chat history is dominated by
 * proper nouns and product names ("Postgres", "Neon", "HubSpot") where lexical
 * match is precise; see DESIGN.md for why embeddings were left for later.
 */

const STOP = new Set(
  (
    "a an the and or but if then so of to in on at by for with from about as into over " +
    "is are was were be been being am do does did done have has had having can could " +
    "should would will shall may might must i me my we our us you your he she it its " +
    "they them their this that these those what which who whom whose when where why how " +
    "any some all no not yes just also than too very there here up down out off again " +
    "ask asked asking tell told say said know think please thanks thank hi hello hey " +
    "still since today yesterday now last week month day ago changed change anything"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().normalize("NFKD").split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Deliberately tiny stemmer: plural and common verb endings only. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export class Bm25Index {
  private docs = new Map<number, Map<string, number>>();
  private lengths = new Map<number, number>();
  private df = new Map<string, number>();
  private totalLen = 0;
  private k1 = 1.2;
  private b = 0.75;

  /** Index `text` under `id`; calling again for the same id adds to that document. */
  add(id: number, text: string) {
    const tf = this.docs.get(id) ?? new Map<string, number>();
    const toks = tokenize(text);
    for (const t of toks) {
      if (!tf.has(t)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    this.docs.set(id, tf);
    this.lengths.set(id, (this.lengths.get(id) ?? 0) + toks.length);
    this.totalLen += toks.length;
  }

  clear() {
    this.docs.clear();
    this.lengths.clear();
    this.df.clear();
    this.totalLen = 0;
  }

  search(query: string, limit: number): Array<{ id: number; score: number }> {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.size;
    if (!q.length || !N) return [];
    const avg = this.totalLen / N;
    const scored: Array<{ id: number; score: number }> = [];
    for (const [id, tf] of this.docs) {
      let score = 0;
      const len = this.lengths.get(id)!;
      for (const term of q) {
        const f = tf.get(term);
        if (!f) continue;
        const n = this.df.get(term)!;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / avg));
      }
      if (score > 0) scored.push({ id, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
