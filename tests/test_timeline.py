"""Check nominal ABC timing without ComfyUI."""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("abc_timeline", Path(__file__).resolve().parents[1] / "timeline.py")
timeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(timeline)

# The native exporter's layout: one block per voice for each group of bars.
SONG = """X:1
T:
M:4/4
L:1/16
Q:1/4=80
V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
V: Ins clef=treble name="Ins Melody" snm="Inst."
K:F
% intro
V: Vocal
"F"z16|"Bb"z16|
V: Ins
f4g4a8|Z|
% verse
V: Vocal
"F"z4Ac3f3ed3c|"Am"A4z12|Z2|
V: Ins
Z4|z16|
% chorus
% chorus 2
V: Vocal
M:3/4
"F"a12|[Q:1/4=120]"C"g12|
V: Ins
M:3/4
Z2|
"""


class TimelineTests(unittest.TestCase):
    def test_times_the_first_voice_with_meter_and_tempo_changes(self):
        result = timeline.parse(SONG)
        # Six 4/4 bars at 80 BPM, then 3/4 at 80 and at 120 BPM.
        self.assertEqual(result["seconds"], 6 * 3 + 2.25 + 1.5)
        self.assertEqual(result["bars"], 8)
        self.assertEqual(result["tempi"], [80.0, 120.0])
        self.assertFalse(result["tempo_assumed"])
        self.assertEqual(result["meters"], ["4/4", "3/4"])
        self.assertEqual(result["key"], "F")

    def test_sections_follow_comments_and_skip_empty_ones(self):
        self.assertEqual(
            [(s["label"], s["bar"], s["bars"], s["start"], s["end"]) for s in timeline.parse(SONG)["sections"]],
            [("intro", 0, 2, 0.0, 6.0), ("verse", 2, 4, 6.0, 18.0), ("chorus 2", 6, 2, 18.0, 21.75)],
        )

    def test_without_tempo_or_sections(self):
        result = timeline.parse("X:1\nM:3/4\nK:C\nC6|D6|]")
        self.assertEqual((result["seconds"], result["tempi"], result["tempo_assumed"]), (3.0, [120], True))
        self.assertEqual([(s["label"], s["bars"]) for s in result["sections"]], [("", 2)])

    def test_inline_voice_fields(self):
        result = timeline.parse("X:1\nL:1/8\nK:C\n[V:Vocal] C4 z4 | D8 |\n[V:Ins] z8 | z8 | z8 |\n")
        self.assertEqual((result["bars"], result["seconds"]), (2, 4.0))

    def test_empty_score(self):
        result = timeline.parse("")
        self.assertEqual((result["seconds"], result["bars"], result["sections"]), (0.0, 0, []))


if __name__ == "__main__":
    unittest.main()
