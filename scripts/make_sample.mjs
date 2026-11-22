// Writes the site's sample replay: site/data/sample.writing-replay.json
//   node scripts/make_sample.mjs
// The sample is typed by this script, with uneven speeds, pauses, typos and a revision built in.
// Its own text says so: a recording that looks hand-typed and wasn't is the clearest way to show
// why a replay is evidence about process and not proof of authorship.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionLog, buildReplay, serialize, parse, analyze } from "../site/assets/core.js";
import { Writer } from "./writer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://theguysaccount.github.io/proof-of-human-writing";

let seed = 0x5eed1e55;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a, b) => a + rnd() * (b - a);
const NEAR = { a: "s", e: "r", i: "o", o: "p", t: "y", n: "m", s: "d", r: "t", h: "j", l: "k", d: "f", c: "v", u: "i", p: "o", g: "h" };

/** Type text the way a person might: bursts, hesitations, and the odd typo that gets fixed. */
function compose(w, text) {
  for (const ch of text) {
    let gap = between(70, 210) * (rnd() < 0.12 ? between(1.8, 4) : 1);
    const prev = w.value[w.caret - 1] || "";
    if (prev === " ") gap += between(0, 160);
    if (".!?".includes(prev)) gap += between(700, 2600);
    if (prev === ",") gap += between(100, 500);
    if (prev === "\n") gap += between(2500, 9000);
    if (NEAR[ch] && rnd() < 0.035) {
      w.type(NEAR[ch], gap);
      if (rnd() < 0.5) w.type(text[text.indexOf(ch) + 1] || "e", between(80, 160)).backspace(1, between(260, 520));
      w.backspace(1, between(180, 420));
      gap = between(120, 320);
    }
    w.type(ch, gap);
  }
}

const first = new Writer(new SessionLog("", "2026-11-09T19:02:11.000Z"));
first.wait(4200);
compose(first, "This sample was typed by a script, not a person.\n\n");
first.wait(6500);
compose(first, "We built it that way on purpose. The script was told to type at uneven speeds, to pause between sentences, to make typos and fix them, and to go back and change a word. On the chart and in the replay, it looks a lot like someone writing.\n\n");
first.wait(95_000); // a pause long enough to be left out of the writing time
compose(first, "That is the point of the warning at the top of this page. A replay shows how text was entered. It cannot show who, or what, entered it.");
// Second thoughts: go back and change "a lot" to "very much".
const at = first.value.indexOf("a lot like") + "a lot".length;
first.wait(7400).moveTo(at).backspace(5, 140);
compose(first, "very much");
first.moveTo(first.value.length);

const second = new Writer(new SessionLog(first.value, "2026-11-10T08:15:40.000Z"));
second.wait(9000);
compose(second, "\n\nOne more thing a replay shows clearly is pasting. The next line was pasted in, and the reader page marks it:\n\n");
second.wait(3100).paste("“Text that arrives by paste is recorded as a paste, and the pasted words are shown to the reader.”");
second.wait(5200);
compose(second, "\n\nEverything else here went in one key at a time.");

const replay = await buildReplay({
  title: "Sample: typed by a script",
  author: "",
  sessions: [first.log, second.log],
  app: `${SITE}/`,
  verifyUrl: `${SITE}/verify/`,
  exported: "2026-11-10T08:31:00.000Z",
});
const text = serialize(replay);
const a = analyze(parse(text));
const out = path.join(ROOT, "site", "data", "sample.writing-replay.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text);
console.log(`wrote ${path.relative(ROOT, out)}: ${a.events} edits, ${a.chars} characters, ${a.externalPastes} paste, ${Math.round(a.activeMs / 1000)} s of writing, rhythm variation ${a.rhythm.cv.toFixed(2)}`);
