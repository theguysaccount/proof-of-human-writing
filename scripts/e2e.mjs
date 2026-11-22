// End-to-end test of the real pages in headless Chrome, with trusted keyboard input.
//   node scripts/e2e.mjs                 # serve dist/ locally and test it
//   node scripts/e2e.mjs https://host/x/ # test a live site
//   node scripts/e2e.mjs --screens [url] # also save screenshots to docs/screens/
// Writes a draft (typing, a typo fixed, a paste, undo and redo), exports it, reopens the draft, then
// checks the reader against the exported file: by link, by file, a tampered file, the sample and a
// damaged link. Fails on any console error, any request to another site, or a page wider than a phone.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serve, sleep } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const screens = args.includes("--screens");
let base = args.find((a) => !a.startsWith("--"));
let server = null;
if (!base) {
  server = await serve(path.join(ROOT, "dist"));
  base = server.url;
}
if (!base.endsWith("/")) base += "/";
const origin = new URL(base).origin;
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const shot = (page, name, opts) => (screens ? page.screenshot(path.join(ROOT, "docs", "screens", `${name}.png`), opts) : null);
const log = (...m) => console.log(...m);

let seed = 7;
const jitter = () => {
  seed = (seed * 48271) % 2147483647;
  return 25 + (seed % 90);
};

const PASTE = "“A quoted line, pasted from somewhere else.”";
const browser = await launch();
const failures = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    log(`FAIL ${name}: ${e.stack || e.message}`);
  }
}

const page = await browser.newPage();
await page.viewport(1280, 900);
let exported = null;
let expected = "";

await step("home page explains the promise and links to both tools", async () => {
  await page.goto(base, { wait: "main" });
  const t = await page.eval("document.querySelector('h1').textContent + '|' + [...document.querySelectorAll('a')].map(a => a.getAttribute('href')).join(' ')");
  assert.match(t, /^Show how you wrote it/);
  assert.match(t, /write\//);
  assert.match(t, /verify\//);
  await shot(page, "home-desktop", { fullPage: true });
});

await step("write: typing, a corrected typo, a paste, undo and redo are recorded as they happened", async () => {
  await page.goto(base + "write/");
  await page.eval("localStorage.clear()");
  await page.goto(base + "write/");
  await page.waitFor("!document.querySelector('#gate').hidden", "the gate");
  await page.click("#start");
  await page.waitFor("!document.querySelector('#editor').hidden", "the editor");
  await page.focus("#title");
  await page.insertText("A test of the editor");
  await page.focus("#text");
  await page.type("Teh", jitter);
  await page.backspace(2, 60);
  await page.type("he first line was typed here.\n", jitter);
  await sleep(600);
  await page.paste(PASTE);
  await sleep(300);
  await page.command("undo", "z", 90);
  await sleep(200);
  await page.command("redo", "y", 89);
  await sleep(300);
  await page.type(" Then more typing.", jitter);
  expected = "The first line was typed here.\n" + PASTE + " Then more typing.";
  assert.equal(await page.eval("document.querySelector('#text').value"), expected);
  await page.waitFor("!document.querySelector('#notice').hidden", "the paste notice");
  await shot(page, "editor-desktop");
});

await step("export: the file, fingerprint and link match the draft", async () => {
  await page.click("#finish");
  await page.waitFor("!document.querySelector('#export').hidden && window.__writingReplay.exported()", "the export panel");
  exported = await page.eval("window.__writingReplay.exported()");
  const shownPrint = await page.eval("document.querySelector('#print-full').textContent");
  assert.equal(shownPrint, sha256(exported.serialized), "fingerprint shown = SHA-256 of the file");
  const file = JSON.parse(exported.serialized);
  assert.equal(file.format, "writing-replay");
  assert.equal(file.title, "A test of the editor");
  assert.equal(file.sessions.length, 1);
  assert.ok(file.how_to_open.includes("/verify/"));
  const events = file.sessions[0].events;
  assert.ok(events.filter((e) => e[4] === 2).length === 1, "exactly one paste event");
  assert.ok(events.some((e) => e[4] === 4), "undo and redo recorded as history");
  assert.ok(events.filter((e) => !e[4]).length > 40, "keys recorded one at a time");
  const siteUrl = await page.eval("JSON.parse(document.getElementById('site-config').textContent).siteUrl");
  assert.ok(exported.link.startsWith(siteUrl + "/verify/#r="), "a link is offered for a short piece");
  const summary = await page.eval("document.querySelector('#export-summary').textContent");
  assert.match(summary, /from the keyboard/);
  assert.match(summary, /pasted or dropped in/);
  assert.ok(exported.name.endsWith(".writing-replay.json"));
  await shot(page, "export-desktop", { fullPage: true });
});

await step("draft: survives a reload and a second sitting is added to the same recording", async () => {
  await page.goto(base + "write/");
  await page.waitFor("!document.querySelector('#resume').hidden", "the resume card");
  assert.match(await page.eval("document.querySelector('#resume-what').textContent"), /A test of the editor/);
  await page.click("#continue");
  await page.waitFor("!document.querySelector('#editor').hidden", "the editor");
  assert.equal(await page.eval("document.querySelector('#text').value"), expected);
  await page.eval("(() => { const t = document.querySelector('#text'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()");
  await page.type(" Day two.", jitter);
  expected += " Day two.";
  await page.click("#finish");
  await page.waitFor("!document.querySelector('#export').hidden", "the export panel");
  exported = await page.eval("window.__writingReplay.exported()");
  assert.equal(JSON.parse(exported.serialized).sessions.length, 2);
});

async function checkReport(source) {
  await page.waitFor("document.body.dataset.state === 'open'", "the report");
  assert.equal(await page.eval("document.body.dataset.check"), "ok", "completeness check passes");
  assert.equal(await page.eval("document.body.dataset.print"), sha256(exported.serialized), "same fingerprint as the writer saw");
  assert.equal(await page.eval("document.querySelector('#final').textContent"), expected, "finished text shown in full");
  assert.equal(await page.eval("document.querySelector('#final .o2')?.textContent"), PASTE, "the paste is marked, and only the paste");
  const rows = await page.eval("[...document.querySelectorAll('#inserts tr')].map(r => r.textContent)");
  assert.equal(rows.length, 1);
  assert.match(rows[0], /pasted/);
  assert.match(await page.eval("document.querySelector('#r-source').textContent"), source);
  assert.match(await page.eval("document.querySelector('#report .limits').textContent"), /not proof of authorship/);
  assert.ok(await page.eval("document.querySelectorAll('#observations li').length") >= 1);
  assert.ok(await page.eval("document.querySelector('#chart path.line').getAttribute('d').length") > 20);
  // The player: the start is empty, the end is the finished text.
  await page.eval("(() => { const s = document.querySelector('#seek'); s.value = '0'; s.dispatchEvent(new Event('input')); })()");
  assert.equal(await page.eval("document.querySelector('#screen').textContent"), "");
  await page.click("#to-end");
  assert.equal(await page.eval("document.querySelector('#screen').textContent"), expected);
  await page.click("#play");
  await page.waitFor("document.querySelector('#screen').dataset.edits !== document.querySelector('#seek').max", "playback to start");
}

await step("reader: opening the link shows the same text, fingerprint and paste", async () => {
  await page.goto(base + "verify/" + exported.link.slice(exported.link.indexOf("#")));
  await checkReport(/link/);
  await shot(page, "replay-desktop", { fullPage: true });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "replay-e2e-"));
await step("reader: opening the downloaded file works the same way", async () => {
  const file = path.join(tmp, exported.name);
  fs.writeFileSync(file, exported.serialized);
  await page.goto(base + "verify/");
  await page.setFile("#file", file);
  await checkReport(/file/);
});

await step("reader: a file edited after export is caught", async () => {
  const file = path.join(tmp, "edited.writing-replay.json");
  fs.writeFileSync(file, exported.serialized.replace('"T"]', '"Z"]'));
  assert.notEqual(fs.readFileSync(file, "utf8"), exported.serialized);
  await page.goto(base + "verify/");
  await page.setFile("#file", file);
  await page.waitFor("document.body.dataset.state === 'open'", "the report");
  assert.equal(await page.eval("document.body.dataset.check"), "bad");
});

await step("reader: a file that isn't a replay is refused with a reason", async () => {
  const file = path.join(tmp, "notes.json");
  fs.writeFileSync(file, JSON.stringify({ hello: "world" }));
  await page.goto(base + "verify/");
  await page.setFile("#file", file);
  await page.waitFor("document.body.dataset.state === 'error'", "the error");
  assert.match(await page.eval("document.querySelector('#error').textContent"), /isn't a writing replay/);
});

await step("reader: a damaged link says so", async () => {
  await page.goto(base + "verify/#r=AAAAbroken");
  await page.waitFor("document.body.dataset.state === 'error'", "the error");
  assert.match(await page.eval("document.querySelector('#error').textContent"), /damaged/);
});

await step("reader: the sample opens and says it was typed by a script", async () => {
  await page.goto(base + "verify/?sample=1");
  await page.waitFor("document.body.dataset.state === 'open'", "the sample");
  assert.equal(await page.eval("document.body.dataset.check"), "ok");
  assert.match(await page.eval("document.querySelector('#final').textContent"), /typed by a script/);
});

await step("every page: no console errors and no requests to other sites", async () => {
  // The sitemap lists canonical URLs; robots.txt says which site they belong to.
  const robots = await (await fetch(base + "robots.txt")).text();
  const site = robots.match(/Sitemap: (\S+)\/sitemap\.xml/)[1];
  const sitemap = await (await fetch(base + "sitemap.xml")).text();
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(urls.length >= 5, "sitemap lists the pages");
  for (const u of urls) {
    assert.ok(u.startsWith(site + "/"), `${u} is under ${site}`);
    await page.goto(base + u.slice(site.length + 1), { wait: "main" });
    const canonical = await page.eval("document.querySelector('link[rel=canonical]').href");
    assert.equal(canonical, u, "each page names itself as canonical");
  }
  const foreign = page.requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:"));
  assert.deepEqual(foreign, [], "requests to other sites");
  assert.deepEqual(page.errors, [], "console errors");
  await page.goto(base + "nope-" + Date.now() + "/", { wait: "main" });
  assert.match(await page.eval("document.title"), /not found/i);
});

await step("phone width: no page scrolls sideways", async () => {
  const phone = await browser.newPage();
  await phone.viewport(390, 844, true);
  const wide = [];
  const targets = ["", "write/", "verify/", "verify/?sample=1", "about/", "format/", "guides/", "guides/reading-a-replay/"];
  for (const t of targets) {
    await phone.goto(base + t, { wait: "main" });
    if (t === "write/") {
      await phone.waitFor("document.body.dataset.ready");
      await phone.eval("localStorage.clear()");
      await phone.goto(base + t);
      await phone.click("#start");
      await phone.waitFor("!document.querySelector('#editor').hidden", "the editor");
      await phone.focus("#text");
      await phone.type("Typed on a phone.", 20);
    }
    if (t === "verify/?sample=1") await phone.waitFor("document.body.dataset.state === 'open'", "the sample");
    await sleep(200);
    const w = await phone.eval("document.documentElement.scrollWidth");
    if (w > 391) wide.push(`${t || "home"}: ${w}px`);
    if (screens && ["", "write/", "verify/?sample=1"].includes(t)) {
      await phone.screenshot(path.join(ROOT, "docs", "screens", `${{ "": "home", "write/": "editor", "verify/?sample=1": "replay" }[t]}-phone.png`), { fullPage: t !== "write/" });
    }
  }
  assert.deepEqual(wide, []);
  assert.deepEqual(phone.errors, []);
});

fs.rmSync(tmp, { recursive: true, force: true });
await browser.close();
if (server) await server.close();
if (failures.length) {
  log(`\n${failures.length} failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
log(`\nall end-to-end checks passed on ${base}`);
