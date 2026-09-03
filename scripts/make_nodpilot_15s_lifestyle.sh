#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/minchen/Desktop/nod-web"
ASSETS="$ROOT/docs/creatify-assets"
OUT_DIR="$ASSETS/exports"
TMP_DIR="$(mktemp -d /tmp/nodpilot-15s.XXXXXX)"
OUT="$OUT_DIR/nodpilot-15s-lifestyle-reel.mp4"

mkdir -p "$OUT_DIR"

# Reuse the approved 14.9-second English voiceover from the existing Nodpilot cut.
ffmpeg -y -v error \
  -i "$ASSETS/nodpilot-pov-voiced.mp4" \
  -vn -c:a aac -b:a 192k "$TMP_DIR/voice.m4a"

FONT="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
PYTHON="/Users/minchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"

"$PYTHON" - "$TMP_DIR" "$FONT" <<'PY'
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1])
font_path = sys.argv[2]

def layer(name, headline, sub="AI listening assistant", pink=False):
    im = Image.new("RGBA", (1080, 1920), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 1080, 190), fill=(0, 0, 0, 78))
    d.rectangle((0, 1450, 1080, 1920), fill=(0, 0, 0, 140))
    d.text((46, 52), "Nodpilot", font=ImageFont.truetype(font_path, 34), fill="white")
    f = ImageFont.truetype(font_path, 82 if len(headline) < 19 else 70)
    box = d.textbbox((0, 0), headline, font=f, stroke_width=5)
    d.text(((1080-(box[2]-box[0]))/2, 1210), headline, font=f,
           fill=(255,77,141) if pink else "white", stroke_width=5, stroke_fill="black")
    if pink:
        sf = ImageFont.truetype(font_path, 60)
        sb = d.textbbox((0, 0), "Try Nodpilot", font=sf, stroke_width=4)
        d.text(((1080-(sb[2]-sb[0]))/2, 1320), "Try Nodpilot", font=sf,
               fill="white", stroke_width=4, stroke_fill="black")
    sf = ImageFont.truetype(font_path, 38)
    sb = d.textbbox((0, 0), sub, font=sf)
    d.text(((1080-(sb[2]-sb[0]))/2, 1530), sub, font=sf, fill="white")
    im.save(out / f"{name}.png")

layer("c1", "STOP TYPING NOTES")
layer("c2", "IT CATCHES EVERY WORD")
layer("c3", "DECISIONS + ACTIONS")
layer("c4", "JUST ASK OUT LOUD")
layer("c5", "FREE IN BETA", pink=True)
PY

ffmpeg -y -v error \
  -loop 1 -t 3.75 -i "$ASSETS/pov-scenes/nod-pov-01-meeting-watch.png" \
  -loop 1 -t 3.75 -i "$ASSETS/pov-scenes/nod-pov-02-watch-live.png" \
  -loop 1 -t 3.75 -i "$ASSETS/pov-scenes/nod-pov-03-hallway-phone.png" \
  -loop 1 -t 3.75 -i "$ASSETS/pov-scenes/nod-pov-04-phone-summary.png" \
  -i "$TMP_DIR/voice.m4a" \
  -f lavfi -t 15 -i "anullsrc=r=48000:cl=stereo" \
  -loop 1 -t 15 -i "$TMP_DIR/c1.png" \
  -loop 1 -t 15 -i "$TMP_DIR/c2.png" \
  -loop 1 -t 15 -i "$TMP_DIR/c3.png" \
  -loop 1 -t 15 -i "$TMP_DIR/c4.png" \
  -loop 1 -t 15 -i "$TMP_DIR/c5.png" \
  -filter_complex "
    [0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v0];
    [1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v1];
    [2:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v2];
    [3:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v3];
    [v0][v1][v2][v3]concat=n=4:v=1:a=0[base];
    [base][6:v]overlay=0:0:enable='between(t,0,3.5)'[t1];
    [t1][7:v]overlay=0:0:enable='between(t,3.5,6.2)'[t2];
    [t2][8:v]overlay=0:0:enable='between(t,6.2,10.4)'[t3];
    [t3][9:v]overlay=0:0:enable='between(t,10.4,13.0)'[t4];
    [t4][10:v]overlay=0:0:enable='between(t,13.0,15)',format=yuv420p[v];
    [4:a]apad=pad_dur=15,atrim=0:15[vo];
    [5:a]volume=0[silence];
    [vo][silence]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[a]
  " \
  -map "[v]" -map "[a]" \
  -t 15 -r 25 \
  -c:v libx264 -preset medium -crf 18 \
  -c:a aac -b:a 192k \
  -movflags +faststart \
  "$OUT"

echo "$OUT"
