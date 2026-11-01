"""Portable optional soundfont selections, without importing ComfyUI."""

import hashlib
import os
import re
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


# Playback URLs name a soundfont by its content: a SHA-256 of the file. Another
# file name or subfolder shares the ID, and changed content gets a new one.
CONTENT_ID = re.compile(r"[0-9a-f]{64}")


def content_id(path, cache):
    """SHA-256 of a file, rehashed only when its size or modification time changes."""
    stat = os.stat(path)
    cached = cache.get(path)
    if cached and cached[:2] == (stat.st_size, stat.st_mtime_ns):
        return cached[2]
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            digest.update(chunk)
    cache[path] = (stat.st_size, stat.st_mtime_ns, digest.hexdigest())
    return cache[path][2]


def find_content(wanted, paths, cache):
    """The first path whose content has this ID, or None."""
    if not CONTENT_ID.fullmatch(wanted or ""):
        return None
    for path in paths:
        try:
            if content_id(path, cache) == wanted:
                return path
        except OSError:
            continue
    return None
