import { marked } from "/vendor/marked.js";

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const log = document.getElementById("log");
const empty = document.getElementById("empty");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const send = document.getElementById("send");
let lastDay = null;
let busy = false;

// --- markdown: no raw HTML from the model, http(s) links only, [n] → citation links
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html: (token) => escapeHtml(token.text ?? token.raw ?? ""),
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!/^https?:\/\//i.test(href)) return text;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});
function renderMarkdown(text, sources) {
  const html = marked.parse(text);
  return html.replace(/\[(\d{1,2})\]/g, (m, n) => {
    const s = sources[Number(n) - 1];
    if (!s) return m;
    return `<sup><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(s.title)}">${n}</a></sup>`;
  });
}

// --- dates
const dayKey = (d) => d.toLocaleDateString("en-CA", { timeZone: tz });
const dayLabel = (d) => {
  const today = dayKey(new Date());
  const yest = dayKey(new Date(Date.now() - 86400000));
  const k = dayKey(d);
  if (k === today) return "Today";
  if (k === yest) return "Yesterday";
  return d.toLocaleDateString(undefined, { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" });
};
const timeLabel = (d) => d.toLocaleTimeString(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit" });

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function scrollDown() {
  log.scrollTop = log.scrollHeight;
}

function addDaySeparator(date) {
  const k = dayKey(date);
  if (k === lastDay) return;
  lastDay = k;
  log.append(el("div", "day", dayLabel(date)));
}

/** A rendered question/answer pair; returns handles for live updates. */
function addTurn(question, askedAt) {
  empty.hidden = true;
  addDaySeparator(askedAt);
  const turn = el("section", "turn");
  const q = el("div", "q", question);
  const t = el("time", null, timeLabel(askedAt));
  t.dateTime = askedAt.toISOString();
  q.append(t);
  const trace = el("div", "trace");
  const a = el("div", "a");
  const src = el("div", "sources");
  const meta = el("div", "meta");
  turn.append(q, trace, a, src, meta);
  log.append(turn);
  return { turn, trace, a, src, meta };
}

function renderSources(node, sources) {
  node.replaceChildren();
  if (!sources.length) return;
  node.append("Sources");
  const ol = el("ol");
  for (const s of sources) {
    const li = el("li");
    const link = el("a", null, s.title || s.url);
    link.href = s.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    li.append(link);
    ol.append(li);
  }
  node.append(ol);
}

function renderMeta(node, ex) {
  const bits = [];
  if (ex.searches?.length) bits.push(`${ex.searches.length} search${ex.searches.length > 1 ? "es" : ""}`);
  if (ex.ms?.firstToken != null) bits.push(`first words in ${(ex.ms.firstToken / 1000).toFixed(1)}s`);
  if (ex.ms?.total != null) bits.push(`done in ${(ex.ms.total / 1000).toFixed(1)}s`);
  node.textContent = bits.join(" · ");
}

function renderExchange(ex) {
  const h = addTurn(ex.question, new Date(ex.askedAt));
  for (const q of ex.searches ?? []) h.trace.append(el("span", "chip", `Searched “${q}”`));
  h.a.innerHTML = renderMarkdown(ex.answer, ex.sources);
  renderSources(h.src, ex.sources);
  renderMeta(h.meta, ex);
}

async function loadHistory() {
  const res = await fetch("/api/history");
  const { exchanges } = await res.json();
  for (const ex of exchanges) renderExchange(ex);
  empty.hidden = exchanges.length > 0;
  scrollDown();
}

async function ask(message) {
  busy = true;
  send.disabled = true;
  const h = addTurn(message, new Date());
  h.a.classList.add("cursor");
  const status = el("span", "chip live", "Thinking…");
  h.trace.append(status);
  scrollDown();

  let text = "";
  const sources = [];
  let pending = false;
  const paint = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      h.a.innerHTML = renderMarkdown(text, sources);
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
      if (nearBottom) scrollDown();
    });
  };
  const setStatus = (s) => {
    status.textContent = s;
    status.hidden = !s;
  };

  const handle = (ev) => {
    switch (ev.type) {
      case "context": {
        const n = ev.recalled.length;
        if (n) h.trace.insertBefore(el("span", "chip", `Recalled ${n} earlier conversation${n > 1 ? "s" : ""}`), status);
        for (const d of ev.dateRefs) {
          h.trace.insertBefore(el("span", "chip", `“${d.phrase}” → ${d.label}`), status);
        }
        break;
      }
      case "searching":
        setStatus("Searching the web…");
        break;
      case "search":
        h.trace.insertBefore(el("span", "chip", `Searched “${ev.query}”`), status);
        setStatus("Reading results…");
        break;
      case "results":
        if (ev.error) setStatus(`Search failed (${ev.error})`);
        break;
      case "text":
        setStatus("");
        text += ev.delta;
        paint();
        break;
      case "cite":
        for (const r of ev.refs) sources[r.n - 1] = { url: r.url, title: r.title };
        text += ev.refs.map((r) => `[${r.n}]`).join("");
        paint();
        break;
      case "done":
        text = ev.exchange.answer;
        h.a.innerHTML = renderMarkdown(text, ev.exchange.sources);
        renderSources(h.src, ev.exchange.sources);
        renderMeta(h.meta, ev.exchange);
        break;
      case "error":
        h.a.classList.add("error");
        text += (text ? "\n\n" : "") + ev.message;
        paint();
        break;
    }
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, tz }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      handle({ type: "error", message: err.error || `Request failed (${res.status})` });
    } else {
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) handle(JSON.parse(chunk.slice(6)));
        }
      }
    }
  } catch (e) {
    handle({ type: "error", message: `Connection lost: ${e.message}` });
  } finally {
    status.remove();
    h.a.classList.remove("cursor");
    busy = false;
    send.disabled = !input.value.trim();
    input.focus();
  }
}

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
  send.disabled = busy || !input.value.trim();
}

input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message || busy) return;
  input.value = "";
  autosize();
  ask(message);
});
document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Forget every conversation? This can't be undone.")) return;
  await fetch("/api/history", { method: "DELETE" });
  log.querySelectorAll(".turn, .day").forEach((n) => n.remove());
  lastDay = null;
  empty.hidden = false;
});

autosize();
loadHistory();
