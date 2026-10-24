import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

let extension;
const source = readFileSync(new URL("../web/abc_preview.js", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "")
  .replace(/^export /gm, "");
const { tokenizeAbc } = new Function("app", "api", `${source}\nreturn { tokenizeAbc };`)(
  { registerExtension(value) { extension = value; } },
  { apiURL: (path) => `/api${path}` },
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
