"""Resolve optional soundfonts without ComfyUI or audio dependencies."""
import importlib.util
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
