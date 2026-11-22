// A stand-in for a person at the text box. It edits a string the way a browser would and reports
// each change to a SessionLog exactly as site/assets/recorder.js does. Used by the unit tests and by
// make_sample.mjs, which is how the site's sample replay is made (the sample says so).
import { SessionLog } from "../site/assets/core.js";

export class Writer {
  constructor(log = new SessionLog("", "2026-03-01T10:00:00.000Z")) {
    this.log = log;
    this.value = log.text;
    this.caret = this.value.length;
    this.now = 0;
  }

  wait(ms) {
    this.now += ms;
    return this;
  }

  moveTo(pos) {
    this.caret = pos;
    return this;
  }

  edit(pos, del, ins, type, trusted = true) {
    this.value = this.value.slice(0, pos) + ins + this.value.slice(pos + del);
    this.caret = pos + ins.length;
    this.log.change(this.value, this.caret, type, trusted, this.now);
    return this;
  }

  type(text, gap = 120) {
    for (const ch of text) this.wait(gap).edit(this.caret, 0, ch, ch === "\n" ? "insertLineBreak" : "insertText");
    return this;
  }

  backspace(n = 1, gap = 100) {
    for (let i = 0; i < n; i++) {
      const prev = [...this.value.slice(0, this.caret)].pop() || "";
      this.wait(gap).edit(this.caret - prev.length, prev.length, "", "deleteContentBackward");
    }
    return this;
  }

  paste(text) {
    return this.wait(400).edit(this.caret, 0, text, "insertFromPaste");
  }

  cut(pos, len) {
    return this.wait(400).edit(pos, len, "", "deleteByCut");
  }
}
