// Sheet music, highlighted ABC source, and optional playback for ABCPreview.
// abcjs (MIT) is vendored and served by the pack's own route; soundfonts are
// user-supplied .sf2 files rendered note-by-note by the backend.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "bno84.ABCPreview";
const NONE = "(none)";

let libraryText;
const libraries = new Map();

// abcjs caches decoded notes by instrument and note name, not by soundfont URL.
// One library instance per soundfont keeps notes from different fonts apart.
function abcjsFor(font) {
  if (!libraries.has(font)) {
    libraryText ??= fetch(api.apiURL("/bno84/abcpreview/abcjs/abcjs-basic-min.js")).then((response) => {
      if (!response.ok) throw new Error(`abcjs unavailable (${response.status})`);
      return response.text();
    });
    libraries.set(font, libraryText.then((text) => {
      const module = { exports: {} };
      new Function("module", "exports", text)(module, module.exports);
      return module.exports;
    }));
  }
  return libraries.get(font);
}

function soundFontUrl(font) {
  const bytes = new TextEncoder().encode(font);
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return api.apiURL(`/bno84/abcpreview/soundfont/${token}/`);
}

const STYLE = `
.abcp-root { display: flex; flex-direction: column; gap: 4px; width: 100%; height: 100%; min-height: 0;
  box-sizing: border-box; font-size: 12px; color: var(--input-text, #ddd); }
.abcp-toolbar { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.abcp-controls { flex: 1 1 260px; min-width: 220px; }
.abcp-controls .abcjs-inline-audio { height: 26px; padding: 0 4px; border-radius: 4px; }
.abcp-toolbar label { display: flex; align-items: center; gap: 3px; white-space: nowrap; }
.abcp-toolbar button.abcp-button { background: var(--comfy-input-bg, #222); color: inherit;
  border: 1px solid var(--border-color, #555); border-radius: 4px; padding: 2px 8px; cursor: pointer; }
.abcp-status { flex-basis: 100%; opacity: 0.8; }
.abcp-status:empty { display: none; }
.abcp-credit { flex: none; font-size: 10px; opacity: 0.5; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.abcp-credit a { color: inherit; }
.abcp-status.abcp-error { color: #f88; opacity: 1; }
.abcp-body { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; min-height: 0; }
.abcp-sheet { flex: 3 1 0; min-height: 80px; overflow: auto; color: #000; border-radius: 4px; }
.abcp-sheet:has(svg) { background: #fff; }
.abcp-sheet svg .abcp-playing { fill: #d0021b; }
.abcp-source { flex: 2 1 0; min-height: 60px; overflow: auto; margin: 0; padding: 6px; border-radius: 4px;
  background: var(--comfy-input-bg, #1b1b1b); font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace;
  white-space: pre; tab-size: 4; cursor: text; }
.abcp-source span[data-start] { cursor: pointer; }
.abcp-source .abcp-active { background: #d0021b; color: #fff; border-radius: 2px; }
.abcp-comment { color: #7f8c8d; font-style: italic; }
.abcp-directive { color: #c39bd3; }
.abcp-field-key { color: #f5b041; font-weight: bold; }
.abcp-field-value { color: #f8c471; }
.abcp-inline-field { color: #f5b041; }
.abcp-chord-symbol { color: #58d68d; }
.abcp-decoration { color: #ec7063; }
.abcp-bar { color: #5dade2; font-weight: bold; }
.abcp-note { color: #eaeded; }
.abcp-rest { color: #95a5a6; }
.abcp-tie, .abcp-slur, .abcp-tuplet, .abcp-broken, .abcp-bracket { color: #af7ac5; }
.abcp-overlay { position: fixed; inset: 3vh 3vw; z-index: 10000; padding: 10px; border-radius: 8px;
  background: var(--comfy-menu-bg, #2a2a2a); box-shadow: 0 8px 40px #000a; display: flex; }
.abcp-overlay .abcp-body { flex-direction: row; }
.abcp-overlay .abcp-sheet { flex: 3 1 0; }
.abcp-overlay .abcp-source { flex: 2 1 0; font-size: 13px; }
`;

function injectStyles() {
  if (document.getElementById("abcp-style")) return;
  const audioCss = document.createElement("link");
  audioCss.rel = "stylesheet";
  audioCss.href = api.apiURL("/bno84/abcpreview/abcjs/abcjs-audio.css");
  const style = document.createElement("style");
  style.id = "abcp-style";
  style.textContent = STYLE;
  document.head.append(audioCss, style);
}

// Lightweight ABC syntax highlighting. Character offsets are kept so abcjs's
// startChar/endChar ranges can be mapped back onto the source.
const BODY_RULES = [
  [/%.*/y, "comment"],
  [/"[^"]*"?/y, "chord-symbol"],
  [/![^!\n]*!|\+[^+\s]*\+/y, "decoration"],
  [/\[[A-Za-z]:[^\]\n]*\]/y, "inline-field"],
  [/(?:\[\||:*\|[\]|:]*|::+)\d*|\[\d+/y, "bar"],
  [/[_^=]*[A-Ga-g][,']*\d*\/*\d*/y, "note"],
  [/[zZxX]\d*\/*\d*/y, "rest"],
  [/\(\d(?::\d*)*/y, "tuplet"],
  [/-/y, "tie"],
  [/[()]/y, "slur"],
  [/[<>]+/y, "broken"],
  [/[[\]]\d*/y, "bracket"],
  [/\s+/y, null],
  [/[^\s]/y, null],
];

export function tokenizeAbc(text) {
  const tokens = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const push = (start, end, cls) => { if (end > start) tokens.push({ start: offset + start, end: offset + end, cls }); };
    const field = /^([A-Za-z+]):/.exec(line);
    if (line.startsWith("%%")) push(0, line.length, "directive");
    else if (line.startsWith("%")) push(0, line.length, "comment");
    else if (field) {
      const comment = line.indexOf("%", 2);
      const end = comment < 0 ? line.length : comment;
      push(0, 2, "field-key");
      push(2, end, "field-value");
      push(end, line.length, "comment");
    } else {
      let position = 0;
      while (position < line.length) {
        for (const [pattern, cls] of BODY_RULES) {
          pattern.lastIndex = position;
          const match = pattern.exec(line);
          if (!match) continue;
          push(position, position + match[0].length, cls);
          position += match[0].length;
          break;
        }
      }
    }
    offset += line.length + 1;
  }
  return tokens;
}

const systemOf = (element) => /\babcjs-l(\d+)\b/.exec(element.getAttribute("class") ?? "")?.[1];

// Align the top of a score system (staves, chord symbols, tempo) with the top
// of the pane. Scrolls only when the system changes or the note is out of
// view, so the page holds still within a system.
function alignSystem(container, line, element, current) {
  const box = container.getBoundingClientRect();
  if (line === undefined || !box.height || !container.clientHeight) return current;
  const scale = box.height / container.clientHeight;
  const target = element.getBoundingClientRect();
  const visible = target.top >= box.top && target.bottom <= box.bottom;
  if (line === current && visible) return current;
  let top = Infinity;
  for (const part of container.querySelectorAll(`.abcjs-l${line}`)) {
    const rect = part.getBoundingClientRect();
    if (rect.height) top = Math.min(top, rect.top);
  }
  if (top !== Infinity) container.scrollTop += (top - box.top) / scale - 4;
  return line;
}

function scrollWithin(container, element) {
  const box = container.getBoundingClientRect();
  const target = element.getBoundingClientRect();
  if (!box.height || !container.clientHeight) return;
  // The node may be scaled by canvas zoom; convert screen pixels to scroll pixels.
  const scale = box.height / container.clientHeight;
  const top = (target.top - box.top) / scale;
  const bottom = (target.bottom - box.top) / scale;
  if (top < 0 || bottom > container.clientHeight) container.scrollTop += top - container.clientHeight / 3;
  const left = (target.left - box.left) / scale;
  if (left < 0 || left > container.clientWidth) container.scrollLeft += left - container.clientWidth / 3;
}

class AbcView {
  constructor({ onExpand } = {}) {
    this.abc = "";
    this.font = NONE;
    this.chords = true;
    this.generation = 0;
    this.recentSystems = [];
    this.lastMs = 0;
    this.root = document.createElement("div");
    this.root.className = "abcp-root";
    this.root.innerHTML = `
      <div class="abcp-toolbar">
        <div class="abcp-controls"></div>
        <label title="Play chord symbols as accompaniment"><input type="checkbox" checked> Chords</label>
        <button class="abcp-button" type="button"></button>
        <div class="abcp-status"></div>
      </div>
      <div class="abcp-body"><div class="abcp-sheet"><div class="abcp-score"></div></div><pre class="abcp-source"></pre></div>
      <div class="abcp-credit">Sheet music and playback:
        <a href="https://www.abcjs.net" target="_blank" rel="noopener noreferrer">abcjs</a>
        © Paul Rosen &amp; Gregory Dyke, MIT</div>`;
    // abcjs styles the element it renders into, so the score sits inside the scroll pane.
    [this.controls, this.status, this.sheet, this.score, this.source] = ["controls", "status", "sheet", "score", "source"]
      .map((name) => this.root.querySelector(`.abcp-${name}`));
    const chords = this.root.querySelector("input");
    chords.addEventListener("change", () => { this.chords = chords.checked; this.refresh(); });
    const expand = this.root.querySelector("button");
    expand.textContent = onExpand ? "Expand" : "Close";
    expand.addEventListener("click", () => onExpand ? onExpand() : this.onClose?.());
    // Scroll the score and source instead of zooming the canvas underneath.
    for (const pane of [this.sheet, this.source]) {
      pane.addEventListener("wheel", (event) => {
        if (pane.scrollHeight > pane.clientHeight || pane.scrollWidth > pane.clientWidth) event.stopPropagation();
      }, { passive: true });
    }
    this.source.addEventListener("click", (event) => {
      const span = event.target.closest?.("span[data-start]");
      if (!span) return;
      const start = Number(span.dataset.start), end = Number(span.dataset.end);
      this.highlightSource([[start, end]]);
      this.visual?.engraver?.rangeHighlight(start, end);
    });
    this.renderSource();
  }

  setAbc(abc) {
    if (abc === this.abc) return;
    this.abc = abc;
    this.renderSource();
    this.refresh();
  }

  setFont(font) {
    font = font || NONE;
    if (font === this.font && this.visual) return;
    this.font = font;
    this.refresh();
  }

  setStatus(text, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle("abcp-error", error);
  }

  renderSource() {
    this.spans = [];
    const fragment = document.createDocumentFragment();
    let position = 0;
    for (const token of tokenizeAbc(this.abc)) {
      if (token.start > position) fragment.append(this.abc.slice(position, token.start));
      const span = document.createElement("span");
      span.textContent = this.abc.slice(token.start, token.end);
      if (token.cls) span.className = `abcp-${token.cls}`;
      span.dataset.start = token.start;
      span.dataset.end = token.end;
      fragment.append(span);
      this.spans.push(span);
      position = token.end;
    }
    if (position < this.abc.length) fragment.append(this.abc.slice(position));
    this.source.replaceChildren(fragment);
    this.active = [];
  }

  highlightSource(ranges) {
    for (const span of this.active) span.classList.remove("abcp-active");
    this.active = this.spans.filter((span) => ranges.some(([start, end]) =>
      Number(span.dataset.start) < end && Number(span.dataset.end) > start));
    for (const span of this.active) span.classList.add("abcp-active");
    if (this.active.length) scrollWithin(this.source, this.active[0]);
  }

  highlightSheet(groups, milliseconds) {
    for (const element of this.playing ?? []) element.classList.remove("abcp-playing");
    this.playing = (groups ?? []).flat();
    for (const element of this.playing) element.classList.add("abcp-playing");
    if (!this.playing.length || milliseconds === undefined || milliseconds < this.lastMs) {
      this.recentSystems = [];  // Stopped, restarted, or seeking backwards.
      this.sheetLine = undefined;
    }
    if (!this.playing.length) return;
    // Voices may break lines at different bars, so simultaneous notes can sit
    // in different systems. Follow the earliest system that sounded recently
    // instead of jumping between them on every onset.
    const now = milliseconds ?? 0;
    this.lastMs = now;
    for (const element of this.playing) this.recentSystems.push([Number(systemOf(element)), now, element]);
    this.recentSystems = this.recentSystems.filter(([line, time]) => !Number.isNaN(line) && now - time < 1500);
    const [line, , element] = this.recentSystems.reduce((a, b) => (b[0] < a[0] ? b : a), this.recentSystems[0] ?? []);
    if (element) this.sheetLine = alignSystem(this.sheet, String(line), element, this.sheetLine);
  }

  stop() {
    try { this.controller?.pause(); } catch { /* not started */ }
  }

  async refresh() {
    const generation = ++this.generation;
    this.stop();
    this.controller = null;
    this.visual = null;
    this.controls.replaceChildren();
    this.highlightSheet([]);
    if (!this.abc.trim()) {
      this.score.replaceChildren();
      this.setStatus("Run the workflow to preview its ABC score.");
      return;
    }
    let ABCJS;
    try {
      ABCJS = await abcjsFor(this.font);
    } catch (error) {
      return this.setStatus(String(error.message ?? error), true);
    }
    if (generation !== this.generation) return;
    const [visual] = ABCJS.renderAbc(this.score, this.abc, {
      add_classes: true,
      responsive: "resize",
      selectionColor: "#d0021b",
      clickListener: (element) => this.highlightSource([[element.startChar, element.endChar]]),
    });
    this.visual = visual;
    const warnings = visual?.warnings?.length ? ` ${visual.warnings.length} ABC parser warning(s).` : "";
    if (this.font === NONE) {
      return this.setStatus(`Playback disabled: choose a soundfont (place .sf2 files in models/soundfonts, then refresh).${warnings}`);
    }
    if (!ABCJS.synth.supportsAudio()) return this.setStatus("Playback is not supported by this browser.", true);
    const controller = new ABCJS.synth.SynthController();
    controller.load(this.controls, {
      onStart: () => this.highlightSheet([]),
      onFinished: () => { this.highlightSheet([]); this.highlightSource([]); },
      onEvent: (event) => {
        this.highlightSheet(event.elements, event.milliseconds);
        this.highlightSource((event.startCharArray ?? []).map((start, i) => [start, event.endCharArray[i]]));
      },
      onReady: () => this.setStatus(warnings.trim()),
    }, { displayLoop: true, displayRestart: true, displayPlay: true, displayProgress: true, displayWarp: true });
    this.controller = controller;
    this.setStatus(`Press play; notes are rendered from ${this.font} on first use.${warnings}`);
    try {
      // Voices plus chord accompaniment clipped at abcjs's default 1.0 multiplier.
      await controller.setTune(visual, false, {
        soundFontUrl: soundFontUrl(this.font), soundFontVolumeMultiplier: 0.6, chordsOff: !this.chords,
      });
    } catch (error) {
      if (generation === this.generation) this.setStatus(`Playback unavailable: ${error?.message ?? error}`, true);
    }
  }

  destroy() {
    this.generation++;
    this.stop();
    this.controller = null;
    this.root.remove();
  }
}

function openOverlay(node) {
  node.abcPreview.stop();
  const view = new AbcView();
  const overlay = document.createElement("div");
  overlay.className = "abcp-overlay";
  overlay.append(view.root);
  const close = () => {
    view.destroy();
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
  view.onClose = close;
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  view.setFont(node.abcPreview.font);
  view.setAbc(node.abcPreview.abc);
}

function fontWidget(node) {
  return node.widgets?.find((widget) => widget.name === "soundfont");
}

app.registerExtension({
  name: "bno84.ABCPreview",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      injectStyles();
      this.abcPreview = new AbcView({ onExpand: () => openOverlay(this) });
      // canvasOnly: like native media previews; the properties panel would
      // otherwise adopt this element and squeeze it to the panel's width.
      const preview = this.addDOMWidget("abc_preview", "abcpreview", this.abcPreview.root, {
        serialize: false,
        canvasOnly: true,
        hideOnZoom: false,
        getMinHeight: () => 320,
      });
      // Also leave it out of widgets_values, so saved values keep mapping to
      // the soundfont widget even though the preview now comes first.
      preview.serialize = false;
      const widget = fontWidget(this);
      if (widget) {
        // Keep the soundfont choice below the preview; it only affects playback.
        this.widgets.splice(this.widgets.indexOf(widget), 1);
        this.widgets.push(widget);
        const callback = widget.callback;
        widget.callback = (value, ...rest) => {
          this.abcPreview.setFont(widget.value);
          return callback?.call(widget, value, ...rest);
        };
      }
      this.abcPreview.setFont(widget?.value);
      this.setSize([Math.max(this.size[0], 720), Math.max(this.size[1], 640)]);
      return result;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      this.abcPreview?.setFont(fontWidget(this)?.value);
      return result;
    };
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (output, ...args) {
      const result = onExecuted?.call(this, output, ...args);
      this.abcPreview?.setAbc((output?.abc ?? []).join("\n"));
      return result;
    };
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      this.abcPreview?.destroy();
      return onRemoved?.apply(this, args);
    };
  },
});
