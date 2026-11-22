// Unit tests for the replay format, recording and analysis. Run: node --test tests/js/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  FORMAT, VERSION, TICK_MS, ORIGIN, LIMITS, THRESHOLDS, ReplayError, SessionLog,
  diff, isSingleGrapheme, codePoints, wordCount, classify, createDoc, applyEvent, replayAll,
  sha256Hex, toBase64Url, fromBase64Url, encodeLink, decodeLink, serialize, parse, buildReplay,
  analyze, observations, share, duration, fileName,
} from "../../site/assets/core.js";
import { Writer } from "../../scripts/writer.mjs";

const replayOf = (...logs) => ({ format: FORMAT, version: VERSION, tick_ms: TICK_MS, sessions: logs.map((l) => ({ start: l.start, events: l.events })) });

test("diff finds the single edit between two texts", () => {
  assert.equal(diff("same", "same"), null);
  assert.deepEqual(diff("", "a"), { pos: 0, del: 0, ins: "a" });
  assert.deepEqual(diff("helo", "hello"), { pos: 3, del: 0, ins: "l" });
  assert.deepEqual(diff("hello world", "hello"), { pos: 5, del: 6, ins: "" });
  assert.deepEqual(diff("the cat sat", "the dog sat"), { pos: 4, del: 3, ins: "dog" });
  assert.deepEqual(diff("abc", ""), { pos: 0, del: 3, ins: "" });
});

test("diff pins an ambiguous edit to the caret", () => {
  // Typing "a" after the first "a" of "aaa": without the caret this would land at the end.
  assert.deepEqual(diff("aaa", "aaaa"), { pos: 3, del: 0, ins: "a" });
  assert.deepEqual(diff("aaa", "aaaa", 2), { pos: 1, del: 0, ins: "a" });
  // Forward delete keeps the caret where it was.
  assert.deepEqual(diff("abcd", "abd", 2), { pos: 2, del: 1, ins: "" });
  // A caret that doesn't explain the change falls back to the plain diff.
  assert.deepEqual(diff("hello", "help", 1), { pos: 3, del: 2, ins: "p" });
});

test("diff never splits an emoji in half", () => {
  const d = diff("a\u{1F600}b", "a\u{1F601}b");
  assert.deepEqual(d, { pos: 1, del: 2, ins: "\u{1F601}" });
  const e = diff("a\u{1F600}b", "a\u{1F601}b", 3);
  assert.deepEqual(e, { pos: 1, del: 2, ins: "\u{1F601}" });
});

test("graphemes, code points and words are counted the way a reader would", () => {
  assert.equal(isSingleGrapheme(""), true);
  assert.equal(isSingleGrapheme("a"), true);
  assert.equal(isSingleGrapheme("\u{1F600}"), true);
  assert.equal(isSingleGrapheme("é"), true);
  assert.equal(isSingleGrapheme("ab"), false);
  assert.equal(codePoints("a\u{1F600}b"), 3);
  assert.equal(wordCount("  one two\nthree  "), 3);
  assert.equal(wordCount("   "), 0);
});

test("classify reads the browser's own report of each change", () => {
  assert.equal(classify("insertText", true, "a"), ORIGIN.KEY);
  assert.equal(classify("insertLineBreak", true, "\n"), ORIGIN.KEY);
  assert.equal(classify("insertCompositionText", true, "か"), ORIGIN.KEY);
  assert.equal(classify("deleteContentBackward", true, ""), ORIGIN.KEY);
  assert.equal(classify("insertText", true, "whole word"), ORIGIN.CHUNK);
  assert.equal(classify("insertReplacementText", true, "their"), ORIGIN.CHUNK);
  assert.equal(classify("insertFromPaste", true, "x"), ORIGIN.PASTE);
  assert.equal(classify("insertFromDrop", true, "x"), ORIGIN.DROP);
  assert.equal(classify("historyUndo", true, "x"), ORIGIN.HISTORY);
  assert.equal(classify("insertText", false, "a"), ORIGIN.OTHER, "a script-made event is not a key press");
  assert.equal(classify("", true, "a"), ORIGIN.KEY);
  assert.equal(classify("", true, "a whole sentence"), ORIGIN.OTHER);
  assert.equal(classify("formatBold", true, "x"), ORIGIN.OTHER);
});

test("a typed, corrected and pasted piece replays to the same text with the right origins", () => {
  const w = new Writer();
  w.type("Teh").backspace(2).type("he quick fox.").wait(3000).paste(" [pasted quote]");
  const a = analyze(replayOf(w.log));
  assert.equal(a.text, "The quick fox. [pasted quote]");
  assert.equal(a.text, w.value);
  assert.equal(a.orig.length, a.text.length);
  assert.equal(a.orig, "0".repeat(14) + "2".repeat(15));
  assert.equal(a.pasted, 15);
  assert.equal(a.keyboard, 14);
  assert.equal(a.externalPastes, 1);
  assert.equal(a.largestPaste, 15);
  assert.equal(a.deleted, 2);
  assert.equal(a.produced, 3 + 13 + 15);
});

test("the writer's own text keeps its origin when it is cut, pasted, copied or undone", () => {
  const w = new Writer();
  w.type("alpha beta gamma");
  w.cut(0, 6); // "alpha "
  w.moveTo(w.value.length).type(" ").paste("alpha "); // moved to the end
  let a = analyze(replayOf(w.log));
  assert.equal(a.text, "beta gamma alpha ");
  assert.ok(!a.orig.includes("2"), "a cut pasted elsewhere is not outside text");
  assert.equal(a.externalPastes, 0);
  assert.equal(a.inserts.length, 1);
  assert.equal(a.inserts[0].internal, true);

  w.paste("gamma"); // copied from the document itself
  a = analyze(replayOf(w.log));
  assert.ok(!a.orig.includes("2"));

  w.paste("OUTSIDE");
  w.wait(300).edit(w.value.length - 7, 7, "", "historyUndo");
  w.wait(300).edit(w.value.length, 0, "OUTSIDE", "historyRedo");
  a = analyze(replayOf(w.log));
  assert.ok(a.text.endsWith("OUTSIDE"));
  assert.equal(a.orig.slice(-7), "2222222", "outside text stays outside text through undo and redo");
  assert.equal(a.pasted, 7);
});

test("copying pasted text again doesn't launder it", () => {
  const w = new Writer();
  w.type("mine ").paste("theirs theirs theirs");
  w.cut(5, 6).paste("theirs");
  const a = analyze(replayOf(w.log));
  assert.equal(a.keyboard, 5);
  assert.equal(a.pasted, a.chars - 5);
});

test("changes a script makes are never counted as typing", () => {
  const w = new Writer();
  w.type("typed ");
  w.wait(500).edit(6, 0, "injected by a script", "insertText", false);
  w.wait(500).edit(w.value.length, 0, " and silently", "", true);
  const a = analyze(replayOf(w.log));
  assert.equal(a.keyboard, 6);
  assert.equal(a.unexplained, a.chars - 6);
  assert.ok(observations(a).some((o) => o.id === "other" && o.kind === "note"));
});

test("random editing sessions always replay to the text that was on screen", () => {
  let seed = 20261110;
  const rnd = (n) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  const alphabet = ["a", "b", " ", "\n", "é", "\u{1F600}", "z", "a"];
  for (let round = 0; round < 40; round++) {
    const logs = [];
    let text = "";
    for (let s = 0; s < 1 + rnd(3); s++) {
      const w = new Writer(new SessionLog(text, new Date(Date.UTC(2026, 2, 1 + s)).toISOString()));
      for (let i = 0; i < 120; i++) {
        const k = rnd(10);
        const at = rnd(w.value.length + 1);
        // keep edits on code point boundaries, as a browser does
        const safe = (p) => (p > 0 && p < w.value.length && w.value.charCodeAt(p) >= 0xdc00 && w.value.charCodeAt(p) <= 0xdfff ? p - 1 : p);
        if (k < 5) w.type(alphabet[rnd(alphabet.length)], 50 + rnd(400));
        else if (k < 7 && w.value.length) w.moveTo(Math.max(1, safe(at))).backspace(1);
        else if (k === 7) w.moveTo(safe(at)).paste(["PASTE", "aa", "\u{1F600}\u{1F600}"][rnd(3)]);
        else if (k === 8 && w.value.length > 3) {
          const p = safe(rnd(w.value.length - 2));
          const q = safe(Math.min(w.value.length, p + 1 + rnd(4)));
          if (q > p) w.wait(200).edit(p, q - p, "", "deleteByCut");
        } else w.moveTo(safe(at));
      }
      logs.push(w.log);
      text = w.value;
    }
    const r = replayOf(...logs);
    const again = parse(serialize(r));
    const doc = replayAll(again);
    assert.equal(doc.text, text, `round ${round}`);
    assert.equal(doc.orig.length, text.length);
    assert.match(doc.orig, /^[0-5]*$/);
  }
});

test("a replay file round-trips byte for byte and its fingerprint is stable", async () => {
  const w = new Writer();
  w.type("Line one\nLine \"two\"   \u{1F600}").paste("\\ back\tslash");
  const built = await buildReplay({
    title: "  My essay  ", author: "", sessions: [{ start: w.log.start, events: [] }, w.log],
    app: "https://example.org/app/", verifyUrl: "https://example.org/app/verify/", exported: "2026-03-01T11:00:00.000Z",
  });
  assert.equal(built.sessions.length, 1, "a sitting with no edits is left out");
  assert.equal(built.title, "My essay");
  assert.equal(built.final.length, w.value.length);
  assert.equal(built.final.sha256, await sha256Hex(w.value));
  const file = serialize(built);
  assert.ok(file.endsWith("]\n}\n"));
  assert.ok(file.includes("https://example.org/app/verify/"), "the file says where to open it");
  const back = parse(file);
  assert.equal(serialize(back), file);
  assert.equal(await sha256Hex(serialize(back)), await sha256Hex(file));
  assert.equal(replayAll(back).text, w.value);
  assert.ok(!file.includes('"author"'), "an empty author is not written");
});

test("sha256 matches a published test vector", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await sha256Hex(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("a replay survives the trip through a link", async () => {
  const w = new Writer();
  w.type("A short piece, typed \u{1F600}.").paste(" And a pasted line.");
  const file = serialize(await buildReplay({ title: "Short", sessions: [w.log], app: "a", verifyUrl: "v", exported: "2026-03-01T11:00:00.000Z" }));
  const frag = await encodeLink(file);
  assert.match(frag, /^[A-Za-z0-9_-]+$/);
  assert.equal(await decodeLink(frag), file);
  await assert.rejects(decodeLink(frag.slice(0, 20)), ReplayError);
  await assert.rejects(decodeLink("not a link!"), ReplayError);
  await assert.rejects(decodeLink(toBase64Url(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))), ReplayError);
  assert.deepEqual([...fromBase64Url(toBase64Url(new Uint8Array([0, 255, 254, 62, 63])))], [0, 255, 254, 62, 63]);
});

test("damaged or foreign files are refused with a reason", () => {
  const good = { format: FORMAT, version: 1, tick_ms: 50, sessions: [{ start: "2026-03-01T10:00:00Z", events: [[0, 0, 0, "a"]] }] };
  const bad = (change, pattern) => {
    const o = JSON.parse(JSON.stringify(good));
    change(o);
    assert.throws(() => parse(JSON.stringify(o)), (e) => e instanceof ReplayError && pattern.test(e.message), JSON.stringify(o));
  };
  assert.equal(parse(JSON.stringify(good)).sessions[0].events[0][4], 0);
  assert.throws(() => parse(""), ReplayError);
  assert.throws(() => parse("{not json"), /isn't valid JSON/);
  assert.throws(() => parse("[]"), ReplayError);
  bad((o) => { o.format = "something-else"; }, /isn't a writing replay/);
  bad((o) => { o.version = 99; }, /newer version/);
  bad((o) => { o.version = "1"; }, /version/);
  bad((o) => { o.tick_ms = 0; }, /timing/);
  bad((o) => { o.sessions = []; }, /no writing sessions/);
  bad((o) => { o.sessions[0].start = "yesterday-ish"; }, /start time/);
  bad((o) => { o.sessions[0].events = [[0, 0, 0]]; }, /damaged/);
  bad((o) => { o.sessions[0].events = [[0, -1, 0, "a"]]; }, /damaged/);
  bad((o) => { o.sessions[0].events = [[0.5, 0, 0, "a"]]; }, /damaged/);
  bad((o) => { o.sessions[0].events = [[0, 0, 0, "a", 9]]; }, /damaged/);
  bad((o) => { o.sessions[0].events = [[0, 0, 0, 7]]; }, /damaged/);
  bad((o) => { o.sessions[0].events = [[0, 0, 0, ""]]; }, /damaged/);
  bad((o) => { o.sessions[0].events = []; }, /no edits/);
  // An edit that reaches past the end of the text is caught when the file is replayed.
  const reach = JSON.parse(JSON.stringify(good));
  reach.sessions[0].events.push([1, 5, 2, "x"]);
  assert.throws(() => analyze(parse(JSON.stringify(reach))), /doesn't fit/);
});

test("names in a file can't carry control characters or run on forever", () => {
  const r = parse(JSON.stringify({ format: FORMAT, version: 1, tick_ms: 50, title: "a\u0000b\n" + "x".repeat(500), author: 7,
    sessions: [{ start: "2026-03-01T10:00:00Z", events: [[0, 0, 0, "a"]] }] }));
  assert.equal(r.title.length, LIMITS.nameLength);
  assert.ok(!/[\u0000-\u001f]/.test(r.title));
  assert.equal(r.author, "");
});

test("writing time leaves out long pauses, and sittings are measured separately", () => {
  const one = new Writer(new SessionLog("", "2026-03-01T10:00:00.000Z"));
  one.wait(30_000).type("abc", 1000).wait(10 * 60_000).type("d", 1000).type("e", 3000);
  const two = new Writer(new SessionLog(one.value, "2026-03-02T09:00:00.000Z"));
  two.wait(5000).type("fg", 500);
  const a = analyze(replayOf(one.log, two.log));
  assert.equal(a.text, "abcdefg");
  // 1 s + 1 s between a-b-c, the 10 min 1 s gap is a pause, then 3 s, then 0.5 s in sitting two
  assert.equal(a.activeMs, 2000 + 3000 + 500);
  assert.equal(a.pauses.over60s, 1);
  assert.equal(a.pauses.over2s, 2);
  assert.equal(a.sessions.length, 2);
  assert.equal(a.sessions[0].firstMs, Date.parse("2026-03-01T10:00:31.000Z"));
  assert.equal(a.sessions[1].lengthBefore, 5);
  assert.equal(a.sessions[1].lengthAfter, 7);
  assert.equal(a.spanMs, Date.parse("2026-03-02T09:00:06.000Z") - Date.parse("2026-03-01T10:00:31.000Z"));
  assert.equal(a.timeline.length, a.events + 1);
});

test("timings are stored in whole ticks and never run backwards", () => {
  const log = new SessionLog("", "2026-03-01T10:00:00.000Z");
  log.change("a", 1, "insertText", true, 1234);
  log.change("ab", 2, "insertText", true, 1249);
  log.change("abc", 3, "insertText", true, 1100); // a clock that jumps back must not produce a negative gap
  assert.deepEqual(log.events.map((e) => e[0]), [25, 0, 0]);
  assert.equal(log.change("abc", 3, "insertText", true, 2000), null);
});

test("observations describe a hand-typed piece plainly", () => {
  const w = new Writer();
  const words = "It was the best of times, it was the worst of times. ".repeat(12);
  let i = 0;
  for (const ch of words) {
    w.type(ch, [90, 140, 260, 80, 420, 110, 1500, 70][i++ % 8]);
    if (i % 37 === 0) w.type("x").backspace(1);
    if (i % 150 === 0) w.wait(20_000);
  }
  const a = analyze(replayOf(w.log));
  const ids = observations(a).map((o) => o.id);
  assert.deepEqual(ids, ["no-paste", "revision", "ordinary"]);
  assert.ok(a.rhythm.cv > THRESHOLDS.evenCv);
  assert.ok(observations(a).every((o) => o.kind === "plain"));
});

test("observations flag a pasted essay, an even rhythm and a run with no pauses, without a verdict", () => {
  const pasted = new Writer();
  pasted.type("Intro. ").paste("P".repeat(2000));
  const p = observations(analyze(replayOf(pasted.log)));
  const paste = p.find((o) => o.id === "paste");
  assert.equal(paste.kind, "note");
  assert.match(paste.text, /99% of the final text arrived by paste/);
  assert.ok(!p.some((o) => o.id === "ordinary"));

  const robot = new Writer();
  robot.type("The quick brown fox jumps over the lazy dog. ".repeat(40), 100);
  const a = analyze(replayOf(robot.log));
  const ids = observations(a).map((o) => o.id);
  assert.ok(ids.includes("even"));
  assert.ok(ids.includes("no-revision"));
  assert.ok(ids.includes("no-pause"));
  assert.ok(a.rhythm.cv < 0.05);
  for (const o of observations(a)) assert.ok(!/cheat|fake|fraud|AI-generated|dishonest/i.test(o.text), o.text);
});

test("a large dictated or expanded insertion is listed but still counts as keyboard input", () => {
  const w = new Writer();
  w.type("Note: ").wait(500).edit(6, 0, "a sentence that arrived all at once from a text expander.", "insertText");
  const a = analyze(replayOf(w.log));
  assert.equal(a.pasted, 0);
  assert.equal(a.byOrigin[ORIGIN.CHUNK], 57);
  assert.ok(observations(a).some((o) => o.id === "chunks"));
});

test("shares never round a real amount to 0% or 100%", () => {
  assert.equal(share(0, 1000), 0);
  assert.equal(share(1, 100000), 1);
  assert.equal(share(99999, 100000), 99);
  assert.equal(share(500, 1000), 50);
  assert.equal(share(1000, 1000), 100);
  assert.equal(share(5, 0), 0);
});

test("durations and file names read naturally", () => {
  assert.equal(duration(45_000), "45 s");
  assert.equal(duration(12 * 60_000), "12 min");
  assert.equal(duration(65 * 60_000), "1 h 5 min");
  assert.equal(fileName("My Essay: Café & Me!", "2026-03-01T00:00:00Z"), "my-essay-cafe-me.writing-replay.json");
  assert.equal(fileName("", "2026-03-01T00:00:00Z"), "writing-2026-03-01.writing-replay.json");
  assert.equal(fileName("漢字", "2026-03-01T00:00:00Z"), "writing-2026-03-01.writing-replay.json");
});

test("applying an event to a fresh document works without analyze", () => {
  const doc = createDoc();
  applyEvent(doc, [0, 0, 0, "hi", ORIGIN.CHUNK]);
  assert.deepEqual([doc.text, doc.orig], ["hi", "11"]);
  assert.throws(() => applyEvent(doc, [0, 1, 5, "", 0]), ReplayError);
});

test("a cut sentence keeps its origin even after many single-character corrections", () => {
  const w = new Writer();
  w.type("Keep this sentence. Then more words follow here.");
  w.cut(0, 20); // "Keep this sentence. "
  w.moveTo(w.value.length);
  for (let i = 0; i < 150; i++) w.type("x").backspace(1);
  w.type(" ").paste("Keep this sentence. ");
  const a = analyze(replayOf(w.log));
  assert.equal(a.pasted, 0, "the writer's own cut text is not outside text");
  assert.equal(a.externalPastes, 0);
});
