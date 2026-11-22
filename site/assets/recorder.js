// Watches one text box and records each change to it: what changed, when (to 1/20 s), and how the
// browser says it arrived (a key, a paste, a drop, undo). It never records which keys were held or
// for how long, and nothing it records leaves the page.
import { SessionLog } from "./core.js";

export class Recorder {
  constructor(area, { text = "", onEvent = () => {} } = {}) {
    this.area = area;
    this.onEvent = onEvent;
    this.log = new SessionLog(text);
    this.t0 = performance.now();
    this.pending = null;
    this.hint = null; // a paste or drop seen just before an input event that doesn't name its type
    this.listeners = [
      ["beforeinput", (e) => {
        this.sync();
        this.pending = e.inputType || "";
      }],
      ["input", (e) => {
        let type = e.inputType || this.pending || "";
        if (!type && this.hint && performance.now() - this.hint.at < 1000) type = this.hint.type;
        this.pending = null;
        this.hint = null;
        this.record(type, e.isTrusted);
      }],
      ["paste", (e) => {
        if (e.isTrusted) this.hint = { type: "insertFromPaste", at: performance.now() };
      }],
      ["drop", (e) => {
        if (e.isTrusted) this.hint = { type: "insertFromDrop", at: performance.now() };
      }],
      ["keydown", () => this.sync()],
      ["focus", () => this.sync()],
    ];
    for (const [name, fn] of this.listeners) area.addEventListener(name, fn);
    this.timer = setInterval(() => this.sync(), 1000);
  }

  /** A change with no input event behind it was made by a script or extension. Record it as such. */
  sync() {
    if (this.area.value !== this.log.text) this.record("", false);
  }

  record(type, trusted) {
    const ev = this.log.change(this.area.value, this.area.selectionEnd, type, trusted, performance.now() - this.t0);
    if (ev) this.onEvent(ev);
  }

  stop() {
    this.sync();
    clearInterval(this.timer);
    for (const [name, fn] of this.listeners) this.area.removeEventListener(name, fn);
  }
}
