# Writing Replay

**Show how you wrote it.** A free in-browser editor that records how a text is typed (each change, when it happened, and whether it was typed, pasted, dropped in or undone) and exports a replay file. Anyone can open the file in the site's reader to see the finished text, a chart of how it grew, every paste, and a playback at any speed. No accounts, no uploads: everything runs in the browser.

Live: https://theguysaccount.github.io/proof-of-human-writing/

A replay shows how a text was typed. It doesn't prove who typed it, and an auto-typing program could fake one. The site says so on every replay.

## What's here

- `site/assets/core.js`: the replay format, recording diff, analysis and observations. No DOM; the same file runs in the browser and in the Node tests.
- `site/assets/recorder.js`, `write.js`: the editor. `verify.js`: the reader. `common.js`: shared helpers.
- `site/pages/*.html`: page bodies with a JSON block on top (path, title, description, structured data).
- `pipeline/build.py`: wraps pages in the layout, writes the sitemap, robots.txt, IndexNow key, `build.json`. Standard library only.
- `scripts/e2e.mjs` + `scripts/cdp.mjs`: end-to-end test in headless Chrome with trusted keyboard input. `scripts/check_live.py`: live health and staleness check. `scripts/make_sample.mjs`: generates the sample replay. `scripts/og.py`: share cards.
- `docs/screens/`: screenshots at desktop and phone widths.

## Run, test, deploy

```bash
python3 pipeline/build.py                     # build into dist/ (Python 3.9+)
python3 -m http.server -d dist 8000           # then open http://127.0.0.1:8000/
node --test tests/js/*.test.mjs               # unit tests (Node 22+)
python3 -m unittest discover -s tests         # build tests
node scripts/e2e.mjs                          # end-to-end against dist/ (needs Chrome)
```

Deploys run from GitHub Actions on every push to `main` (`.github/workflows/pages.yml`). See [OPERATIONS.md](OPERATIONS.md) for the scheduled jobs, what to watch, and the keys (custom domain, money, analytics).

## The file format

Open and documented at [/format/](https://theguysaccount.github.io/proof-of-human-writing/format/). Plain JSON, one edit per line: `[dt, pos, del, ins, origin]`.

## License

MIT. See [LICENSE](LICENSE).
