#!/usr/bin/env python3
"""Rebuild sounds.js from Kenney's CC0 sound packs.

The sounds are embedded in the page as base64 data URIs rather than kept as
files, because Chrome will not fetch audio over file:// and the game has to
keep working when index.html is opened straight from the folder. They are
converted from Kenney's .ogg to MP3 on the way in, because MP3 is the one
format every phone's browser plays -- older iPhones cannot decode .ogg at all.
Needs ffmpeg.

Get the packs first (the `sfx` CLI downloads them into ./audio/packs, so run it
from /tmp/audio or move them there afterwards):

    sfx pack interface-sounds && sfx pack ui-audio && sfx pack impact-sounds && sfx pack music-jingles

then, from the repo root:

    python3 tools/build_sounds.py

All of Kenney's packs are CC0 -- public domain, no attribution required, safe
to sell. To change a sound, swap its file below and re-run.
"""

import base64
import json
import os
import subprocess
import sys

PACKS = os.environ.get("SFX_PACKS", "/tmp/audio/packs")
SAX = "music-jingles/Audio/Sax jingles/jingles_SAX%s.ogg"

# name: (file, volume, [lowest, highest] playback rate)
# A game show wants a band, so the jingles are Kenney's saxophone set, chosen by
# measuring the melody rather than by ear: TRUTH climbs 10 semitones, a LIE
# falls 10, a player joining climbs 7. The final fanfare is an orchestral hit
# that climbs 10. The drum roll is one soft thud played fourteen times, getting
# louder, at a slightly different pitch each time.
PICKS = {
    "click":   ("ui-audio/Audio/click3.ogg",                     0.40, [0.95, 1.08]),  # any button
    "pop":     ("interface-sounds/Audio/pluck_002.ogg",          0.55, [0.92, 1.10]),  # an answer handed in
    "hit":     ("impact-sounds/Audio/impactSoft_medium_000.ogg", 0.55, [0.90, 1.10]),  # one beat of the drum roll
    "join":    (SAX % "16",                                      0.55, [1.00, 1.00]),  # a player joins the room
    "fanfare": (SAX % "04",                                      0.60, [1.00, 1.00]),  # the show starts
    "ding":    (SAX % "02",                                      0.65, [1.00, 1.00]),  # the answer was the TRUTH
    "wah":     (SAX % "01",                                      0.65, [1.00, 1.00]),  # the answer was a LIE
    "win":     ("music-jingles/Audio/Hit jingles/jingles_HIT15.ogg", 0.70, [1.00, 1.00]),  # the winner
}

HEADER = """/* The sound bank, carried in the page.

   Kenney's CC0 packs -- "Interface Sounds", "UI Audio", "Impact Sounds" and "Music Jingles" -- public
   domain, no attribution required, safe to sell. Embedded as base64 because
   Chrome will not fetch audio over file://, and opening index.html straight
   from the folder has to keep working.

   fx.js loads these into Phaser's sound manager and plays them through
   WebAudio. Regenerate with tools/build_sounds.py after changing the picks. */

"""


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "sounds.js")
    missing = [f for f, _, _ in PICKS.values() if not os.path.exists(os.path.join(PACKS, f))]
    if missing:
        print("Missing under %s:\n  %s" % (PACKS, "\n  ".join(missing)), file=sys.stderr)
        return 1

    spec = {k: {"volume": v, "rate": r} for k, (_, v, r) in PICKS.items()}
    parts = [HEADER, "const SOUND_SPEC = %s;\n\nconst SOUND_BANK = {\n" % json.dumps(spec)]
    for key, (rel, _, _) in PICKS.items():
        mp3 = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", os.path.join(PACKS, rel),
             "-ac", "1", "-ar", "44100", "-b:a", "96k", "-f", "mp3", "-"],
            capture_output=True, check=True).stdout
        data = base64.b64encode(mp3).decode()
        parts.append("  /* %s */\n  %s: 'data:audio/mpeg;base64,%s',\n" % (os.path.basename(rel), key, data))
    parts.append("};\n")
    with open(out, "w") as f:
        f.write("".join(parts))
    print("wrote %s  (%.0f KB, %d sounds)" % (out, os.path.getsize(out) / 1024, len(PICKS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
