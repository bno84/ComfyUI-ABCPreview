"""ABC sheet-music preview with optional playback from a user-supplied SoundFont."""

import asyncio
import base64
import os
import threading
from collections import OrderedDict
from pathlib import Path

import folder_paths
from aiohttp import web
from comfy_api.latest import ComfyExtension, io
from server import PromptServer

from .soundfont import GM_INSTRUMENTS, SoundFont, note_to_midi, to_wav
from .soundfont_files import NONE, choices, resolve
from .timeline import parse as score_timeline

WEB_DIRECTORY = "./web"
RATE = 22050
SECONDS = 6.0
VENDOR = Path(__file__).parent / "vendor" / "abcjs"
VENDOR_FILES = {"abcjs-basic-min.js": "application/javascript", "abcjs-audio.css": "text/css"}

# Users supply their own .sf2 files; none are bundled or downloaded.
folder_paths.add_model_folder_path("soundfonts", os.path.join(folder_paths.models_dir, "soundfonts"), is_default=True)
_paths, _ = folder_paths.folder_names_and_paths["soundfonts"]
folder_paths.folder_names_and_paths["soundfonts"] = (_paths, {".sf2"})


def soundfont_names():
    return folder_paths.get_filename_list("soundfonts")


class ABCPreview(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="bno84.ABCPreview",
            display_name="ABC Preview (Sheet Music + Playback)",
            category="audio/ABC",
            description="Render an ABC score as sheet music with highlighted source. Optional browser playback "
                        "uses a user-supplied .sf2 from models/soundfonts; it previews notes, not the final song.",
            inputs=[
                io.String.Input("abc", force_input=True),
                io.Combo.Input("soundfont", options=choices(soundfont_names()), default=NONE,
                               tooltip="Playback only; matches the filename in soundfont subfolders too. Missing fonts leave notation available."),
            ],
            is_output_node=True,
        )

    @classmethod
    def validate_inputs(cls, soundfont, **kwargs):
        # Playback is optional: a workflow naming a font this machine lacks still runs.
        return True

    @classmethod
    def execute(cls, abc, soundfont):
        return io.NodeOutput(ui={"abc": [abc]})


class ABCTimeline(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="bno84.ABCTimeline",
            display_name="ABC Timeline (Duration + Sections)",
            category="audio/ABC",
            description="Show how long an ABC score plays at its own tempo and meter, with its % comment "
                        "sections as proportional blocks. Rendered audio can end earlier or run on.",
            inputs=[io.String.Input("abc", force_input=True)],
            outputs=[io.Float.Output("seconds", tooltip="The score's nominal duration in seconds.")],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, abc):
        timeline = score_timeline(abc)
        return io.NodeOutput(timeline["seconds"], ui={"abc_timeline": [timeline]})


class ABCPreviewExtension(ComfyExtension):
    async def get_node_list(self):
        return [ABCPreview, ABCTimeline]


async def comfy_entrypoint():
    return ABCPreviewExtension()


_fonts = {}
_notes = OrderedDict()
_lock = threading.Lock()
_MAX_NOTES = 256  # About 70 MB of 6-second mono notes.


def _decode_name(token):
    try:
        return base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


def _render(path, instrument, key):
    stat = os.stat(path)
    cache_key = (path, stat.st_size, stat.st_mtime_ns, instrument, key)
    with _lock:
        if cache_key in _notes:
            _notes.move_to_end(cache_key)
            return _notes[cache_key]
        font_key = (path, stat.st_size, stat.st_mtime_ns)
        font = _fonts.get(path)
        if font is None or font[0] != font_key:
            font = _fonts[path] = (font_key, SoundFont(path))
    data = to_wav(font[1].render(instrument, key, RATE, SECONDS), RATE)
    with _lock:
        _notes[cache_key] = data
        while len(_notes) > _MAX_NOTES:
            _notes.popitem(last=False)
    return data


routes = PromptServer.instance.routes


@routes.post("/bno84/abcpreview/timeline")
async def preview_timeline(request):
    try:
        body = await request.json()
        abc = body["abc"]
        if not isinstance(abc, str):
            raise ValueError("ABC must be text.")
        return web.json_response(score_timeline(abc))
    except (ValueError, KeyError, TypeError) as error:
        return web.json_response({"error": str(error)}, status=400)


@routes.get("/bno84/abcpreview/soundfonts")
async def list_soundfonts(request):
    available = soundfont_names()
    return web.json_response({"soundfonts": available, "resolved": resolve(request.query.get("name"), available)})


@routes.get("/bno84/abcpreview/soundfont/{token}/{instrument}-mp3/{note}.mp3")
async def soundfont_note(request):
    # abcjs requests <instrument>-mp3/<note>.mp3; it decodes by content, so WAV is fine.
    name = resolve(_decode_name(request.match_info["token"]), soundfont_names())
    if name is None:
        raise web.HTTPNotFound(text="Unknown soundfont.")
    instrument = request.match_info["instrument"]
    if instrument not in GM_INSTRUMENTS:
        raise web.HTTPNotFound(text="Unknown instrument.")
    try:
        key = note_to_midi(request.match_info["note"])
    except ValueError as error:
        raise web.HTTPNotFound(text=str(error))
    path = folder_paths.get_full_path_or_raise("soundfonts", name)
    try:
        data = await asyncio.to_thread(_render, path, GM_INSTRUMENTS.index(instrument), key)
    except (OSError, ValueError) as error:
        raise web.HTTPUnprocessableEntity(text=f"Cannot render {name}: {error}")
    return web.Response(body=data, content_type="audio/wav", headers={"Cache-Control": "no-cache"})


@routes.get("/bno84/abcpreview/abcjs/{name}")
async def abcjs_file(request):
    # Served outside WEB_DIRECTORY: ComfyUI would import every web/*.js as a module.
    name = request.match_info["name"]
    if name not in VENDOR_FILES:
        raise web.HTTPNotFound()
    return web.FileResponse(VENDOR / name, headers={"Content-Type": VENDOR_FILES[name]})
