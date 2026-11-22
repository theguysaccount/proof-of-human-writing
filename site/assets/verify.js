// The reader page: open a replay file or link, check it, measure it and play it back.
// Everything happens in this browser. Text from the recording is only ever placed with textContent.
import {
  ORIGIN, LIMITS, ReplayError, parse, analyze, observations, createDoc, applyEvent, sha256Hex, decodeLink, canCompress,
  share, duration, codePoints,
} from "./core.js";
import { $, h, svg, track, fmtDateTime, fmtDate, fmtTime, fmtInt, clock, shortPrint } from "./common.js";

const PREVIEW_KEY = "writing-replay.preview";
const ORIGIN_LABEL = ["typed", "several characters at once", "pasted", "dropped in", "restored by undo", "changed without a key press"];

const opener = $("#opener");
const report = $("#report");
const errorBox = $("#error");
let player = null;

function fail(message) {
  report.hidden = true;
  opener.hidden = false;
  errorBox.textContent = message;
  errorBox.hidden = false;
  document.body.dataset.state = "error";
}

/** Runs of text that share an origin, as spans. `caret` (optional) adds a cursor mark at that offset. */
function runs(text, orig, caret = -1) {
  const frag = document.createDocumentFragment();
  const push = (from, to) => {
    if (to > from) frag.append(h("span", { class: `o${orig[from]}` }, text.slice(from, to)));
  };
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || orig[i] !== orig[start] || i === caret) {
      push(start, i);
      if (i === caret) frag.append(h("span", { class: "caret", "aria-hidden": "true" }));
      start = i;
    }
  }
  if (caret === 0) frag.prepend(h("span", { class: "caret", "aria-hidden": "true" }));
  return frag;
}

// ---------- the player ----------

class Player {
  constructor(replay, a) {
    this.STEP = 400;
    this.CAP = 2000; // with "skip pauses" on, no gap plays longer than this
    this.evs = [];
    this.sess = [];
    this.wall = [];
    this.real = []; // play position of each edit in ms, pauses included
    this.capped = []; // the same with pauses shortened
    let real = 0;
    let capped = 0;
    replay.sessions.forEach((s, si) => {
      const start = Date.parse(s.start);
      let t = 0;
      s.events.forEach((ev, j) => {
        t += ev[0];
        const gap = j === 0 ? (si === 0 ? 0 : 1200) : ev[0] * replay.tick_ms;
        real += gap;
        capped += Math.min(gap, this.CAP);
        this.evs.push(ev);
        this.sess.push(si);
        this.wall.push(start + t * replay.tick_ms);
        this.real.push(real);
        this.capped.push(capped);
      });
    });
    this.n = this.evs.length;
    this.sessions = replay.sessions.length;
    this.timeline = a.timeline;
    this.snaps = [];
    const doc = createDoc();
    for (let i = 0; i < this.n; i++) {
      if (i % this.STEP === 0) this.snaps.push({ text: doc.text, orig: doc.orig, deletions: doc.deletions.slice() });
      applyEvent(doc, this.evs[i]);
    }
    this.i = 0;
    this.doc = createDoc();
    this.playing = false;
    this.clock = 0;
    this.last = 0;
    this.screen = $("#screen");
    this.slider = $("#seek");
    this.slider.max = String(this.n);
    this.button = $("#play");
    this.button.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    this.slider.addEventListener("input", () => {
      this.pause();
      this.seek(Number(this.slider.value));
    });
    $("#speed").addEventListener("change", () => this.sync());
    $("#skip").addEventListener("change", () => this.sync());
    $("#to-end").addEventListener("click", () => {
      this.pause();
      this.seek(this.n);
    });
    this.seek(this.n);
  }

  get times() {
    return $("#skip").checked ? this.capped : this.real;
  }

  sync() {
    this.clock = this.i > 0 ? this.times[this.i - 1] : 0;
    this.render();
  }

  seek(n) {
    n = Math.max(0, Math.min(this.n, n));
    const k = Math.min(Math.floor(n / this.STEP), this.snaps.length - 1);
    const snap = this.snaps[k];
    this.doc = { text: snap.text, orig: snap.orig, deletions: snap.deletions.slice() };
    for (let j = k * this.STEP; j < n; j++) applyEvent(this.doc, this.evs[j]);
    this.i = n;
    this.sync();
  }

  play() {
    if (this.i >= this.n) this.seek(0);
    this.playing = true;
    this.button.textContent = "Pause";
    this.button.setAttribute("aria-pressed", "true");
    this.last = performance.now();
    const frame = (now) => {
      if (!this.playing) return;
      this.clock += (now - this.last) * Number($("#speed").value);
      this.last = now;
      const times = this.times;
      let moved = false;
      while (this.i < this.n && times[this.i] <= this.clock) {
        applyEvent(this.doc, this.evs[this.i]);
        this.i++;
        moved = true;
      }
      if (moved) this.render();
      if (this.i >= this.n) this.pause();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    track("replay_play");
  }

  pause() {
    this.playing = false;
    this.button.textContent = this.i >= this.n ? "Play again" : "Play";
    this.button.setAttribute("aria-pressed", "false");
  }

  describe(ev) {
    const [, , del, ins, origin] = ev;
    const n = codePoints(ins);
    if (!ins) return `deleted ${fmtInt(del)} ${del === 1 ? "character" : "characters"}`;
    const what = n === 1 ? (ins === "\n" ? "a line break" : ins === " " ? "a space" : `“${ins}”`) : `${fmtInt(n)} characters`;
    const verb = ["typed", "entered", "pasted", "dropped in", "restored", "changed"][origin];
    return `${verb} ${what}${del ? `, replacing ${fmtInt(del)}` : ""}`;
  }

  render() {
    const ev = this.i > 0 ? this.evs[this.i - 1] : null;
    const caret = ev ? ev[1] + ev[3].length : 0;
    this.screen.replaceChildren(runs(this.doc.text, this.doc.orig, caret));
    const mark = this.screen.querySelector(".caret");
    if (mark) {
      const top = mark.offsetTop - this.screen.offsetTop;
      if (top < this.screen.scrollTop + 20 || top > this.screen.scrollTop + this.screen.clientHeight - 40) {
        this.screen.scrollTop = Math.max(0, top - this.screen.clientHeight / 2);
      }
    }
    this.slider.value = String(this.i);
    const times = this.times;
    $("#time").textContent = `${clock(this.i > 0 ? times[this.i - 1] : 0)} / ${clock(times[this.n - 1] || 0)}`;
    $("#where").textContent = ev
      ? `Edit ${fmtInt(this.i)} of ${fmtInt(this.n)}: ${this.describe(ev)}. ${this.sessions > 1 ? `Sitting ${this.sess[this.i - 1] + 1} of ${this.sessions}, ` : ""}${fmtDate(this.wall[this.i - 1])} ${fmtTime(this.wall[this.i - 1])}.`
      : `Before the first edit. ${fmtInt(this.n)} edits follow.`;
    if (!this.playing) this.button.textContent = this.i >= this.n ? "Play again" : "Play";
    const head = $("#playhead");
    if (head && this.xOf) {
      const x = this.xOf(this.timeline[this.i][0]);
      head.setAttribute("x1", x);
      head.setAttribute("x2", x);
    }
    this.screen.dataset.edits = String(this.i);
  }
}

// ---------- the chart ----------

function niceStep(max, target) {
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

function drawChart(a, firstIndex) {
  const W = 720, H = 240, L = 52, R = 14, T = 14, B = 34;
  const maxMs = Math.max(a.timeline[a.timeline.length - 1][0], 1000);
  const maxLen = Math.max(...a.timeline.map((p) => p[1]), 1);
  const x = (ms) => L + ((W - L - R) * ms) / maxMs;
  const y = (len) => H - B - ((H - T - B) * len) / maxLen;
  const root = $("#chart");
  root.replaceChildren();
  root.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const stepY = niceStep(maxLen, 4);
  for (let v = 0; v <= maxLen; v += stepY) {
    root.append(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }), svg("text", { x: L - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtInt(v)));
  }
  const inSeconds = maxMs < 120_000;
  const unit = inSeconds ? 1000 : 60_000;
  const stepX = niceStep(maxMs / unit, 6);
  for (let v = 0; v <= maxMs / unit + 1e-9; v += stepX) {
    const label = inSeconds ? `${Math.round(v)} s` : `${Math.round(v * 100) / 100} min`;
    root.append(svg("text", { x: x(v * unit), y: H - B + 16, class: "tick", "text-anchor": v === 0 ? "start" : "middle" }, label));
  }
  root.append(svg("text", { x: (L + W - R) / 2, y: H - 2, class: "axis", "text-anchor": "middle" }, "time spent writing (long pauses left out)"));
  const stride = Math.max(1, Math.ceil(a.timeline.length / 4000));
  let d = "";
  a.timeline.forEach((p, i) => {
    if (i % stride && p[2] === ORIGIN.KEY && i !== a.timeline.length - 1) return;
    d += `${d ? "L" : "M"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`;
  });
  firstIndex.slice(1).forEach((idx, k) => {
    const px = x(a.timeline[idx + 1][0]);
    root.append(svg("line", { x1: px, x2: px, y1: T, y2: H - B, class: "sitting" }), svg("text", { x: px + 4, y: T + 10, class: "tick" }, `sitting ${k + 2}`));
  });
  root.append(svg("path", { d, class: "line" }));
  for (const ins of a.inserts) {
    if (ins.internal || (ins.origin !== ORIGIN.PASTE && ins.origin !== ORIGIN.DROP)) continue;
    const p = a.timeline[ins.index + 1];
    root.append(svg("circle", { cx: x(p[0]), cy: y(p[1]), r: 5, class: "paste-dot" }, svg("title", {}, `Pasted ${fmtInt(ins.length)} characters`)));
  }
  root.append(svg("line", { id: "playhead", x1: L, x2: L, y1: T, y2: H - B, class: "playhead" }));
  const pastes = a.externalPastes;
  root.setAttribute("aria-label", `Chart of text length over writing time. The text reached ${fmtInt(a.chars)} characters in about ${duration(a.activeMs)} of writing, with ${pastes} ${pastes === 1 ? "paste" : "pastes"} from outside the document.`);
  root.onclick = (e) => {
    const box = root.getBoundingClientRect();
    const ms = (((e.clientX - box.left) / box.width) * W - L) / (W - L - R) * maxMs;
    let lo = 0, hi = a.timeline.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a.timeline[mid][0] < ms) lo = mid + 1;
      else hi = mid;
    }
    if (player) {
      player.pause();
      player.seek(lo);
    }
  };
  return x;
}

// ---------- the report ----------

function tile(value, label) {
  return h("div", { class: "tile" }, h("b", {}, value), h("span", {}, label));
}

async function open(serialized, source) {
  errorBox.hidden = true;
  let replay, a;
  try {
    replay = parse(serialized);
    a = analyze(replay);
  } catch (e) {
    fail(e instanceof ReplayError ? `${e.message} If someone sent you this, ask them to export it again.` : "This file couldn't be opened as a writing replay.");
    return;
  }
  const [print, textHash] = await Promise.all([sha256Hex(serialized), sha256Hex(a.text)]);

  $("#r-title").textContent = replay.title || "Untitled piece";
  const first = a.sessions[0];
  const last = a.sessions[a.sessions.length - 1];
  const sameDay = fmtDate(first.firstMs) === fmtDate(last.lastMs);
  const when = sameDay ? `${fmtDateTime(first.firstMs)} to ${fmtTime(last.lastMs)}` : `${fmtDateTime(first.firstMs)} to ${fmtDateTime(last.lastMs)}`;
  $("#r-meta").replaceChildren(...[
    replay.author ? h("span", {}, `Name entered by the writer: ${replay.author}. `) : null,
    h("span", {}, `Recorded ${when}, by the clock on the writer's device.`),
  ].filter(Boolean));

  // Does the recording add up to the text it claims?
  const check = $("#r-check");
  if (!replay.final.sha256) {
    check.className = "check warn";
    check.textContent = "This file doesn't carry a fingerprint of its final text, so it can't be checked against itself. The replay below is still what the file contains.";
  } else if (replay.final.sha256 === textHash && replay.final.length === a.text.length) {
    check.className = "check ok";
    check.textContent = "The recording is complete: replaying its edits gives exactly the text the file says it ends with. That shows the file is whole, not who made it.";
  } else {
    check.className = "check bad";
    check.textContent = "This file was changed or damaged after it was exported: replaying its edits does not give the text the file says it ends with. Ask the writer for a fresh copy.";
  }
  document.body.dataset.check = check.className.split(" ")[1];

  $("#tiles").replaceChildren(
    tile(fmtInt(a.chars), `characters (${fmtInt(a.words)} ${a.words === 1 ? "word" : "words"})`),
    tile(`${share(a.keyboard, a.chars)}%`, "of the final text came from the keyboard"),
    tile(`${share(a.pasted, a.chars)}%`, `was pasted or dropped in (${a.externalPastes} ${a.externalPastes === 1 ? "paste" : "pastes"})`),
    tile(duration(a.activeMs), `of writing in ${a.sessions.length === 1 ? "one sitting" : `${a.sessions.length} sittings`}`),
  );
  const detail = [
    `Keyboard input: ${fmtInt(a.byOrigin[ORIGIN.KEY])} characters one key at a time, ${fmtInt(a.byOrigin[ORIGIN.CHUNK])} several at once (word suggestions, swipe typing, dictation, autocorrect, text expanders).`,
    `${fmtInt(a.produced)} characters were entered in all and ${fmtInt(a.deleted)} deleted, in ${fmtInt(a.events)} edits.`,
    a.rhythm.n >= 20 ? `Typical gap between keystrokes while typing: ${Math.round(a.rhythm.medianMs)} ms. Pauses: ${a.pauses.over2s} longer than 2 seconds, ${a.pauses.over10s} longer than 10, ${a.pauses.over60s} longer than a minute.` : null,
    a.unexplained ? `${fmtInt(a.unexplained)} characters of the final text arrived some other way (see below).` : null,
  ];
  $("#numbers").replaceChildren(...detail.filter(Boolean).map((t) => h("li", {}, t)));

  $("#observations").replaceChildren(...observations(a).map((o) => h("li", { class: o.kind, "data-id": o.id }, o.text)));

  // Each sitting's first edit, as an index into the flat list of edits.
  const firstIndex = [];
  let count = 0;
  for (const s of a.sessions) {
    firstIndex.push(count);
    count += s.events;
  }
  $("#sittings").replaceChildren(...a.sessions.map((s, i) => h("tr", {},
    h("td", {}, String(i + 1)),
    h("td", {}, fmtDateTime(s.firstMs)),
    h("td", {}, duration(s.activeMs)),
    h("td", {}, fmtInt(s.events)),
    h("td", {}, `${fmtInt(s.lengthBefore)} → ${fmtInt(s.lengthAfter)}`))));

  player = new Player(replay, a);
  player.xOf = drawChart(a, firstIndex);
  player.render();

  $("#final").replaceChildren(runs(a.text, a.orig));

  const listed = a.inserts.filter((x) => !x.internal);
  const moved = a.inserts.length - listed.length;
  $("#inserts-none").hidden = listed.length > 0;
  $("#inserts-wrap").hidden = listed.length === 0;
  $("#inserts").replaceChildren(...listed.map((x) => h("tr", {},
    h("td", {}, clock(x.activeMs)),
    h("td", {}, x.origin === ORIGIN.CHUNK ? "keyboard, all at once" : ORIGIN_LABEL[x.origin]),
    h("td", {}, fmtInt(x.length)),
    h("td", { class: "preview" }, x.preview + (x.length > codePoints(x.preview) ? "…" : "")),
    h("td", {}, h("button", { type: "button", class: "btn small secondary", onclick: () => {
      player.pause();
      player.seek(x.index + 1);
      $("#player").scrollIntoView({ behavior: "smooth", block: "start" });
    } }, "Show")))));
  $("#moved").textContent = moved
    ? `${moved} more ${moved === 1 ? "paste or undo" : "pastes or undos"} put back text the writer had already entered in this document. Those keep their original marking and aren't counted as pasted in.`
    : "";

  $("#print").textContent = shortPrint(print);
  $("#print-full").textContent = print;
  $("#r-source").textContent = source;

  opener.hidden = true;
  report.hidden = false;
  document.body.dataset.state = "open";
  document.body.dataset.print = print;
  $("#r-title").focus();
  track("verify_open");
}

// ---------- ways in ----------

async function openFile(file) {
  if (!file) return;
  if (file.size > LIMITS.fileBytes) return fail("This file is too large to be a writing replay.");
  await open(await file.text(), `file “${file.name}”`);
}

async function fromLocation() {
  const hash = location.hash;
  const params = new URLSearchParams(location.search);
  if (hash.startsWith("#r=")) {
    if (!canCompress()) return fail("This browser is too old to open replay links. Ask the writer for the replay file, or use a current browser.");
    try {
      await open(await decodeLink(hash.slice(3)), "link");
    } catch (e) {
      fail(e instanceof ReplayError ? e.message : "This link couldn't be opened.");
    }
  } else if (params.has("preview")) {
    let text = null;
    try {
      text = localStorage.getItem(PREVIEW_KEY);
    } catch { /* storage unavailable */ }
    if (text) await open(text, "your draft (preview)");
    else fail("There is no draft to preview in this browser. Open the editor and choose “See what a reader sees”.");
  } else if (params.has("sample")) {
    let sample = null;
    try {
      sample = (await import("./sample-replay.js")).default;
    } catch {
      fail("The sample replay couldn't be loaded. Try again in a moment.");
    }
    if (sample) await open(sample, "the sample on this site");
  }
}

$("#file").addEventListener("change", (e) => {
  openFile(e.target.files[0]);
  e.target.value = "";
});
const zone = $("#drop");
for (const name of ["dragenter", "dragover"]) {
  zone.addEventListener(name, (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
}
for (const name of ["dragleave", "drop"]) zone.addEventListener(name, () => zone.classList.remove("over"));
zone.addEventListener("drop", (e) => {
  e.preventDefault();
  openFile(e.dataTransfer.files[0]);
});
$("#another").addEventListener("click", () => {
  if (player) player.pause();
  report.hidden = true;
  opener.hidden = false;
  history.replaceState(null, "", location.pathname);
  document.body.dataset.state = "empty";
  $("#opener h1").focus();
});
window.addEventListener("hashchange", fromLocation);

document.body.dataset.state = "empty";
fromLocation().finally(() => {
  document.body.dataset.ready = "1";
});
