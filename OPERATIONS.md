# Operations

Writing Replay is a static site on GitHub Pages with no server, no database and no accounts. The editor and the reader run in the visitor's browser; drafts live in the visitor's own browser storage. GitHub Actions deploys it and tests it every week. Nothing needs a person.

- **Live:** https://theguysaccount.github.io/proof-of-human-writing/
- **Repo:** https://github.com/theguysaccount/proof-of-human-writing
- **Base URL setting:** repository variable `SITE_URL` (unset = the github.io URL above)

## Automated jobs

| Job | Workflow | When | What it does | How it fails safe |
|---|---|---|---|---|
| Deploy | `pages.yml` | every push to `main`; on demand; when the self-test finds the live site behind `main` | JS unit tests (format, recording, analysis, 25+ cases incl. randomized edit sessions), Python build tests, build, the full end-to-end run in headless Chrome against the build, deploy, wait for the new commit to be live (`build.json`), the end-to-end run against the live site, IndexNow ping | Any failed test stops before deploy, so the last good site stays live. A failed live run marks the workflow red (GitHub emails the owner); the self-test then raises an issue. IndexNow never fails the run. |
| Weekly self-test | `selftest.yml` | Wednesdays 07:37 UTC | Unit tests; the end-to-end run against the **live** site (types, corrects, pastes, undoes and redoes with trusted keyboard events, exports, reloads the draft, reads it back by link and by file, catches a tampered file, opens the sample, refuses a damaged link, checks for console errors, requests to other sites and phone-width overflow); every sitemap page answers 200 with its own canonical and the no-network policy; every file the pages load; every cited source link; **staleness**: compares the live `build.json` commit with `main` and dispatches `pages.yml` if the site code differs | Read-only against the site. A failure opens or comments on one `ops-alert` issue (GitHub emails the owner); the next pass closes it. Cited sites that refuse robots (401/403/429) or are down (5xx) are warnings; a 404 is an error (link rot). Safe to re-run any time; it never depends on firing at an exact time. |
| Keep-alive | `selftest.yml` → `scripts/keepalive.sh` | with every self-test | Re-enables the scheduled workflow through the API; an empty `[skip ci]` commit when the last commit is 45+ days old | Without it GitHub disables the schedule after 60 days with no commits. |

There is no data refresh: the site has no data that changes. Guides cite sources; the weekly link check catches rot.

**Schedules on this account fire late.** GitHub runs `theguysaccount` crons hours late and sometimes skips them. Nothing here depends on timing: the self-test is idempotent, and the staleness check catches a missed deploy.

**The schedule trigger is proven:** the first schedule-triggered self-test ran and passed on 22 Nov 2026 ([run 45062362948](https://github.com/theguysaccount/proof-of-human-writing/actions/runs/45062362948)), through a temporary cron line that was removed afterwards.

## What to watch

- Open `ops-alert` issues, and red runs on the Actions tab.
- **Browser changes.** The recorder relies on the standard `beforeinput`/`input` events and their `inputType` (W3C Input Events). If a browser stops reporting `insertFromPaste`, pastes would show as "changed without a key press" rather than slipping through as typing: the safe direction. The end-to-end run uses real Chrome input, so a Chrome regression shows up there.
- **Never change version 1 of the file format in a breaking way.** Replay files and links people already sent must keep opening. Add fields freely (readers ignore unknown ones); for anything else, bump `VERSION` in `core.js` and keep reading version 1.
- The sample replay is generated: `node scripts/make_sample.mjs`. Regenerate it after changing the format.

## Run anything by hand

```bash
node --test tests/js/*.test.mjs && python3 -m unittest discover -s tests
python3 pipeline/build.py && node scripts/e2e.mjs              # local build, served on 127.0.0.1
node scripts/e2e.mjs https://theguysaccount.github.io/proof-of-human-writing/
python3 scripts/check_live.py https://theguysaccount.github.io/proof-of-human-writing
node scripts/e2e.mjs --screens                                 # refresh docs/screens/
python3 scripts/og.py                                          # re-render share cards
~/.local/bin/gh workflow run pages.yml -R theguysaccount/proof-of-human-writing
~/.local/bin/gh workflow run selftest.yml -R theguysaccount/proof-of-human-writing
```

## Keys Jack can turn later

### 1. Custom domain

Domains are being rolled out by a separate session; this is what it needs. Candidates (public RDAP, 22 Nov 2026): `writingreplay.com` and `writingreplay.org` are unregistered; `showhowyouwrote.com` too. No owned name in the portfolio was matched to this idea.

**First, warn anyone using the old address.** Browser storage belongs to a web address, and once the custom domain is set the github.io address redirects to it, so what visitors saved there can't be opened at the new one. Set `MOVE_NOTICE_URL` to the new address and redeploy: every page then tells visitors how to keep their drafts (open the draft, export its replay file, continue it at the new address). `~/.local/bin/gh variable set MOVE_NOTICE_URL -R theguysaccount/proof-of-human-writing --body https://D/` then `~/.local/bin/gh workflow run pages.yml -R theguysaccount/proof-of-human-writing`. Leave it a couple of weeks if the site has users (analytics, issues), then switch, and afterwards `~/.local/bin/gh variable delete MOVE_NOTICE_URL -R theguysaccount/proof-of-human-writing` and redeploy.

Steps for a domain `D` (apex) — nothing else in the code changes:
1. DNS at the registrar: `A @` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`; `AAAA @` → `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`; `CNAME www` → `theguysaccount.github.io`. (For a subdomain instead: one `CNAME` → `theguysaccount.github.io`.)
2. Attach it: `~/.local/bin/gh api -X PUT repos/theguysaccount/proof-of-human-writing/pages -f cname=D`, wait for the certificate, then `~/.local/bin/gh api -X PUT repos/theguysaccount/proof-of-human-writing/pages -F https_enforced=true`.
3. Set the base URL: `~/.local/bin/gh variable set SITE_URL -R theguysaccount/proof-of-human-writing --body https://D`, then `~/.local/bin/gh workflow run pages.yml -R theguysaccount/proof-of-human-writing`. Canonicals, sitemap, robots.txt, share cards, replay links and the 404 page all follow `SITE_URL`; the deploy's live test then runs against `https://D`.
4. Old github.io links, including replay links already sent, redirect to the domain with their `#r=…` part intact, so they keep working.
5. **Drafts in progress don't move.** Browser storage belongs to an address, so a draft saved at the github.io URL can't be opened at the new domain once github.io redirects there. Switch early, while there are few writers; the editor and the About page already tell writers to download their replay file, which they can continue from on any address ("Continue a piece from a replay file").

### 2. Money: a hosted version for schools

Pages is non-commercial, so the free tool stays free. The slot: a "For schools and publications" box on the home page, hidden until repository variable `SCHOOLS_URL` is set to a page on other hosting (for example a Stripe Payment Link or a waitlist for hosted replays, class lists and embeddable verified badges). Set it with `~/.local/bin/gh variable set SCHOOLS_URL -R theguysaccount/proof-of-human-writing --body https://…` and redeploy. Anything that stores replays server-side needs separate hosting, a privacy policy, and for schools in the US a FERPA review; none of that exists yet.

### 3. Analytics (activation metric)

Off by default, and the page's security policy blocks it until it's switched on. Activation = a writer exports a replay (`event/export_file` or `event/export_link`); the share loop = a reader opens one (`event/verify_open`). Also counted: `write_start`, `write_resume`, `export_open`, `export_preview`, `replay_play`. Event names only; never text. Create a GoatCounter site, then `~/.local/bin/gh variable set GOATCOUNTER_URL -R theguysaccount/proof-of-human-writing --body https://<code>.goatcounter.com/count` and redeploy; the build widens the security policy to that one origin and the footer says counting is on.

### 4. Search Console

Verify the domain in Google Search Console (Jack's Google account) once a custom domain is live, and submit `/sitemap.xml`. Bing, Yandex and others already get every deploy through IndexNow, and the account-root robots.txt lists this sitemap.

### 5. New guides (content routine)

A scheduled Claude routine can add one guide a month. Prompt: "In ~/code/proof-of-human-writing, add one guide page in site/pages/ (copy the front-matter pattern of guide-flagged.html) on a question writers or teachers search for about proving authorship or AI detection that the existing guides don't answer. Cite only sources you have opened, run `python3 -m unittest discover -s tests` and `node scripts/e2e.mjs`, add it to guides.html, commit, push." Nothing breaks without it.
