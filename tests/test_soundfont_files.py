"""Resolve optional soundfonts without ComfyUI or audio dependencies."""
import hashlib
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "soundfont_files", Path(__file__).resolve().parents[1] / "soundfont_files.py")
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class SoundfontFilesTests(unittest.TestCase):
    def test_exact_path_wins_over_matching_filename(self):
        available = ['other/piano.sf2', 'preferred/piano.sf2']
        self.assertEqual(files.resolve('preferred/piano.sf2', available), 'preferred/piano.sf2')

    def test_bare_name_and_old_path_find_subfolder(self):
        for name in ['piano.sf2', 'old/piano.sf2', 'old\\piano.sf2']:
            self.assertEqual(files.resolve(name, ['new/piano.sf2']), 'new/piano.sf2')

    def test_missing_font_does_not_choose_another(self):
        self.assertIsNone(files.resolve('piano.sf2', ['organ.sf2']))

    def test_none_is_explicitly_off(self):
        self.assertIsNone(files.resolve(files.NONE, [files.PREFERRED]))
        self.assertIsNone(files.resolve(None, [files.PREFERRED]))

    def test_preferred_optional_choice_stays_listed_when_missing(self):
        self.assertEqual(files.choices([]), [files.NONE, files.PREFERRED])

    def test_installed_choices_are_sorted_without_duplicates(self):
        self.assertEqual(files.choices(['z.sf2', files.PREFERRED, 'sub/piano.sf2']),
                         [files.NONE, files.PREFERRED, 'sub/piano.sf2', 'z.sf2'])


class ContentIdTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.cache = {}

    def tearDown(self):
        self.folder.cleanup()

    def font(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return str(path)

    def test_id_is_the_sha256_and_follows_content_changes(self):
        path = self.font("piano.sf2", b"first")
        self.assertEqual(files.content_id(path, self.cache), hashlib.sha256(b"first").hexdigest())
        Path(path).write_bytes(b"second, longer")
        self.assertEqual(files.content_id(path, self.cache), hashlib.sha256(b"second, longer").hexdigest())

    def test_unchanged_files_are_not_read_again(self):
        path = self.font("piano.sf2", b"first")
        stat = os.stat(path)
        self.cache[path] = (stat.st_size, stat.st_mtime_ns, "cached")
        self.assertEqual(files.content_id(path, self.cache), "cached")

    def test_finds_content_under_any_name_and_rejects_other_ids(self):
        organ = self.font("organ.sf2", b"organ")
        copy = self.font("sub/renamed.sf2", b"piano")
        wanted = hashlib.sha256(b"piano").hexdigest()
        self.assertEqual(files.find_content(wanted, [organ, copy], self.cache), copy)
        missing = str(self.root / "gone.sf2")
        self.assertEqual(files.find_content(wanted, [missing, copy], self.cache), copy)
        for other in (hashlib.sha256(b"x").hexdigest(), "../piano.sf2", wanted.upper(), wanted[:-1], None):
            self.assertIsNone(files.find_content(other, [organ, copy], self.cache))

