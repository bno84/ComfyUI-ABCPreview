// Draw an executed ABC timeline: total duration, tempo, meter and key, then
// the sections as proportional blocks over a time axis. Sections that share
// a name share a color.
import { app } from "../../scripts/app.js";

const NODE = "bno84.ABCTimeline";
const COLORS = ["#7f77dd", "#1d9e75", "#d85a30", "#d4537e", "#378add", "#ba7517", "#639922"];
const UNNAMED = "#666";

export function clock(seconds) {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// "86 BPM", "86–92 BPM", or "120 BPM (assumed)" without a Q: field.
function tempoText({ tempi, tempo_assumed }) {
  const low = Math.min(...tempi), high = Math.max(...tempi);
  const bpm = low === high ? `${+low.toFixed(1)}` : `${+low.toFixed(1)}–${+high.toFixed(1)}`;
  return `${bpm} BPM${tempo_assumed ? " (assumed)" : ""}`;
}

export function summary(timeline) {
  // Seconds too: a hard cutoff such as YuE2's max_duration is entered in seconds.
  return [
    `${clock(timeline.seconds)} (${+timeline.seconds.toFixed(1)} s)`, `${timeline.bars} bars`, tempoText(timeline),
    timeline.meters.join(", "), timeline.key,
  ].filter(Boolean).join(" · ");
}

// Section names compare without case or trailing numbers: "Verse 2" matches "verse".
const kind = (label) => label.toLowerCase().replace(/[\s\d]+$/, "");

// Plain data, so layout can be tested without a DOM.
export function blocks(timeline) {
  const colors = new Map();
  return timeline.sections.map((section) => {
    const name = kind(section.label);
    if (name && !colors.has(name)) colors.set(name, COLORS[colors.size % COLORS.length]);
    return {
      label: section.label, bars: section.bars, start: section.start, end: section.end,
      left: (100 * section.start) / timeline.seconds,
      width: (100 * (section.end - section.start)) / timeline.seconds,
      color: name ? colors.get(name) : UNNAMED,
    };
  });
}

// Axis labels at a round step giving at most about six ticks.
export function ticks(seconds) {
  const step = [5, 10, 15, 30, 60, 120, 300].find((s) => seconds / s <= 6) ?? 600;
  const marks = [];
  for (let t = 0; t <= seconds + 1e-6; t += step) marks.push({ seconds: t, left: (100 * t) / seconds });
  return marks;
}

function styles() {
  if (document.getElementById("abc-timeline-style")) return;
  const style = document.createElement("style");
  style.id = "abc-timeline-style";
  style.textContent = `
.abc-timeline {box-sizing:border-box;width:100%;height:100%;overflow:auto;padding:4px 10px;color:var(--input-text,#ddd);font:13px/1.45 sans-serif;}
.abc-timeline .summary {font-weight:bold;margin-bottom:6px;}
.abc-timeline .strip {position:relative;height:34px;border-radius:4px;overflow:hidden;background:var(--comfy-input-bg,#252525);}
.abc-timeline .block {position:absolute;top:0;bottom:0;box-sizing:border-box;border-left:1px solid #0006;padding:0 4px;color:#fff;font-size:12px;line-height:34px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.abc-timeline .axis {position:relative;height:16px;margin-bottom:6px;font-size:11px;opacity:.7;}
.abc-timeline .axis span {position:absolute;transform:translateX(-50%);}
.abc-timeline .axis span:first-child {transform:none;}
.abc-timeline ol {margin:0;padding-left:0;list-style:none;}
.abc-timeline li {display:flex;gap:8px;align-items:center;}
.abc-timeline .swatch {width:10px;height:10px;border-radius:2px;flex:none;}
.abc-timeline .times {opacity:.75;margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums;}
.abc-timeline .note {opacity:.75;}
`;
  document.head.append(style);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render(root, timeline) {
  if (!timeline) {
    root.replaceChildren(element("div", "Run the workflow to see the score's timeline.", "note"));
    return;
  }
  if (!timeline.bars) {
    root.replaceChildren(element("div", "No bars found in this ABC.", "note"));
    return;
  }
  const strip = element("div", undefined, "strip");
  const list = element("ol");
  for (const block of blocks(timeline)) {
    const name = block.label || "(unnamed)";
    const span = `${clock(block.start)}–${clock(block.end)} · ${block.bars} bar${block.bars === 1 ? "" : "s"}`;
    const part = element("div", name, "block");
    Object.assign(part.style, { left: `${block.left}%`, width: `${block.width}%`, background: block.color });
    part.title = `${name}\n${span}`;
    strip.append(part);
    const swatch = element("span", undefined, "swatch");
    swatch.style.background = block.color;
    const item = element("li");
    item.append(swatch, element("span", name), element("span", span, "times"));
    list.append(item);
  }
  const axis = element("div", undefined, "axis");
  for (const tick of ticks(timeline.seconds)) {
    const label = element("span", clock(tick.seconds));
    label.style.left = `${tick.left}%`;
    axis.append(label);
  }
  root.replaceChildren(element("div", summary(timeline), "summary"), strip, axis, list);
}

app.registerExtension({
  name: "bno84.ABCTimeline",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (output, ...args) {
      const result = onExecuted?.call(this, output, ...args);
      if (this.abcTimeline) {
        render(this.abcTimeline, output?.abc_timeline?.[0]);
        // Grow to show every section; never shrink a size the user chose.
        requestAnimationFrame(() => {
          const extra = this.abcTimeline.scrollHeight - this.abcTimeline.clientHeight;
          if (extra > 0) this.setSize([this.size[0], this.size[1] + extra]);
          this.graph?.setDirtyCanvas?.(true, true);
        });
      }
      return result;
    };
  },
  nodeCreated(node) {
    if (node.comfyClass !== NODE) return;
    styles();
    node.abcTimeline = element("div", undefined, "abc-timeline");
    render(node.abcTimeline);
    const widget = node.addDOMWidget("timeline", "timeline", node.abcTimeline, {
      serialize: false, canvasOnly: true, hideOnZoom: false, getMinHeight: () => 120,
    });
    widget.serialize = false;
  },
});
