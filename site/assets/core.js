// Writing Replay core: the replay file format, applying events, and the analysis a reader sees.
// No DOM and no network. The same module runs in the browser and in the Node tests.

export const FORMAT = "writing-replay";
export const VERSION = 1;
export const TICK_MS = 50; // timings are rounded to 1/20 s; key-hold durations are never recorded

// Where a change came from. Stored as the optional fifth item of an event (0 when absent).
export const ORIGIN = Object.freeze({ KEY: 0, CHUNK: 1, PASTE: 2, DROP: 3, HISTORY: 4, OTHER: 5 });
export const ORIGIN_KEYS = Object.freeze(["key", "chunk", "paste", "drop", "history", "other"]);

export const LIMITS = Object.freeze({
  events: 2_000_000,
  textLength: 5_000_000,
  fileBytes: 64_000_000,
  sessions: 5_000,
  nameLength: 200,
  linkChars: 16_000, // longer links risk being cut off by chat apps and mail clients; send the file instead
});

// Thresholds used by analyze() and observations(). They are plain heuristics, documented on the
// site's format page, and none of them is a verdict.
export const THRESHOLDS = Object.freeze({
  idleMs: 60_000, // a gap longer than this is a pause, not writing time
  burstMs: 2_000, // key-to-key gaps up to this long count towards typing rhythm
  runGapMs: 5_000, // a "continuous run" has no gap longer than this
  bigChunk: 40, // keyboard insertions of at least this many characters are listed
  evenCv: 0.3, // rhythm variation below this is called "very even"
  evenMinGaps: 150,
  runChars: 1_000,
  lowRevisionShare: 0.01,
  lowRevisionMin: 500,
});

export class ReplayError extends Error {}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/**
 * The single edit that turns `a` into `b`: { pos, del, ins }, or null when they are equal.
 * `caret` is the cursor position after the edit. When the text after the caret is unchanged, the
 * edit is pinned to end at the caret, so typing "a" inside "aaa" is attributed to the right place.
 */
export function diff(a, b, caret = -1) {
  if (a === b) return null;
  if (caret >= 0 && caret <= b.length && !(caret < b.length && isLow(b.charCodeAt(caret)))) {
    const tail = b.length - caret;
    if (tail <= a.length && a.endsWith(b.slice(caret))) {
      const aEnd = a.length - tail;
      const max = Math.min(aEnd, caret);
      let p = 0;
      while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
      if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
      return { pos: p, del: aEnd - p, ins: b.slice(p, caret) };
    }
  }
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  return { pos: p, del: a.length - p - s, ins: b.slice(p, b.length - s) };
}

const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** True when `s` is at most one character as a person sees it (one key press, one emoji). */
export function isSingleGrapheme(s) {
  if (s.length <= 1) return true;
  if (segmenter) {
    let n = 0;
    for (const _ of segmenter.segment(s)) if (++n > 1) return false;
    return true;
  }
  return [...s].length <= 1;
}

export const codePoints = (s) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (!isLow(s.charCodeAt(i)) || i === 0 || !isHigh(s.charCodeAt(i - 1))) n++;
  return n;
};

export function wordCount(text) {
  const t = text.trim();
  return t ? t.split(/\s+/u).length : 0;
}

/** Classify one change from the browser's own report of it (InputEvent.inputType, isTrusted). */
export function classify(inputType, trusted, ins) {
  if (!trusted) return ORIGIN.OTHER;
  const t = inputType || "";
  if (t === "insertFromPaste" || t === "insertFromPasteAsQuotation" || t === "insertFromYank") return ORIGIN.PASTE;
  if (t === "insertFromDrop") return ORIGIN.DROP;
  if (t === "historyUndo" || t === "historyRedo") return ORIGIN.HISTORY;
  if (t.startsWith("insert") || t.startsWith("delete")) return isSingleGrapheme(ins) ? ORIGIN.KEY : ORIGIN.CHUNK;
  // No type reported (some keyboards and older browsers): one character is a key press,
  // anything larger is unexplained.
  if (t === "") return isSingleGrapheme(ins) ? ORIGIN.KEY : ORIGIN.OTHER;
  return ORIGIN.OTHER;
}

/**
 * The edits of one sitting. The page hands it the text box's value after every change; it works
 * out what changed, when, and where it came from. It never looks at keys, only at the text.
 */
export class SessionLog {
  constructor(text = "", start = new Date().toISOString()) {
    this.text = text;
    this.start = start;
    this.events = [];
    this.lastTick = 0;
  }

  /** Record whatever turned the known text into `value`. Returns the event, or null if nothing changed. */
  change(value, caret, inputType, trusted, elapsedMs) {
    const d = diff(this.text, value, caret);
    if (!d) return null;
    const tick = Math.max(this.lastTick, Math.round(elapsedMs / TICK_MS));
    const ev = [tick - this.lastTick, d.pos, d.del, d.ins, classify(inputType, trusted, d.ins)];
    this.lastTick = tick;
    this.text = value;
    this.events.push(ev);
    return ev;
  }
}

// ---------- the document while a recording is replayed ----------

// Removals of two or more characters are remembered so that text coming back (a cut pasted
// elsewhere, an undo) keeps its origin. Single backspaces are not kept: they would push a cut
// sentence out of the list long before it was pasted back.
const KEEP_DELETIONS = 200;

/** text and orig have the same length; orig holds one origin digit per UTF-16 unit of text. */
export function createDoc() {
  return { text: "", orig: "", deletions: [] };
}

// Text that comes back (a cut pasted elsewhere, an undo, a copy of the writer's own words) keeps
// the origin it had. Only text that isn't already part of this document counts as pasted in.
function sourceOf(doc, ins) {
  for (let i = doc.deletions.length - 1; i >= 0; i--) {
    if (doc.deletions[i].text === ins) return doc.deletions[i].orig;
  }
  const at = doc.text.indexOf(ins);
  if (at >= 0) return doc.orig.slice(at, at + ins.length);
  for (let i = doc.deletions.length - 1; i >= 0; i--) {
    const k = doc.deletions[i].text.indexOf(ins);
    if (k >= 0) return doc.deletions[i].orig.slice(k, k + ins.length);
  }
  return null;
}

/**
 * Apply one event [dt, pos, del, ins, origin?] to the document.
 * Returns { removed, internal }: the text removed, and whether an insertion was the writer's own
 * text coming back. Throws ReplayError when the event doesn't fit the text before it.
 */
export function applyEvent(doc, ev) {
  const pos = ev[1];
  const del = ev[2];
  const ins = ev[3];
  const origin = ev[4] || 0;
  if (pos + del > doc.text.length) throw new ReplayError("An edit in this recording doesn't fit the text before it.");
  let insOrig = "";
  let internal = false;
  if (ins) {
    if (doc.text.length - del + ins.length > LIMITS.textLength) throw new ReplayError("The text in this recording is too long to open here.");
    insOrig = String(origin).repeat(ins.length);
    if (origin === ORIGIN.PASTE || origin === ORIGIN.DROP || origin === ORIGIN.HISTORY) {
      const src = sourceOf(doc, ins);
      if (src !== null) {
        insOrig = src;
        internal = true;
      }
    }
  }
  let removed = "";
  if (del) {
    removed = doc.text.slice(pos, pos + del);
    if (del > 1) {
      doc.deletions.push({ text: removed, orig: doc.orig.slice(pos, pos + del) });
      if (doc.deletions.length > KEEP_DELETIONS) doc.deletions.shift();
    }
  }
  doc.text = doc.text.slice(0, pos) + ins + doc.text.slice(pos + del);
  doc.orig = doc.orig.slice(0, pos) + insOrig + doc.orig.slice(pos + del);
  return { removed, internal };
}

/** Replay every event and return the final { text, orig }. */
export function replayAll(replay) {
  const doc = createDoc();
  for (const s of replay.sessions) for (const ev of s.events) applyEvent(doc, ev);
  return doc;
}

// ---------- hashing, compression, base64url ----------

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new ReplayError("This link is damaged: it has characters a replay link never contains.");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const canCompress = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

async function pipe(bytes, stream, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new ReplayError("This link unpacks to more data than a replay link can hold.");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Pack a serialized replay into the part of a link after "#r=". */
export async function encodeLink(serialized) {
  const packed = await pipe(new TextEncoder().encode(serialized), new CompressionStream("deflate-raw"), LIMITS.fileBytes);
  return toBase64Url(packed);
}

/** Unpack the part of a link after "#r=" back into the serialized replay. */
export async function decodeLink(fragment) {
  const packed = fromBase64Url(fragment);
  let bytes;
  try {
    bytes = await pipe(packed, new DecompressionStream("deflate-raw"), 4_000_000);
  } catch (e) {
    if (e instanceof ReplayError) throw e;
    throw new ReplayError("This link is damaged or was cut short. Ask the writer for the replay file instead.");
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// ---------- the file ----------

/** The exact text of a replay file. The file's fingerprint is the SHA-256 of these bytes. */
export function serialize(r) {
  const head = [
    ["format", FORMAT],
    ["version", VERSION],
    ["how_to_open", r.how_to_open],
    ["app", r.app],
    ["title", r.title],
    ["author", r.author],
    ["exported", r.exported],
    ["tick_ms", r.tick_ms],
    ["final", r.final],
  ];
  const lines = ["{"];
  for (const [k, v] of head) {
    if (v !== undefined && v !== null && v !== "") lines.push(`${JSON.stringify(k)}:${JSON.stringify(v)},`);
  }
  lines.push('"sessions":[');
  r.sessions.forEach((s, i) => {
    lines.push(`{"start":${JSON.stringify(s.start)},"events":[`);
    const last = s.events.length - 1;
    s.events.forEach((e, j) => {
      const item = e[4] ? [e[0], e[1], e[2], e[3], e[4]] : [e[0], e[1], e[2], e[3]];
      lines.push(JSON.stringify(item) + (j < last ? "," : ""));
    });
    lines.push("]}" + (i < r.sessions.length - 1 ? "," : ""));
  });
  lines.push("]", "}");
  return lines.join("\n") + "\n";
}

const isInt = (n) => Number.isInteger(n) && n >= 0 && n <= 0x7fffffff;

function cleanName(v) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, LIMITS.nameLength);
}

/** Read and check a replay file's text. Throws ReplayError with a message a reader can act on. */
export function parse(text) {
  if (typeof text !== "string" || !text.trim()) throw new ReplayError("This file is empty.");
  if (text.length > LIMITS.fileBytes) throw new ReplayError("This file is too large to be a writing replay.");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ReplayError("This isn't a writing replay file (it isn't valid JSON). Replay files end in .writing-replay.json.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.format !== FORMAT) {
    throw new ReplayError("This isn't a writing replay file. Replay files end in .writing-replay.json and are made by the Writing Replay editor.");
  }
  if (!Number.isInteger(raw.version) || raw.version < 1) throw new ReplayError("This replay file has no usable version number.");
  if (raw.version > VERSION) throw new ReplayError("This replay was made by a newer version of Writing Replay than this page understands. Reload the page and try again.");
  const tick = raw.tick_ms;
  if (!Number.isInteger(tick) || tick < 1 || tick > 1000) throw new ReplayError("This replay file has an invalid timing unit.");
  if (!Array.isArray(raw.sessions) || raw.sessions.length === 0) throw new ReplayError("This replay file has no writing sessions in it.");
  if (raw.sessions.length > LIMITS.sessions) throw new ReplayError("This replay file has too many sessions to open here.");
  let count = 0;
  const sessions = raw.sessions.map((s, si) => {
    if (!s || typeof s !== "object" || !Array.isArray(s.events)) throw new ReplayError(`Session ${si + 1} in this replay file is damaged.`);
    const startMs = Date.parse(s.start);
    if (typeof s.start !== "string" || Number.isNaN(startMs)) throw new ReplayError(`Session ${si + 1} in this replay file has no valid start time.`);
    count += s.events.length;
    if (count > LIMITS.events) throw new ReplayError("This replay file has too many events to open here.");
    const events = s.events.map((e) => {
      const ok = Array.isArray(e) && (e.length === 4 || e.length === 5) && isInt(e[0]) && isInt(e[1]) && isInt(e[2]) &&
        typeof e[3] === "string" && (e.length === 4 || (Number.isInteger(e[4]) && e[4] >= 0 && e[4] <= 5)) && (e[2] > 0 || e[3].length > 0);
      if (!ok) throw new ReplayError(`An edit in session ${si + 1} of this replay file is damaged.`);
      return [e[0], e[1], e[2], e[3], e[4] || 0];
    });
    return { start: new Date(startMs).toISOString(), events };
  });
  if (count === 0) throw new ReplayError("This replay file has no edits in it.");
  const final = raw.final && typeof raw.final === "object" ? raw.final : {};
  return {
    format: FORMAT,
    version: raw.version,
    how_to_open: typeof raw.how_to_open === "string" ? raw.how_to_open.slice(0, 500) : "",
    app: typeof raw.app === "string" ? raw.app.slice(0, 300) : "",
    title: cleanName(raw.title),
    author: cleanName(raw.author),
    exported: typeof raw.exported === "string" && !Number.isNaN(Date.parse(raw.exported)) ? new Date(Date.parse(raw.exported)).toISOString() : "",
    tick_ms: tick,
    final: {
      length: isInt(final.length) ? final.length : -1,
      sha256: typeof final.sha256 === "string" && /^[0-9a-f]{64}$/.test(final.sha256) ? final.sha256 : "",
    },
    sessions,
  };
}

/** Build a replay object from an editor draft. Sessions without edits are left out. */
export async function buildReplay({ title, author, sessions, app, verifyUrl, exported }) {
  const kept = sessions.filter((s) => s.events.length > 0).map((s) => ({ start: s.start, events: s.events }));
  const replay = { title: cleanName(title), author: cleanName(author), tick_ms: TICK_MS, sessions: kept };
  const doc = replayAll(replay);
  return {
    format: FORMAT,
    version: VERSION,
    how_to_open: `Open ${verifyUrl} and choose this file to watch how the text was typed. The recording is the list of edits below; it can show how text was entered, not who entered it.`,
    app,
    title: replay.title,
    author: replay.author,
    exported: exported || new Date().toISOString(),
    tick_ms: TICK_MS,
    final: { length: doc.text.length, sha256: await sha256Hex(doc.text) },
    sessions: kept,
  };
}

// ---------- analysis ----------

const median = (sorted) => (sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : 0);

/**
 * Replay a parsed recording and measure it. Everything a reader is shown comes from here.
 * Throws ReplayError when the events don't fit together.
 */
export function analyze(replay) {
  const T = THRESHOLDS;
  const tick = replay.tick_ms;
  const doc = createDoc();
  const sessions = [];
  const inserts = [];
  const timeline = [[0, 0, 0, 0]]; // [active ms, text length, origin, session index]
  const gaps = [];
  const pauses = { over2s: 0, over10s: 0, over60s: 0 };
  let index = 0;
  let produced = 0;
  let deleted = 0;
  let keyInserts = 0;
  let jumps = 0;
  let activeMs = 0;
  let longestRun = 0;
  let lastEnd = -1;

  replay.sessions.forEach((s, si) => {
    const startMs = Date.parse(s.start);
    let t = 0;
    let first = true;
    let prevKeyInsert = false;
    let run = 0;
    const info = { start: startMs, firstMs: 0, lastMs: 0, events: s.events.length, activeMs: 0, lengthBefore: doc.text.length, lengthAfter: 0 };
    for (const ev of s.events) {
      const [dt, pos, del, ins, origin] = ev;
      t += dt;
      const gapMs = dt * tick;
      if (first) {
        info.firstMs = startMs + t * tick;
        lastEnd = -1;
      } else {
        if (gapMs <= T.idleMs) {
          activeMs += gapMs;
          info.activeMs += gapMs;
        } else pauses.over60s++;
        if (gapMs > 2_000) pauses.over2s++;
        if (gapMs > 10_000) pauses.over10s++;
        if (gapMs > T.runGapMs) run = 0;
      }
      const keyInsert = origin === ORIGIN.KEY && ins.length > 0 && del === 0;
      if (keyInsert && prevKeyInsert && !first && gapMs <= T.burstMs) gaps.push(gapMs);
      prevKeyInsert = keyInsert;
      if (lastEnd >= 0 && pos !== lastEnd && pos + del !== lastEnd) jumps++;
      const { removed, internal } = applyEvent(doc, ev);
      lastEnd = pos + ins.length;
      const n = codePoints(ins);
      produced += n;
      deleted += codePoints(removed);
      if (keyInsert) keyInserts++;
      if (origin === ORIGIN.KEY || origin === ORIGIN.CHUNK) {
        run += n;
        if (run > longestRun) longestRun = run;
      }
      const listed = n > 0 && (origin === ORIGIN.PASTE || origin === ORIGIN.DROP || origin === ORIGIN.OTHER ||
        (origin === ORIGIN.HISTORY && !internal) || (origin === ORIGIN.CHUNK && n >= T.bigChunk));
      if (listed) {
        inserts.push({ index, session: si, wallMs: startMs + t * tick, activeMs, origin, internal, length: n, preview: ins.slice(0, 120) });
      }
      timeline.push([activeMs, doc.text.length, internal ? ORIGIN.KEY : origin, si]);
      first = false;
      index++;
    }
    info.lastMs = startMs + t * tick;
    info.lengthAfter = doc.text.length;
    sessions.push(info);
  });

  const byOrigin = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < doc.text.length; i++) {
    if (isLow(doc.text.charCodeAt(i)) && i > 0 && isHigh(doc.text.charCodeAt(i - 1))) continue;
    byOrigin[doc.orig.charCodeAt(i) - 48]++;
  }
  const chars = byOrigin.reduce((a, b) => a + b, 0);
  gaps.sort((a, b) => a - b);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const sd = gaps.length ? Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) : 0;
  const first = sessions[0];
  const last = sessions[sessions.length - 1];
  const external = inserts.filter((x) => !x.internal && (x.origin === ORIGIN.PASTE || x.origin === ORIGIN.DROP));
  return {
    text: doc.text,
    orig: doc.orig,
    chars,
    words: wordCount(doc.text),
    byOrigin,
    keyboard: byOrigin[ORIGIN.KEY] + byOrigin[ORIGIN.CHUNK],
    pasted: byOrigin[ORIGIN.PASTE] + byOrigin[ORIGIN.DROP],
    unexplained: byOrigin[ORIGIN.HISTORY] + byOrigin[ORIGIN.OTHER],
    events: index,
    produced,
    deleted,
    keyInserts,
    jumps,
    activeMs,
    spanMs: last.lastMs - first.firstMs,
    pauses,
    rhythm: { n: gaps.length, medianMs: median(gaps), meanMs: mean, cv: mean ? sd / mean : 0 },
    longestRun,
    inserts,
    externalPastes: external.length,
    largestPaste: external.reduce((m, x) => Math.max(m, x.length), 0),
    sessions,
    timeline,
  };
}

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const plural = (n, one, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Share of the final text, as a whole percent that never rounds a real amount down to 0 or up to 100. */
export function share(part, whole) {
  if (!whole || !part) return 0;
  if (part === whole) return 100;
  return Math.min(99, Math.max(1, pct(part, whole)));
}

/**
 * Plain statements about the recording, for a reader. Each is a fact plus what it can mean; none is
 * a verdict. `kind` is "note" for something worth a closer look and "plain" otherwise.
 */
export function observations(a) {
  const T = THRESHOLDS;
  const out = [];
  if (a.externalPastes === 0) {
    out.push({ id: "no-paste", kind: "plain", text: "No text was pasted or dropped in from outside this document." });
  } else {
    out.push({
      id: "paste",
      kind: "note",
      text: `${share(a.pasted, a.chars)}% of the final text arrived by paste or drop (${plural(a.externalPastes, "paste")} from outside the document; the largest was ${plural(a.largestPaste, "character")}). The replay shows each one. Quotes, references and notes are common reasons to paste.`,
    });
  }
  const chunks = a.inserts.filter((x) => x.origin === ORIGIN.CHUNK);
  if (chunks.length) {
    const top = chunks.reduce((m, x) => Math.max(m, x.length), 0);
    out.push({
      id: "chunks",
      kind: "note",
      text: `${plural(chunks.length, "keyboard insertion")} of ${T.bigChunk} or more characters at once (the largest was ${plural(top, "character")}). Dictation, text expanders and some phone keyboards do this; a single key press doesn't.`,
    });
  }
  const outside = a.inserts.filter((x) => x.origin === ORIGIN.OTHER || (x.origin === ORIGIN.HISTORY && !x.internal));
  if (outside.length) {
    const n = outside.reduce((m, x) => m + x.length, 0);
    out.push({
      id: "other",
      kind: "note",
      text: `${plural(n, "character")} appeared without a keyboard, paste or drop event. Browser extensions (grammar checkers, for example) and scripts change text this way.`,
    });
  }
  if (a.produced >= T.lowRevisionMin && a.deleted / a.produced < T.lowRevisionShare) {
    out.push({
      id: "no-revision",
      kind: "note",
      text: `Almost nothing was deleted or corrected (${plural(a.deleted, "character")} out of ${a.produced.toLocaleString("en-US")} entered). Typing by hand usually includes typos that get fixed.`,
    });
  } else if (a.produced > 0) {
    out.push({
      id: "revision",
      kind: "plain",
      text: `${pct(a.deleted, a.produced)}% of what was entered was later deleted or rewritten${a.jumps ? `, and the writer moved the cursor to edit somewhere else ${plural(a.jumps, "time")}` : ""}.`,
    });
  }
  if (a.rhythm.n >= T.evenMinGaps && a.rhythm.cv < T.evenCv) {
    out.push({
      id: "even",
      kind: "note",
      text: "The time between keystrokes was very even. Typing by hand usually has an uneven rhythm, with bursts and hesitations; a program typing at a set speed is even.",
    });
  }
  if (a.longestRun >= T.runChars && a.pauses.over10s === 0) {
    out.push({
      id: "no-pause",
      kind: "note",
      text: `${a.longestRun.toLocaleString("en-US")} characters were entered in one run with no pause longer than ${T.runGapMs / 1000} seconds. Composing usually includes pauses to think; copying from another source often doesn't.`,
    });
  }
  if (!out.some((o) => o.kind === "note")) {
    out.push({
      id: "ordinary",
      kind: "plain",
      text: "This recording has the ordinary marks of typing by hand: uneven rhythm, pauses and corrections. That is what hand typing looks like. It is also what a careful imitation would look like.",
    });
  }
  return out;
}

/** "1 h 5 min", "12 min", "45 s". */
export function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A safe file name for a replay: "my-essay.writing-replay.json". */
export function fileName(title, dateIso) {
  const slug = (title || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || "writing-" + (dateIso || new Date().toISOString()).slice(0, 10)}.writing-replay.json`;
}
