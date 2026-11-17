import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

let extension;
let fetchFont;
// The extension and the pack-route helper it imports, evaluated together.
const source = ["pack_routes.js", "abc_preview.js"].map((name) => readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8"))
  .join("\n")
  .replace(/^import .*;$/gm, "")
  .replace(/^export /gm, "")
  .replace(/import\.meta\.url/g, JSON.stringify("http://comfy.test/extensions/ComfyUI-ABCPreview/abc_preview.js"));
const { tokenizeAbc, AbcView, layoutFor, libraries, routeUnavailable } = new Function("app", "api", `${source}\nreturn { tokenizeAbc, AbcView, layoutFor, libraries, routeUnavailable };`)(
  { registerExtension(value) { extension = value; } },
  { apiURL: (path) => `/api${path}`, fetchApi: (...args) => fetchFont(...args) },
);

const kinds = (abc) => tokenizeAbc(abc).filter((t) => t.cls).map((t) => [abc.slice(t.start, t.end), t.cls]);

test("YuE2-style headers, voices, and comments", () => {
  const abc = 'X:1\nV: Vocal clef=treble name="Vocal" % lead\n%%score Vocal\n% intro\nK:C';
  assert.deepEqual(kinds(abc), [
    ["X:", "field-key"], ["1", "field-value"],
    ["V:", "field-key"], [' Vocal clef=treble name="Vocal" ', "field-value"], ["% lead", "comment"],
    ["%%score Vocal", "directive"], ["% intro", "comment"], ["K:", "field-key"], ["C", "field-value"],
  ]);
});

test("body tokens keep exact character offsets for abcjs ranges", () => {
  const abc = 'X:1\nK:C\n"Fmaj7"c\'z12zag|_B,3/2-B (3cde [CEG]2 !fermata!G ::|1 Z3|]';
  const tokens = tokenizeAbc(abc);
  // Tokens are ordered, non-overlapping, and cover only real text.
  for (let i = 1; i < tokens.length; i++) assert.ok(tokens[i].start >= tokens[i - 1].end);
  assert.equal(tokens.at(-1).end, abc.length);
  assert.deepEqual(kinds(abc).slice(4), [
    ['"Fmaj7"', "chord-symbol"], ["c'", "note"], ["z12", "rest"], ["z", "rest"], ["a", "note"], ["g", "note"],
    ["|", "bar"], ["_B,3/2", "note"], ["-", "tie"], ["B", "note"], ["(3", "tuplet"], ["c", "note"],
    ["d", "note"], ["e", "note"], ["[", "bracket"], ["C", "note"], ["E", "note"], ["G", "note"],
    ["]2", "bracket"], ["!fermata!", "decoration"], ["G", "note"], ["::|1", "bar"], ["Z3", "rest"], ["|]", "bar"],
  ]);
  const note = tokens.find((t) => abc.slice(t.start, t.end) === "_B,3/2");
  assert.equal(abc.indexOf("_B,3/2"), note.start);
});

test("inline fields and mid-line comments in the body", () => {
  assert.deepEqual(kinds("[M:2/4] f3e % ok"), [
    ["[M:2/4]", "inline-field"], ["f3", "note"], ["e", "note"], ["% ok", "comment"],
  ]);
});

test("only ABCPreview nodes are extended", () => {
  const nodeType = { prototype: {} };
  extension.beforeRegisterNodeDef(nodeType, { name: "PreviewAny" });
  assert.deepEqual(nodeType.prototype, {});
  extension.beforeRegisterNodeDef(nodeType, { name: "bno84.ABCPreview" });
  for (const hook of ["onNodeCreated", "onConfigure", "onExecuted", "onRemoved"]) {
    assert.equal(typeof nodeType.prototype[hook], "function");
  }
});

const FONT_ID = "a".repeat(64);

// Library instances are keyed by soundfont content ID, or "(none)" without one.
function playbackView(font) {
  const activity = { rendered: 0, controllers: 0, statuses: [], tunes: [], options: [] };
  const library = Promise.resolve({
    renderAbc(target, abc, options) { activity.rendered++; activity.options.push(options); return [{ warnings: [] }]; },
    synth: {
      supportsAudio: () => true,
      SynthController: class {
        constructor() { activity.controllers++; }
        load() {}
        async setTune(visual, autoStart, options) { activity.tunes.push(options); }
      },
    },
  });
  for (const key of ["(none)", FONT_ID]) libraries.set(key, library);
  return {
    activity, font, abc: "X:1\nK:C\nC4|", generation: 0, score: {}, chords: true, layout: layoutFor(1200),
    controls: { replaceChildren() {} },
    stop() {}, highlightSheet() {}, renderSheet: AbcView.prototype.renderSheet,
    setStatus(text) { activity.statuses.push(text); },
  };
}

test("bars per line snap to 4 or 8 by pane width", () => {
  assert.equal(layoutFor(0).bars, 4);
  assert.equal(layoutFor(1049).bars, 4);
  assert.equal(layoutFor(1050).bars, 8);
  // The same layout object is returned, so resizing within a layout does not reflow.
  assert.equal(layoutFor(1100), layoutFor(2000));
});

test("the sheet is wrapped with the current layout", async () => {
  const view = playbackView("(none)");
  fetchFont = async () => { assert.fail("must not search when disabled"); };
  await AbcView.prototype.refresh.call(view);
  const [options] = view.activity.options;
  assert.equal(options.staffwidth, 1480);
  assert.equal(options.wrap.preferredMeasuresPerLine, 8);
});

function timedView(timer) {
  const visual = { name: "reflowed" };
  return {
    view: {
      visual: {}, controller: { timer, visualObj: {} }, score: {}, abc: "X:1\nK:C\nC4|", layout: layoutFor(0),
      ABCJS: { renderAbc: () => [visual] }, highlightSheet() {},
      renderSheet: AbcView.prototype.renderSheet,
    },
    visual,
  };
}

function fakeTimer(state) {
  const calls = [];
  return {
    calls, lastMoment: 10000, isPaused: false, pausedPercent: null, currentTime: 0, ...state,
    replaceTarget(target) { calls.push(["replaceTarget", target]); this.isRunning = false; },
    start(percent) { calls.push(["start", percent]); },
    setProgress(percent) { calls.push(["setProgress", percent]); },
  };
}

test("reflowing during playback keeps the position and keeps playing", () => {
  const timer = fakeTimer({ isRunning: true, startTime: performance.now() - 2500 });
  const { view, visual } = timedView(timer);
  AbcView.prototype.relayout.call(view);
  assert.equal(view.controller.visualObj, visual);
  assert.deepEqual(timer.calls[0], ["replaceTarget", visual]);
  assert.equal(timer.calls[1][0], "start");
  assert.ok(Math.abs(timer.calls[1][1] - 0.25) < 0.01);
});

test("reflowing while paused keeps the paused position", () => {
  const timer = fakeTimer({ isRunning: false, isPaused: true, pausedPercent: 0.4 });
  const { view } = timedView(timer);
  AbcView.prototype.relayout.call(view);
  assert.deepEqual(timer.calls[1], ["setProgress", 0.4]);
});

test("missing soundfont preserves notation and explains how to enable playback", async () => {
  const view = playbackView("missing.sf2");
  fetchFont = async (path) => {
    assert.match(path, /name=missing.sf2$/);
    return { ok: true, json: async () => ({ soundfonts: [], resolved: null }) };
  };
  await AbcView.prototype.refresh.call(view);
  assert.equal(view.activity.rendered, 1);
  assert.equal(view.activity.controllers, 0);
  assert.match(view.activity.statuses.at(-1), /missing.sf2 is not installed/);
});

test("matched font enables playback and reports the installed subfolder", async () => {
  const view = playbackView("GeneralUser-GS.sf2");
  fetchFont = async () => ({ ok: true, json: async () => ({ resolved: "gm/GeneralUser-GS.sf2", id: FONT_ID }) });
  await AbcView.prototype.refresh.call(view);
  assert.equal(view.activity.controllers, 1);
  assert.match(view.activity.statuses.at(-1), /gm\/GeneralUser-GS.sf2/);
  assert.equal(view.activity.tunes.length, 1);
  assert.equal(view.activity.tunes[0].soundFontUrl, `/api/bno84/abcpreview/soundfont/${FONT_ID}/`);
});

// What Comfy on Civitai answers for a route a pack registers itself.
const CIVITAI_501 = {
  error: { type: "backend_route_unavailable", message: "This action isn't available in Comfy on Civitai" },
  node_errors: {},
};
const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("pack routes count as unavailable on a host's 501 or a plain 404", async () => {
  assert.equal(await routeUnavailable(json(CIVITAI_501, 501)), true);
  assert.equal(await routeUnavailable(new Response("404: Not Found", { status: 404 })), true);
  // The pack's own errors, and other failures, keep their own messages.
  assert.equal(await routeUnavailable(json({ error: "Unknown soundfont." }, 404)), false);
  assert.equal(await routeUnavailable(json({ error: { type: "other" } }, 501)), false);
  assert.equal(await routeUnavailable(new Response("Server error", { status: 500 })), false);
  assert.equal(await routeUnavailable(json({}, 200)), false);
});

test("without the pack's routes the sheet still renders and playback says why it is off", async () => {
  for (const response of [json(CIVITAI_501, 501), new Response("404: Not Found", { status: 404 })]) {
    const view = playbackView("GeneralUser-GS.sf2");
    fetchFont = async () => response;
    await AbcView.prototype.refresh.call(view);
    assert.equal(view.activity.rendered, 1);
    assert.equal(view.activity.controllers, 0);
    assert.equal(view.activity.statuses.at(-1),
      "Playback is not available on this host: it needs the ABC Preview server routes.");
  }
});

test("explicit none keeps playback off without searching for a font", async () => {
  const view = playbackView("(none)");
  fetchFont = async () => { assert.fail("must not search when disabled"); };
  await AbcView.prototype.refresh.call(view);
  assert.equal(view.activity.rendered, 1);
  assert.equal(view.activity.controllers, 0);
});

test("obsolete font lookup cannot enable playback after another refresh", async () => {
  const view = playbackView("old.sf2");
  let complete;
  fetchFont = () => new Promise((resolve) => { complete = resolve; });
  const pending = AbcView.prototype.refresh.call(view);
  // The lookup is pending; nothing may render or play for the old refresh.
  await new Promise((resolve) => setImmediate(resolve));
  view.generation++;
  complete({ ok: true, json: async () => ({ resolved: "old.sf2", id: FONT_ID }) });
  await pending;
  assert.equal(view.activity.controllers, 0);
});

function scrollingView(height = 140, scale = 1) {
  let scrollTop = 0;
  const sheet = {
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.max(0, value); },
    clientHeight: height,
    getBoundingClientRect: () => ({ top: 100, bottom: 100 + height * scale, height: height * scale }),
    querySelectorAll(selector) { return rows[Number(selector.match(/\d+/)[0])] ?? []; },
  };
  const part = (line, offset, partHeight) => ({
    getAttribute: () => `abcjs-note abcjs-l${line}`,
    classList: { add() {}, remove() {} },
    getBoundingClientRect() {
      const top = 100 + (line * 200 + offset - sheet.scrollTop) * scale;
      return { top, bottom: top + partHeight * scale, height: partHeight * scale };
    },
  });
  const rows = [0, 1, 2].map((line) => [part(line, 0, 100)]);
  const note = (line) => part(line, 25, 12);
  const view = { sheet, lastMs: 0, recentSystems: [] };
  const play = (lines, ms) => AbcView.prototype.highlightSheet.call(view, lines.map((line) => [note(line)]), ms);
  return { sheet, view, play };
}

test("scrolls on the first onset of a new row at any pane size or canvas zoom", () => {
  for (const height of [80, 140, 500]) {
    for (const scale of [0.5, 1, 2]) {
      const { sheet, view, play } = scrollingView(height, scale);
      play([0], 0);
      play([0], 1000);
      // The previous onset is only 100 ms old. It must not hold back the row.
      play([1], 1100);
      assert.equal(view.sheetLine, "1", `height=${height}, scale=${scale}`);
      assert.equal(sheet.scrollTop, 196, `height=${height}, scale=${scale}`);
      play([1], 1200);
      assert.equal(sheet.scrollTop, 196, "the row stays still between onsets");
    }
  }
});

test("simultaneous voices follow the earliest current row, then advance immediately", () => {
  const { sheet, view, play } = scrollingView();
  play([0], 0);
  play([1, 0], 1000);
  assert.equal(view.sheetLine, "0");
  play([1], 1100);
  assert.equal(view.sheetLine, "1");
  assert.equal(sheet.scrollTop, 196);
});

test("backward seeking and repeated sections return to earlier rows", () => {
  const { sheet, view, play } = scrollingView();
  play([2], 4000);
  play([0], 1000);
  assert.equal(view.sheetLine, "0");
  assert.equal(sheet.scrollTop, 0);
  play([1], 2000);
  // A written repeat revisits row zero while playback time keeps advancing.
  play([0], 3000);
  assert.equal(view.sheetLine, "0");
  assert.equal(sheet.scrollTop, 0);
});

test("stopping clears the row and notes without moving the sheet", () => {
  const { sheet, view, play } = scrollingView();
  play([1], 1000);
  const position = sheet.scrollTop;
  play([], undefined);
  assert.equal(view.sheetLine, undefined);
  assert.deepEqual(view.playing, []);
  assert.equal(sheet.scrollTop, position);
  play([0], 0);
  assert.equal(view.sheetLine, "0");
});
