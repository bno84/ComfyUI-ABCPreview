"""Minimal SoundFont 2 note renderer for ABC preview playback.

Renders one General MIDI preset note at a fixed velocity, held for a fixed
time: sample zones, root key and tuning, loops, attenuation, and the volume
envelope. Filters, modulators, LFOs, the modulation envelope, reverb/chorus,
and stereo placement are ignored. This previews pitch and rhythm only.
"""

import io
import struct
import wave

import numpy as np

# abcjs instrument names, in General MIDI program order; abcjs requests
# "<name>-mp3/<note>.mp3" relative to its soundfont URL. "percussion" is
# abcjs's name for the GM drum kit.
GM_INSTRUMENTS = (
    "acoustic_grand_piano", "bright_acoustic_piano", "electric_grand_piano", "honkytonk_piano",
    "electric_piano_1", "electric_piano_2", "harpsichord", "clavinet", "celesta", "glockenspiel",
    "music_box", "vibraphone", "marimba", "xylophone", "tubular_bells", "dulcimer", "drawbar_organ",
    "percussive_organ", "rock_organ", "church_organ", "reed_organ", "accordion", "harmonica",
    "tango_accordion", "acoustic_guitar_nylon", "acoustic_guitar_steel", "electric_guitar_jazz",
    "electric_guitar_clean", "electric_guitar_muted", "overdriven_guitar", "distortion_guitar",
    "guitar_harmonics", "acoustic_bass", "electric_bass_finger", "electric_bass_pick",
    "fretless_bass", "slap_bass_1", "slap_bass_2", "synth_bass_1", "synth_bass_2", "violin", "viola",
    "cello", "contrabass", "tremolo_strings", "pizzicato_strings", "orchestral_harp", "timpani",
    "string_ensemble_1", "string_ensemble_2", "synth_strings_1", "synth_strings_2", "choir_aahs",
    "voice_oohs", "synth_choir", "orchestra_hit", "trumpet", "trombone", "tuba", "muted_trumpet",
    "french_horn", "brass_section", "synth_brass_1", "synth_brass_2", "soprano_sax", "alto_sax",
    "tenor_sax", "baritone_sax", "oboe", "english_horn", "bassoon", "clarinet", "piccolo", "flute",
    "recorder", "pan_flute", "blown_bottle", "shakuhachi", "whistle", "ocarina", "lead_1_square",
    "lead_2_sawtooth", "lead_3_calliope", "lead_4_chiff", "lead_5_charang", "lead_6_voice",
    "lead_7_fifths", "lead_8_bass_lead", "pad_1_new_age", "pad_2_warm", "pad_3_polysynth",
    "pad_4_choir", "pad_5_bowed", "pad_6_metallic", "pad_7_halo", "pad_8_sweep", "fx_1_rain",
    "fx_2_soundtrack", "fx_3_crystal", "fx_4_atmosphere", "fx_5_brightness", "fx_6_goblins",
    "fx_7_echoes", "fx_8_scifi", "sitar", "banjo", "shamisen", "koto", "kalimba", "bagpipe", "fiddle",
    "shanai", "tinkle_bell", "agogo", "steel_drums", "woodblock", "taiko_drum", "melodic_tom",
    "synth_drum", "reverse_cymbal", "guitar_fret_noise", "breath_noise", "seashore", "bird_tweet",
    "telephone_ring", "helicopter", "applause", "gunshot", "percussion",
)
PERCUSSION = len(GM_INSTRUMENTS) - 1

_SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# Generator operators used here (SoundFont 2.04, section 8.1.2).
START, END, LOOP_START, LOOP_END, START_COARSE = 0, 1, 2, 3, 4
END_COARSE = 12
DELAY, ATTACK, HOLD, DECAY, SUSTAIN, RELEASE = 33, 34, 35, 36, 37, 38
KEY_TO_HOLD, KEY_TO_DECAY = 39, 40
INSTRUMENT, KEY_RANGE, VEL_RANGE = 41, 43, 44
LOOP_START_COARSE, KEYNUM, ATTENUATION, LOOP_END_COARSE = 45, 46, 48, 50
COARSE_TUNE, FINE_TUNE, SAMPLE_ID, SAMPLE_MODES = 51, 52, 53, 54
SCALE_TUNING, ROOT_KEY = 56, 58
_UNSIGNED = {KEY_RANGE, VEL_RANGE, INSTRUMENT, SAMPLE_ID, SAMPLE_MODES}
# Preset-level values add to instrument-level values for these generators.
_ADDITIVE = {DELAY, ATTACK, HOLD, DECAY, SUSTAIN, RELEASE, KEY_TO_HOLD, KEY_TO_DECAY,
             ATTENUATION, COARSE_TUNE, FINE_TUNE, SCALE_TUNING}
_DEFAULTS = {DELAY: -12000, ATTACK: -12000, HOLD: -12000, DECAY: -12000, RELEASE: -12000,
             SCALE_TUNING: 100}


def note_to_midi(name):
    """Convert an abcjs note name such as C4, Db4, or Bb0 to a MIDI key."""
    letter, rest = name[:1], name[1:]
    flat = rest.startswith("b")
    octave = rest[1:] if flat else rest
    if letter not in _SEMITONES or not octave.lstrip("-").isdigit():
        raise ValueError(f"Unsupported note name: {name}")
    key = 12 * (int(octave) + 1) + _SEMITONES[letter] - flat
    if not 0 <= key <= 127:
        raise ValueError(f"Note outside MIDI range: {name}")
    return key


def _signed(value):
    return value - 0x10000 if value >= 0x8000 else value


def _in_range(gens, gen, value):
    lo_hi = gens.get(gen)
    return lo_hi is None or (lo_hi & 0xFF) <= value <= (lo_hi >> 8)


def _seconds(timecents):
    return 2.0 ** (min(timecents, 8000) / 1200.0)


class SoundFont:
    def __init__(self, path):
        self.path = path
        chunks = {}
        with open(path, "rb") as handle:
            riff, size, form = struct.unpack("<4sI4s", handle.read(12))
            if riff != b"RIFF" or form != b"sfbk":
                raise ValueError("Not a SoundFont 2 file.")
            end = 8 + size
            while handle.tell() + 8 <= end:
                chunk_id, chunk_size = struct.unpack("<4sI", handle.read(8))
                body_start = handle.tell()
                if chunk_id == b"LIST":
                    list_end = body_start + chunk_size
                    handle.read(4)
                    while handle.tell() + 8 <= list_end:
                        sub_id, sub_size = struct.unpack("<4sI", handle.read(8))
                        offset = handle.tell()
                        if sub_id == b"smpl":
                            chunks[sub_id] = (offset, sub_size)
                        elif sub_id in (b"phdr", b"pbag", b"pgen", b"inst", b"ibag", b"igen", b"shdr"):
                            chunks[sub_id] = handle.read(sub_size)
                        handle.seek(offset + sub_size + (sub_size & 1))
                handle.seek(body_start + chunk_size + (chunk_size & 1))
        missing = {b"smpl", b"phdr", b"pbag", b"pgen", b"inst", b"ibag", b"igen", b"shdr"} - chunks.keys()
        if missing:
            # SF3 stores compressed samples; only plain 16-bit SF2 is supported.
            raise ValueError("Unsupported or incomplete SoundFont: missing " + ", ".join(sorted(m.decode() for m in missing)))
        offset, size = chunks[b"smpl"]
        self.samples = np.memmap(path, dtype="<i2", mode="r", offset=offset, shape=(size // 2,))
        records = lambda name, fmt: list(struct.iter_unpack(fmt, chunks[name][: len(chunks[name]) // struct.calcsize(fmt) * struct.calcsize(fmt)]))
        self.headers = records(b"shdr", "<20sIIIIIBbHH")
        instruments = self._zones(records(b"inst", "<20sH"), records(b"ibag", "<HH"), records(b"igen", "<HH"), SAMPLE_ID)
        self.instruments = instruments
        presets = records(b"phdr", "<20sHHHIII")
        preset_zones = self._zones([(p[0], p[3]) for p in presets], records(b"pbag", "<HH"), records(b"pgen", "<HH"), INSTRUMENT)
        self.presets = {(bank, program): zones for (_, program, bank, *_), zones in zip(presets, preset_zones)}

    @staticmethod
    def _zones(headers, bags, gens, terminal):
        """Return [(global_gens, [local_gens...])] per header, excluding the terminal record."""
        result = []
        for index in range(len(headers) - 1):
            zones = []
            for bag in range(headers[index][1], headers[index + 1][1]):
                if bag + 1 >= len(bags):
                    break
                zones.append({op: amount for op, amount in gens[bags[bag][0]:bags[bag + 1][0]]})
            global_zone = zones.pop(0) if zones and terminal not in zones[0] else {}
            result.append((global_zone, [zone for zone in zones if terminal in zone]))
        return result

    def preset(self, instrument):
        if instrument == PERCUSSION:
            candidates = [(128, 0)] + sorted(key for key in self.presets if key[0] == 128)
        else:
            candidates = [(0, instrument), (0, 0)]
        for key in candidates:
            if key in self.presets:
                return self.presets[key]
        return next(iter(self.presets.values()))

    def regions(self, instrument, key, velocity):
        preset_global, preset_zones = self.preset(instrument)
        for preset_local in preset_zones:
            preset_gens = {**preset_global, **preset_local}
            if not (_in_range(preset_gens, KEY_RANGE, key) and _in_range(preset_gens, VEL_RANGE, velocity)):
                continue
            if preset_gens[INSTRUMENT] >= len(self.instruments):
                continue
            inst_global, inst_zones = self.instruments[preset_gens[INSTRUMENT]]
            for inst_local in inst_zones:
                gens = {**inst_global, **inst_local}
                if not (_in_range(gens, KEY_RANGE, key) and _in_range(gens, VEL_RANGE, velocity)):
                    continue
                values = {op: (amount if op in _UNSIGNED else _signed(amount)) for op, amount in gens.items()}
                for op in _ADDITIVE:
                    if op in preset_gens:
                        values[op] = values.get(op, _DEFAULTS.get(op, 0)) + _signed(preset_gens[op])
                if values[SAMPLE_ID] < len(self.headers):
                    yield values

    def render(self, instrument, key, rate=22050, seconds=6.0, velocity=100):
        """Return mono float32 audio of one held note; abcjs fades it at note end."""
        frames = int(rate * seconds)
        out = np.zeros(frames, dtype=np.float32)
        for gens in self.regions(instrument, key, velocity):
            out += self._render_region(gens, key, rate, frames)
        return out

    def _render_region(self, gens, key, rate, frames):
        _, start, end, loop_start, loop_end, sample_rate, pitch, correction, _, kind = self.headers[gens[SAMPLE_ID]]
        if kind & 0x8000 or sample_rate == 0:  # ROM samples are not stored in the file.
            return 0.0
        g = lambda op: gens.get(op, _DEFAULTS.get(op, 0))
        start += g(START) + 32768 * g(START_COARSE)
        end += g(END) + 32768 * g(END_COARSE)
        loop_start += g(LOOP_START) + 32768 * g(LOOP_START_COARSE) - start
        loop_end += g(LOOP_END) + 32768 * g(LOOP_END_COARSE) - start
        end = min(end, len(self.samples))
        if end - start < 2 or start < 0:
            return 0.0
        data = np.asarray(self.samples[start:end], dtype=np.float32) / 32768.0
        root = g(ROOT_KEY) if 0 <= gens.get(ROOT_KEY, -1) <= 127 else (pitch if pitch <= 127 else 60)
        played = g(KEYNUM) if 0 <= gens.get(KEYNUM, -1) <= 127 else key
        cents = (played - root) * g(SCALE_TUNING) + 100 * g(COARSE_TUNE) + g(FINE_TUNE) + correction
        step = 2.0 ** (cents / 1200.0) * sample_rate / rate
        position = np.arange(frames, dtype=np.float64) * step
        looped = g(SAMPLE_MODES) & 1 and 0 <= loop_start < loop_end <= len(data) and loop_end - loop_start > 1
        if looped:
            past = position >= loop_end
            position[past] = loop_start + np.mod(position[past] - loop_start, loop_end - loop_start)
        audio = np.interp(position, np.arange(len(data)), data, right=0.0).astype(np.float32)
        gain = 10.0 ** (-max(g(ATTENUATION), 0) * 0.4 / 200.0)  # FluidSynth's EMU 0.4 cB scale.
        return audio * self._envelope(gens, key, rate, frames) * gain

    @staticmethod
    def _envelope(gens, key, rate, frames):
        g = lambda op: gens.get(op, _DEFAULTS.get(op, 0))
        delay = _seconds(g(DELAY))
        attack = _seconds(g(ATTACK))
        hold = _seconds(g(HOLD) + (60 - key) * g(KEY_TO_HOLD))
        decay = _seconds(g(DECAY) + (60 - key) * g(KEY_TO_DECAY))
        sustain_db = -min(max(g(SUSTAIN), 0), 1440) / 10.0
        t = np.arange(frames, dtype=np.float64) / rate
        env = np.zeros(frames)
        attack_end, hold_end = delay + attack, delay + attack + hold
        rising = (t >= delay) & (t < attack_end)
        env[rising] = (t[rising] - delay) / attack
        env[(t >= attack_end) & (t < hold_end)] = 1.0
        # Decay is linear in dB: 100 dB over the decay time, stopping at sustain.
        falling = t >= hold_end
        env[falling] = 10.0 ** (np.maximum(-100.0 * (t[falling] - hold_end) / decay, sustain_db) / 20.0)
        tail = min(frames, int(0.02 * rate))  # Avoid a click at the buffer end.
        env[frames - tail:] *= np.linspace(1.0, 0.0, tail)
        return env.astype(np.float32)


def to_wav(audio, rate):
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0.99:
        audio = audio * (0.99 / peak)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes((audio * 32767).astype("<i2").tobytes())
    return buffer.getvalue()
