"""Nominal timing of an ABC score: total duration and its sections.

Timing follows the first voice: its bars, each lasting one measure of the
current meter at the current tempo. ``Z``/``Z4`` rests count as one or four
bars, and other voices are skipped. Each ``% name`` comment line starts a
section, as in YuE2's scores, which write one block per voice for every
group of bars.

Kept free of ComfyUI imports so it can be tested on its own.
"""

import re
from fractions import Fraction

FIELD = re.compile(r"^([A-Za-z]):(.*)$")
INLINE_FIELD = re.compile(r"\[([A-Za-z]):([^\]]*)\]")
TEMPO = re.compile(r"(?:(\d+)/(\d+)\s*=\s*)?(\d+(?:\.\d+)?)")
BAR_LINE = re.compile(r"::|:?\|+\]?:?|\[\|")
REST_BARS = re.compile(r"^Z(\d*)$")
DEFAULT_TEMPO = 120


def meter(value, current):
    value = value.strip()
    if value in ("C", "C|"):
        return Fraction(1)
    try:
        top, bottom = value.split("/")
        return Fraction(int(top), int(bottom))
    except ValueError:
        return current


def tempo(value):
    """Quarter notes per minute, or None. ``Q:3/8=60`` is 90."""
    match = TEMPO.search(value)
    if not match:
        return None
    beat = Fraction(int(match[1]), int(match[2])) if match[1] else Fraction(1, 4)
    return float(match[3]) * float(beat) * 4


def bars_in(music):
    """Bar contents of one music line, without chord symbols or decorations."""
    music = re.sub(r'"[^"]*"|![^!]*!', "", music.split("%")[0])
    parts = BAR_LINE.split(music)
    return [part.strip() for part in parts if part.strip()]


def parse(abc):
    """Return the score's seconds, bars, tempi, meter, key and sections."""
    state = {"meter": Fraction(1), "tempo": None}
    first_voice = voice = None
    in_body = False
    key = ""
    meters, tempi = [], []
    seconds, bars = 0.0, 0
    sections = [{"label": "", "start": 0.0, "bar": 0}]

    def apply(field, value):
        if field == "M":
            state["meter"] = meter(value, state["meter"])
            if value.strip() not in meters:
                meters.append(value.strip())
        elif field == "Q" and tempo(value):
            state["tempo"] = tempo(value)
            if state["tempo"] not in tempi:
                tempi.append(state["tempo"])

    for line in (abc or "").splitlines():
        line = line.strip()
        if not line or line.startswith("%%"):
            continue
        if line.startswith("%"):
            label = line.lstrip("%").strip()
            if label and in_body:
                sections.append({"label": label, "start": seconds, "bar": bars})
            elif label:
                sections[0]["label"] = label
            continue
        field = FIELD.match(line)
        if field:
            name, value = field[1], field[2]
            if name == "V":
                voice = value.split()[0] if value.split() else ""
                first_voice = voice if first_voice is None else first_voice
            elif name == "K":
                key = key or value.strip()
                # Music before any V: line in the body belongs to the first voice.
                voice = first_voice if not in_body else voice
                in_body = True
            elif voice in (None, first_voice):
                apply(name, value)
            continue
        in_body = True
        inline_voice = re.match(r"\[V:\s*([^\]\s]*)[^\]]*\]", line)
        if inline_voice:
            voice = inline_voice[1]
            first_voice = voice if first_voice is None else first_voice
            line = line[inline_voice.end():]
        if voice not in (None, first_voice):
            continue
        for content in bars_in(line):
            for inline in INLINE_FIELD.finditer(content):
                apply(inline[1], inline[2])
            content = INLINE_FIELD.sub("", content).strip()
            if not content:
                continue
            rest = REST_BARS.match(content)
            count = int(rest[1] or 1) if rest else 1
            bar_seconds = float(state["meter"]) * 4 * 60 / (state["tempo"] or DEFAULT_TEMPO)
            seconds += count * bar_seconds
            bars += count

    # A label right before another one, or before the end, has no bars.
    ends = [section["bar"] for section in sections[1:]] + [bars]
    timeline = [
        {**section, "end": next_start, "bars": end - section["bar"]}
        for section, end, next_start in zip(sections, ends, [s["start"] for s in sections[1:]] + [seconds])
        if end > section["bar"]
    ]
    return {
        "seconds": round(seconds, 3),
        "bars": bars,
        "tempi": tempi or [DEFAULT_TEMPO],
        "tempo_assumed": not tempi,
        "meters": meters or ["4/4"],
        "key": key,
        "sections": [{**s, "start": round(s["start"], 3), "end": round(s["end"], 3)} for s in timeline],
    }
