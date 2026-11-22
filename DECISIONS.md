# Decisions

1. **Keystroke replay, not video.** The note asked for video of typing. Video is heavy, invasive (faces, rooms, screens), needs upload or huge files, and is just as fakeable (replay an auto-typer on camera). A text-level edit log answers the same question, works on phones, stays private and is small enough for a link. Settles the open question "video proof or keystroke replay?".
2. **No publishing platform.** The note imagined a platform that only publishes proven work. Pages is non-commercial and static, and a social platform is cut in the brief. The replay travels with the work instead: file, link, badge. A hosted platform is a later key.
3. **Modest claims, stated on every replay.** The reader shows a "Read this first" box: process evidence, not authorship proof, fakeable by an auto-typer or a hand-written file. No scores, no verdicts; observations are facts plus what they can mean. The sample replay was typed by a script and says so.
4. **Record text changes, not keys.** Origins come from `InputEvent.inputType` and `isTrusted`; times are rounded to 50 ms; key-hold durations are never seen. Keystroke dynamics are biometric data; this records less than a keylogger and nothing about the device.
5. **Pasted text stays pasted; moved text stays typed.** Insertions that match text already in the document or recently removed keep their origin, so cut-and-paste reorganising isn't penalised and copying pasted text again doesn't launder it.
6. **Nothing leaves the device, enforced.** Every page has a CSP with `connect-src 'none'` and scripts from self only. Analytics, if switched on, widens it to one origin.
7. **Static site, no build dependencies.** Python stdlib build; vanilla JS modules; Node only for tests. The end-to-end test drives real Chrome over the DevTools protocol so input events are trusted.
8. **Name: Writing Replay.** Plain, searchable, says what it does. Repo name kept as assigned.
