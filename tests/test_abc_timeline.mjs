import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/abc_timeline.js", import.meta.url), "utf8");
const { blocks, clock, summary, ticks } = new Function("app",
  source.replace(/^import .*;$/gm, "").replaceAll("export function", "function").replaceAll("export async function", "async function") + "\nreturn { blocks, clock, summary, ticks };",
)({ registerExtension() {} });

const section = (label, start, end, bars) => ({ label, start, end, bars, bar: 0 });
const TIMELINE = {
  seconds: 80, bars: 20, tempi: [80], tempo_assumed: false, meters: ["4/4"], key: "F",
  sections: [section("", 0, 8, 2), section("Verse", 8, 40, 8), section("chorus", 40, 60, 5), section("verse 2", 60, 80, 5)],
};

test("summary names duration, bars, tempo, meter and key", () => {
  assert.equal(summary(TIMELINE), "1:20 (80 s) · 20 bars · 80 BPM · 4/4 · F");
  assert.equal(summary({ ...TIMELINE, tempi: [80, 120], meters: ["4/4", "3/4"], key: "" }),
    "1:20 (80 s) · 20 bars · 80–120 BPM · 4/4, 3/4");
  assert.equal(summary({ ...TIMELINE, tempi: [120], tempo_assumed: true }), "1:20 (80 s) · 20 bars · 120 BPM (assumed) · 4/4 · F");
});

test("blocks are proportional, and sections of one kind share a color", () => {
  const [lead, verse, chorus, verse2] = blocks(TIMELINE);
  assert.deepEqual([lead.left, lead.width, verse.left, verse.width], [0, 10, 10, 40]);
  assert.equal(verse.color, verse2.color);
  assert.notEqual(verse.color, chorus.color);
  assert.equal(lead.color, "#666");
});

test("clock and axis ticks", () => {
  assert.equal(clock(59.6), "1:00");
  assert.deepEqual(ticks(80).map((t) => t.seconds), [0, 15, 30, 45, 60, 75]);
  assert.deepEqual(ticks(522).map((t) => t.seconds), [0, 120, 240, 360, 480]);
});


test("direct ABC loading uses the parser route and ignores stale requests", async () => {
  const requests = [], pending = [];
  const { loadTimeline } = new Function("app", "api",
    source.replace(/^import .*;$/gm, "").replaceAll("export function", "function").replaceAll("export async function", "async function").replaceAll("export async function", "async function") + "\nreturn { loadTimeline };",
  )({ registerExtension() {} }, { fetchApi(path, options) {
    requests.push([path, JSON.parse(options.body)]);
    return new Promise(resolve => pending.push(resolve));
  } });
  const outputs = [];
  const node = { onExecuted(output) { outputs.push(output); } };
  const first = loadTimeline(node, "FIRST"), second = loadTimeline(node, "SECOND");
  pending[1]({ ok: true, json: async () => TIMELINE });
  await second;
  pending[0]({ ok: true, json: async () => ({ bars: 1 }) });
  await first;
  assert.deepEqual(requests, [["/bno84/abcpreview/timeline", { abc: "FIRST" }], ["/bno84/abcpreview/timeline", { abc: "SECOND" }]]);
  assert.deepEqual(outputs, [{ abc_timeline: [TIMELINE] }]);
  const failed = loadTimeline(node, "BAD");
  pending[2]({ ok: false, json: async () => ({ error: "Invalid ABC" }) });
  await assert.rejects(failed, /Invalid ABC/);
});
