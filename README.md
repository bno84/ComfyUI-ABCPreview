# ComfyUI-ABCPreview

![ABC Preview node during playback: sheet music above the highlighted ABC source, with the sounding note in red in both](docs/abc-preview.png)

**ABC Preview (Sheet Music + Playback)** shows an ABC score in a node:

- sheet music rendered with [abcjs](https://github.com/paulrosen/abcjs);
- the ABC source with syntax highlighting;
- click a note in either view to locate it in the other;
- optional playback with play/pause, seek, loop, tempo, chords on/off, and
  notes highlighted in both views as they sound;
- **Expand** opens a larger side-by-side view (Esc or Close returns).

The node is a leaf output: connect any `STRING` with ABC. The view updates
after the node executes; it is a read-only preview, not an editor.

## Install

- **ComfyUI-Manager:** search for _ABC Preview_ (Registry ID
  `comfyui-abcpreview`) and install it.
- **comfy-cli:** `comfy node install comfyui-abcpreview`.
- **Manually:** `git clone https://github.com/bno84/ComfyUI-ABCPreview` into
  `ComfyUI/custom_nodes/`.

Then restart ComfyUI. Requires ComfyUI 0.38.0 or newer; no extra Python
packages.

## Playback needs a user-supplied soundfont

No sounds are bundled or downloaded.
Notation still works without a soundfont but playback stays disabled.

Put a General MIDI `.sf2` file in `ComfyUI/models/soundfonts/`
(or a `soundfonts:` entry in `extra_model_paths.yaml`), refresh the browser,
and choose it.

## Vendored code

`vendor/abcjs/` holds [abcjs 6.7.2 from npm](https://www.npmjs.com/package/abcjs/v/6.7.2)
MIT © Paul Rosen and Gregory Dyke
See `vendor/abcjs/LICENSE.md`.

## Tests

```bash
node --test tests/test_abc_preview.mjs     # tokenizer and extension wiring
python3 -m unittest discover -s tests      # renderer; needs numpy
```
