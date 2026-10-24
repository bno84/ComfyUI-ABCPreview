"""Render notes from a synthetic SoundFont; needs numpy, not ComfyUI."""

import importlib.util
import io
import struct
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location(
    "abc_soundfont", Path(__file__).resolve().parents[1] / "soundfont.py"
)
sf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sf)

RATE = 22050


def chunk(name, data):
    return name + struct.pack("<I", len(data)) + data + b"\0" * (len(data) & 1)


def riff_list(kind, *chunks):
    return chunk(b"LIST", kind + b"".join(chunks))


def build_sf2(path, samples, headers, presets, instruments):
    """presets/instruments: [(name, header_fields, [zone generator lists])]."""
    def table(entries, header_fmt, bag_terminal):
        heads, bags, gens = b"", b"", b""
        bag_count = gen_count = 0
        for name, fields, zones in entries:
            heads += struct.pack(header_fmt, name.encode().ljust(20, b"\0"), *fields, bag_count)
            for zone in zones:
                bags += struct.pack("<HH", gen_count, 0)
                for op, amount in zone:
                    gens += struct.pack("<HH", op, amount & 0xFFFF)
                    gen_count += 1
                bag_count += 1
        heads += struct.pack(header_fmt, bag_terminal.encode().ljust(20, b"\0"), *([0] * (header_fmt.count("H") - 1)), bag_count)
        bags += struct.pack("<HH", gen_count, 0)
        gens += struct.pack("<HH", 0, 0)
        return heads, bags, gens

    phdr, pbag, pgen = table([(n, f, z) for n, f, z in presets], "<20sHHH", "EOP")
    phdr = b"".join(phdr[i:i + 26] + b"\0" * 12 for i in range(0, len(phdr), 26))
    inst, ibag, igen = table(instruments, "<20sH", "EOI")
    shdr = b"".join(struct.pack("<20sIIIIIBbHH", name.encode().ljust(20, b"\0"), *fields) for name, fields in headers)
    shdr += struct.pack("<20sIIIIIBbHH", b"EOS".ljust(20, b"\0"), 0, 0, 0, 0, 0, 0, 0, 0, 0)
    body = (b"sfbk"
            + riff_list(b"INFO", chunk(b"ifil", struct.pack("<HH", 2, 1)))
            + riff_list(b"sdta", chunk(b"smpl", samples.astype("<i2").tobytes()))
            + riff_list(b"pdta", chunk(b"phdr", phdr), chunk(b"pbag", pbag), chunk(b"pmod", b"\0" * 10),
                        chunk(b"pgen", pgen), chunk(b"inst", inst), chunk(b"ibag", ibag),
                        chunk(b"imod", b"\0" * 10), chunk(b"igen", igen), chunk(b"shdr", shdr)))
    Path(path).write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)


def frequency(audio):
    audio = audio[RATE // 2:RATE * 3 // 2]
    spectrum = np.abs(np.fft.rfft(audio * np.hanning(len(audio)), n=1 << 18))
    return np.argmax(spectrum) * RATE / (1 << 18)


class SoundFontTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        rate = 44100
        # A looping 440 Hz sine (about 100 periods per loop), then a short decaying drum hit.
        sine = (np.sin(2 * np.pi * 440 * np.arange(rate) / rate) * 16000).astype(np.int16)
        drum = (np.random.default_rng(1).uniform(-1, 1, 2000) * np.linspace(16000, 0, 2000)).astype(np.int16)
        samples = np.concatenate([sine, np.zeros(46, np.int16), drum, np.zeros(46, np.int16)])
        loop_end = 100 * rate // 440
        drum_start = len(sine) + 46
        headers = [
            ("sine", (0, len(sine), 1000, 1000 + loop_end, rate, 69, 0, 0, 1)),
            ("drum", (drum_start, drum_start + 2000, drum_start, drum_start + 1999, rate, 60, 0, 0, 1)),
        ]
        instruments = [
            # Global zone: attenuation 6 dB; local zone loops the sine.
            ("sine", (), [[(sf.ATTENUATION, 60)], [(sf.KEY_RANGE, 0 | 127 << 8), (sf.SAMPLE_MODES, 1), (sf.SAMPLE_ID, 0)]]),
            ("drum", (), [[(sf.KEY_RANGE, 35 | 81 << 8), (sf.SAMPLE_ID, 1)]]),
        ]
        presets = [
            ("piano", (0, 0), [[(sf.INSTRUMENT, 0)]]),
            ("strings", (48, 0), [[(sf.COARSE_TUNE, 12), (sf.INSTRUMENT, 0)]]),
            ("kit", (0, 128), [[(sf.INSTRUMENT, 1)]]),
        ]
        cls.path = Path(cls.directory.name) / "test.sf2"
        build_sf2(cls.path, samples, headers, presets, instruments)
        cls.font = sf.SoundFont(cls.path)

    @classmethod
    def tearDownClass(cls):
        del cls.font
        cls.directory.cleanup()

    def test_note_names_match_abcjs(self):
        self.assertEqual(sf.note_to_midi("A0"), 21)
        self.assertEqual(sf.note_to_midi("C4"), 60)
        self.assertEqual(sf.note_to_midi("Db4"), 61)
        self.assertEqual(sf.note_to_midi("Bb7"), 106)
        for bad in ("H4", "C", "C#4", "C10", ""):
            with self.assertRaises(ValueError):
                sf.note_to_midi(bad)

    def test_instrument_names_follow_general_midi(self):
        self.assertEqual(len(sf.GM_INSTRUMENTS), 129)
        self.assertEqual(sf.GM_INSTRUMENTS.index("string_ensemble_1"), 48)
        self.assertEqual(sf.GM_INSTRUMENTS[sf.PERCUSSION], "percussion")

    def test_pitch_follows_key_and_loop_sustains(self):
        audio = self.font.render(0, 81, RATE)  # A5: one octave above the root key.
        self.assertAlmostEqual(frequency(audio), 880, delta=3)
        # Without the loop the one-second sample would end; it must still sound at 5 s.
        tail = audio[5 * RATE:int(5.5 * RATE)]
        self.assertGreater(np.sqrt(np.mean(tail ** 2)), 0.1)

    def test_attenuation_and_preset_tuning(self):
        audio = self.font.render(0, 69, RATE)
        # 60 cB * 0.4 = 2.4 dB below the 16000/32768 source amplitude.
        self.assertAlmostEqual(float(np.max(np.abs(audio[:RATE]))), 16000 / 32768 * 10 ** (-2.4 / 20), delta=0.01)
        self.assertAlmostEqual(frequency(self.font.render(48, 69, RATE)), 880, delta=3)

    def test_missing_program_falls_back_to_piano(self):
        self.assertAlmostEqual(frequency(self.font.render(40, 69, RATE)), 440, delta=2)

    def test_percussion_uses_bank_128_and_does_not_loop(self):
        audio = self.font.render(sf.PERCUSSION, 38, RATE)
        self.assertGreater(np.max(np.abs(audio[:500])), 0.05)
        self.assertEqual(float(np.max(np.abs(audio[RATE:]))), 0.0)
        silent = self.font.render(sf.PERCUSSION, 90, RATE)  # Outside the kit's key range.
        self.assertEqual(float(np.max(np.abs(silent))), 0.0)

    def test_wav_is_mono_16_bit_and_limited(self):
        data = sf.to_wav(np.array([0.0, 2.0, -2.0], dtype=np.float32), RATE)
        with wave.open(io.BytesIO(data)) as handle:
            self.assertEqual((handle.getnchannels(), handle.getsampwidth(), handle.getframerate()), (1, 2, RATE))
            frames = np.frombuffer(handle.readframes(3), "<i2")
        self.assertEqual(frames.tolist(), [0, 32439, -32439])

    def test_rejects_non_soundfonts(self):
        path = Path(self.directory.name) / "bad.sf2"
        path.write_bytes(b"RIFF\4\0\0\0WAVE")
        with self.assertRaises(ValueError):
            sf.SoundFont(path)


if __name__ == "__main__":
    unittest.main()
