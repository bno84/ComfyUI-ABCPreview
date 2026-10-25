import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

let extension;
let fetchFont;
const source = readFileSync(new URL("../web/abc_preview.js", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "")
  .replace(/^export /gm, "");
const { tokenizeAbc, AbcView, libraries } = new Function("app", "api", `${source}\nreturn { tokenizeAbc, AbcView, libraries };`)(
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

function playbackView(font) {
  const activity = { rendered: 0, controllers: 0, statuses: [], tunes: [] };
  libraries.set(font, Promise.resolve({
    renderAbc() { activity.rendered++; return [{ warnings: [] }]; },
    synth: {
      supportsAudio: () => true,
      SynthController: class {
        constructor() { activity.controllers++; }
        load() {}
        async setTune(visual, autoStart, options) { activity.tunes.push(options); }
      },
    },
  }));
  return {
    activity, font, abc: "X:1\nK:C\nC4|", generation: 0, score: {}, chords: true,
    controls: { replaceChildren() {} },
    stop() {}, highlightSheet() {},
    setStatus(text) { activity.statuses.push(text); },
  };
}

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
  fetchFont = async () => ({ ok: true, json: async () => ({ resolved: "gm/GeneralUser-GS.sf2" }) });
  await AbcView.prototype.refresh.call(view);
  assert.equal(view.activity.controllers, 1);
  assert.match(view.activity.statuses.at(-1), /gm\/GeneralUser-GS.sf2/);
  assert.equal(view.activity.tunes.length, 1);
  assert.match(view.activity.tunes[0].soundFontUrl, /soundfont\//);
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
  // Wait until the library and sheet have loaded and the lookup is pending.
  await new Promise((resolve) => setImmediate(resolve));
  view.generation++;
  complete({ ok: true, json: async () => ({ resolved: "old.sf2" }) });
  await pending;
  assert.equal(view.activity.controllers, 0);
});
