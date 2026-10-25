"""Portable optional soundfont selections, without importing ComfyUI."""

from pathlib import PurePosixPath

NONE = "(none)"
PREFERRED = "GeneralUser-GS.sf2"


def filename(name):
    return PurePosixPath(name.replace("\\", "/")).name


def resolve(name, available):
    """Prefer an exact installed path, then the same filename in any subfolder."""
    if not isinstance(name, str) or name == NONE:
        return None
    if name in available:
        return name
    wanted = filename(name)
    return next((entry for entry in available if filename(entry) == wanted), None)


def choices(available):
    # Keep the optional preferred file valid even when not installed. This avoids
    # a missing-required-model warning when opening a workflow that names it.
    return [NONE, *sorted({PREFERRED, *available})]
