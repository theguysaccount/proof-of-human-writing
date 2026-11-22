# State (2026-11-22)

- **Source material:** one line in Jack's Apple Notes (June 2025): a writing platform that only publishes work uploaded with a video of the author typing it. No code, design, domain or traction existed.
- **What works:** v1 is live on GitHub Pages. Editor records every edit with timing and the browser's own input type; drafts persist in browser storage across sittings; export to a `.writing-replay.json` file or a self-contained link; reader replays, checks completeness, marks pasted text, charts growth, lists pastes, plays back; sample replay; open format page; four guides with cited sources.
- **Tests:** 25+ JS unit tests (including randomized edit sessions), 7 Python build tests, a 12-step headless-Chrome end-to-end run with trusted input, run on every deploy and weekly against the live site.
- **Not built (by design):** video recording, accounts, hosted replays, publishing/social features, badges that claim verification.
- **Worth reusing elsewhere:** `scripts/cdp.mjs` (dependency-free DevTools client with trusted input, file inputs, clipboard paste), `core.js` diff-with-caret recorder.
- **Broken:** nothing known.
