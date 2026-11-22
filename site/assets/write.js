// The editor page. The draft and its recording live in this browser's storage and nowhere else;
// the only way they leave is the file or link the writer chooses to make.
import {
  FORMAT, VERSION, TICK_MS, ORIGIN, LIMITS, THRESHOLDS, ReplayError, parse, serialize, buildReplay, replayAll, createDoc, applyEvent,
  analyze, sha256Hex, encodeLink, canCompress, wordCount, share, duration, fileName,
} from "./core.js";
import { Recorder } from "./recorder.js";
import { CFG, $, h, track, download, copyText, shortPrint, fmtDateTime, fmtInt } from "./common.js";

const DRAFT_KEY = "writing-replay.draft.v1";
const PREVIEW_KEY = "writing-replay.preview";
const VERIFY_URL = `${CFG.siteUrl}/verify/`;

const gate = $("#gate");
const editor = $("#editor");
const exportPanel = $("#export");
const area = $("#text");
const titleInput = $("#title");
const notice = $("#notice");

let past = []; // sittings before this page load: [{ start, events }]
let recorder = null;
let doc = createDoc(); // the text and where each character came from, kept in step with the recording
let activeMs = 0;
let lastEventAt = 0;
let saveTimer = 0;
let statTimer = 0;
let storageOk = true;
let told = {};
let exported = null; // { serialized, name, link }

// ---------- storage ----------

function readDraft() {
  let raw = null;
  try {
    raw = localStorage.getItem(DRAFT_KEY);
  } catch {
    storageOk = false;
  }
  if (!raw) return null;
  try {
    const replay = parse(raw);
    const text = replayAll(replay).text;
    return { replay, text, saved: replay.exported ? Date.parse(replay.exported) : 0 };
  } catch {
    // Keep a damaged draft out of the way instead of deleting it.
    try {
      localStorage.setItem(DRAFT_KEY + ".damaged", raw);
      localStorage.removeItem(DRAFT_KEY);
    } catch { /* nothing more to do */ }
    return null;
  }
}

function sessions() {
  return recorder ? [...past, { start: recorder.log.start, events: recorder.log.events }] : past;
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const all = sessions().filter((s) => s.events.length);
  if (!all.length) return;
  const text = serialize({ title: titleInput.value, author: $("#author").value, exported: new Date().toISOString(), tick_ms: TICK_MS, sessions: all });
  try {
    localStorage.setItem(DRAFT_KEY, text);
    $("#stat-saved").textContent = "Saved in this browser";
  } catch {
    storageOk = false;
    $("#stat-saved").textContent = "Not saved";
    say("storage", "This browser can't save the draft (storage is full or switched off). Keep this tab open, and download your replay before you close it.");
  }
}

const saveSoon = () => {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 800);
};

function say(id, text) {
  if (told[id]) return;
  told[id] = true;
  notice.textContent = text;
  notice.hidden = false;
}

// ---------- the editor ----------

function show(section) {
  for (const s of [gate, editor, exportPanel]) s.hidden = s !== section;
  window.scrollTo(0, 0);
}

function updateStats() {
  statTimer = 0;
  const words = wordCount(area.value);
  $("#stat-words").textContent = `${fmtInt(words)} ${words === 1 ? "word" : "words"}`;
  $("#stat-time").textContent = activeMs < 60_000 ? "under a minute of writing" : `${duration(activeMs)} of writing`;
}

function onEvent(ev) {
  const now = performance.now();
  if (lastEventAt && now - lastEventAt <= THRESHOLDS.idleMs) activeMs += now - lastEventAt;
  lastEventAt = now;
  const { internal } = applyEvent(doc, ev);
  const origin = ev[4];
  if (ev[3] && !internal && (origin === ORIGIN.PASTE || origin === ORIGIN.DROP)) {
    say("paste", "That text is marked as pasted in your replay, and readers can see what it was. Pasting quotes, references and your own notes is normal.");
  } else if (ev[3] && origin === ORIGIN.OTHER) {
    say("other", "Something other than your keyboard just changed the text (a browser extension, for example). The replay marks those characters as not typed.");
  }
  if (sessions().reduce((n, s) => n + s.events.length, 0) > LIMITS.events * 0.9) {
    say("limit", "This recording is close to the largest size a replay can be. Download it and start a new piece.");
  }
  saveSoon();
  if (!statTimer) statTimer = setTimeout(updateStats, 300);
}

function openEditor(draft) {
  past = draft ? draft.replay.sessions : [];
  doc = createDoc();
  activeMs = 0;
  for (const s of past) {
    let first = true;
    for (const ev of s.events) {
      if (!first && ev[0] * TICK_MS <= THRESHOLDS.idleMs) activeMs += ev[0] * TICK_MS;
      first = false;
      applyEvent(doc, ev);
    }
  }
  lastEventAt = 0;
  told = {};
  notice.hidden = true;
  area.value = doc.text;
  titleInput.value = draft ? draft.replay.title : "";
  $("#author").value = draft ? draft.replay.author : "";
  if (recorder) recorder.stop();
  recorder = new Recorder(area, { text: doc.text, onEvent });
  area.disabled = false;
  $("#stat-saved").textContent = draft ? "Saved in this browser" : "";
  updateStats();
  show(editor);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  if (!storageOk) say("storage", "This browser can't save drafts (private mode, or storage is switched off). Keep this tab open, and download your replay before you close it.");
  track(draft ? "write_resume" : "write_start");
}

// ---------- the gate ----------

function showGate() {
  const draft = readDraft();
  const resume = $("#resume");
  resume.hidden = !draft;
  $("#start").hidden = Boolean(draft);
  if (draft) {
    const words = wordCount(draft.text);
    $("#resume-what").textContent = `${draft.replay.title ? `“${draft.replay.title}”, ` : ""}${fmtInt(words)} ${words === 1 ? "word" : "words"}${draft.saved ? `, last saved ${fmtDateTime(draft.saved)}` : ""}.`;
    $("#continue").onclick = () => openEditor(readDraft());
  }
  $("#discard-ask").hidden = false;
  $("#discard-confirm").hidden = true;
  show(gate);
}

function discardDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(PREVIEW_KEY);
  } catch { /* storage unavailable: nothing was saved anyway */ }
  if (recorder) recorder.stop();
  recorder = null;
  past = [];
}

async function continueFromFile(file) {
  const msg = $("#file-msg");
  msg.textContent = "";
  try {
    if (file.size > LIMITS.fileBytes) throw new ReplayError("This file is too large to be a writing replay.");
    const replay = parse(await file.text());
    const text = replayAll(replay).text;
    if (readDraft() && !$("#file-replace").checked) {
      $("#file-replace-row").hidden = false;
      msg.textContent = "There is already a draft in this browser. Tick the box to replace it with this file, then choose the file again.";
      return;
    }
    discardDraft();
    openEditor({ replay, text, saved: 0 });
    saveNow();
  } catch (e) {
    msg.textContent = e instanceof ReplayError ? e.message : "This file couldn't be opened as a writing replay.";
  }
}

// ---------- export ----------

async function rebuildExport() {
  const title = titleInput.value;
  const author = $("#author").value;
  const replay = await buildReplay({ title, author, sessions: sessions(), app: `${CFG.siteUrl}/`, verifyUrl: VERIFY_URL, exported: exported ? exported.when : undefined });
  const serialized = serialize(replay);
  const a = analyze(parse(serialized));
  const print = await sha256Hex(serialized);
  const name = fileName(title, replay.exported);
  let link = "";
  if (canCompress()) {
    const url = `${VERIFY_URL}#r=${await encodeLink(serialized)}`;
    if (url.length <= LIMITS.linkChars) link = url;
  }
  exported = { serialized, name, link, when: replay.exported, print };

  const keyboard = share(a.keyboard, a.chars);
  const pasted = share(a.pasted, a.chars);
  const other = share(a.unexplained, a.chars);
  $("#export-summary").replaceChildren(
    h("p", {}, `${fmtInt(a.chars)} characters, ${fmtInt(a.words)} ${a.words === 1 ? "word" : "words"}, about ${duration(a.activeMs)} of writing in ${a.sessions.length === 1 ? "one sitting" : `${a.sessions.length} sittings`}.`),
    h("ul", { class: "mix" },
      h("li", {}, h("b", {}, `${keyboard}%`), " from the keyboard"),
      h("li", {}, h("b", {}, `${pasted}%`), " pasted or dropped in"),
      other ? h("li", {}, h("b", {}, `${other}%`), " changed some other way") : null),
  );
  $("#print").textContent = shortPrint(print);
  $("#print-full").textContent = print;
  $("#file-name").textContent = name;

  const linkBox = $("#link-box");
  const badgeBox = $("#badge-box");
  linkBox.hidden = !link;
  $("#link-none").hidden = Boolean(link);
  badgeBox.hidden = !link;
  if (link) {
    $("#link").value = link;
    const alt = "Writing replay: watch how this was typed";
    $("#badge-html").value = `<a href="${link}"><img src="${CFG.siteUrl}/assets/badge.svg" alt="${alt}" width="188" height="28"></a>`;
    $("#badge-md").value = `[![${alt}](${CFG.siteUrl}/assets/badge.svg)](${link})`;
  } else {
    $("#link-none").textContent = canCompress()
      ? "This piece is too long to fit in a link that chat and mail apps will keep whole. Send the file instead."
      : "This browser can't make replay links. Send the file instead.";
  }
  const what = title.trim() ? `“${title.trim()}”` : "this piece";
  $("#note").value = link
    ? `I wrote ${what} in Writing Replay, which recorded how it was typed. Watch the replay here:\n${link}\n\nReplay fingerprint: ${shortPrint(print)}`
    : `I wrote ${what} in Writing Replay, which recorded how it was typed. To watch the replay, open ${VERIFY_URL} and choose the attached file (${name}).\n\nReplay fingerprint: ${shortPrint(print)}`;
}

async function openExport() {
  recorder.sync();
  if (!sessions().some((s) => s.events.length)) {
    notice.textContent = "There's nothing to export yet. Write something first.";
    notice.hidden = false;
    return;
  }
  saveNow();
  exported = null;
  await rebuildExport();
  show(exportPanel);
  $("#export h1").focus();
  track("export_open");
}

// ---------- wiring ----------

$("#start").addEventListener("click", () => openEditor(null));
$("#discard-ask").addEventListener("click", () => {
  $("#discard-ask").hidden = true;
  $("#discard-confirm").hidden = false;
});
$("#discard-no").addEventListener("click", showGate);
$("#discard-yes").addEventListener("click", () => {
  discardDraft();
  openEditor(null);
});
$("#file").addEventListener("change", (e) => {
  if (e.target.files[0]) continueFromFile(e.target.files[0]);
  e.target.value = "";
});
titleInput.addEventListener("input", saveSoon);
$("#finish").addEventListener("click", openExport);
$("#leave").addEventListener("click", () => {
  if (recorder) {
    recorder.sync();
    saveNow();
    recorder.stop();
    recorder = null;
  }
  showGate();
});

let rebuildTimer = 0;
$("#author").addEventListener("input", () => {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    saveNow();
    rebuildExport();
  }, 400);
});
$("#download").addEventListener("click", () => {
  download(exported.name, exported.serialized);
  track("export_file");
});
$("#preview").addEventListener("click", () => {
  try {
    localStorage.setItem(PREVIEW_KEY, exported.serialized);
  } catch { /* the reader page will say there's nothing to preview */ }
  window.open(`${CFG.root}verify/?preview=1`, "_blank", "noopener");
  track("export_preview");
});
$("#copy-link").addEventListener("click", (e) => {
  copyText(exported.link, e.currentTarget, $("#link"));
  track("export_link");
});
$("#copy-note").addEventListener("click", (e) => copyText($("#note").value, e.currentTarget, $("#note")));
$("#copy-badge-html").addEventListener("click", (e) => copyText($("#badge-html").value, e.currentTarget, $("#badge-html")));
$("#copy-badge-md").addEventListener("click", (e) => copyText($("#badge-md").value, e.currentTarget, $("#badge-md")));
$("#back").addEventListener("click", () => {
  show(editor);
  area.focus();
});

// Save before the tab goes away. No "are you sure" prompt is needed: nothing is lost.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && recorder) {
    recorder.sync();
    saveNow();
  }
});
window.addEventListener("pagehide", () => {
  if (recorder) {
    recorder.sync();
    saveNow();
  }
});

// The same draft open in two tabs would fork the recording. The tab that didn't save stops.
window.addEventListener("storage", (e) => {
  if (e.key === DRAFT_KEY && recorder) {
    recorder.stop();
    recorder = null;
    area.disabled = true;
    notice.textContent = "This draft was changed in another tab. To keep one recording, this tab has stopped. Reload it to continue here.";
    notice.hidden = false;
  }
});

showGate();
document.body.dataset.ready = "1";

// Exposed for the automated end-to-end test, which checks the page against its own recording.
window.__writingReplay = { format: FORMAT, version: VERSION, sessions, exported: () => exported };
