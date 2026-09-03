"""Burn big bold captions onto the Nodpilot short UGC video, frame-by-frame.

Timing is aligned to the actual voiceover (AssemblyAI word timestamps).
Reads nodpilot-short-raw.mp4, saves nodpilot-short-final.mp4.
"""
import os, subprocess, math
from PIL import Image, ImageDraw, ImageFont

BASE = "/Users/minchen/Desktop/nod-web/docs/creatify-assets"
SRC = os.path.join(BASE, "nodpilot-wip.mp4")
TMP = "/tmp/nodpilot_frames"
os.makedirs(TMP, exist_ok=True)

W, H = 1080, 1920
FPS = 25
FONT_BIG = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_MID = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

# (start, end, lines, size, y_frac)  times in seconds
CAPS = [
    (0.10, 2.55, ["My boss talks", "faster than I can type."], 96, 0.40),
    (2.70, 4.20, ["So I stopped", "taking notes."], 72, 0.42),
    (7.60, 10.25, ["It catches every decision", "and translates it to my language."], 62, 0.42),
    (10.30, 13.30, ["It hands me", "the summary."], 74, 0.42),
    (13.85, 16.45, ["Miss something?", "Just ask out loud."], 76, 0.42),
    (17.00, 19.15, ["Try Nodpilot —", "it's free."], 96, 0.40),
]

def text_frame(draw, lines, size, y_frac):
    if not lines:
        return
    font = ImageFont.truetype(FONT_BIG, size)
    # measure each line
    lh = int(size * 1.18)
    total_h = lh * len(lines)
    y = int(H * y_frac) - total_h // 2
    for line in lines:
        w = draw.textbbox((0, 0), line, font=font)[2]
        x = (W - w) // 2
        # outline (stroke) then shadow then fill
        draw.text((x+0, y+6), line, font=font, fill=(0, 0, 0))       # shadow
        draw.text((x, y), line, font=font, fill=(255,255,255), stroke_width=int(size*0.06), stroke_fill=(0,0,0))
        y += lh

# get duration
dur = float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",SRC],capture_output=True,text=True).stdout.strip())
nframes = int(math.ceil(dur * FPS))
print(f"duration={dur:.2f}s frames={nframes}")

# extract frames
subprocess.run(["ffmpeg","-y","-v","error","-i",SRC,"-r",str(FPS),os.path.join(TMP,"f_%04d.png")],check=True)
print("extracted")

outv = os.path.join(TMP, "out.mp4")
for i in range(1, nframes+1):
    t = (i-1)/FPS
    im = Image.open(os.path.join(TMP, f"f_{i:04d}.png")).convert("RGB")
    # find active caption
    active = None
    for s,e,lines,size,yf in CAPS:
        if s <= t <= e:
            active = (lines, size, yf); break
    if active:
        draw = ImageDraw.Draw(im)
        text_frame(draw, active[0], active[1], active[2])
        im.save(os.path.join(TMP, f"c_{i:04d}.png"))
    else:
        im.save(os.path.join(TMP, f"c_{i:04d}.png"))
subprocess.run(["ffmpeg","-y","-v","error","-framerate",str(FPS),"-i",os.path.join(TMP,"c_%04d.png"),"-c:v","libx264","-crf","19","-preset","fast","-pix_fmt","yuv420p",outv],check=True)
print("rendered captioned video")

# mux with original audio
final = os.path.join(BASE, "nodpilot-short-final.mp4")
subprocess.run(["ffmpeg","-y","-v","error","-i",outv,"-i",SRC,"-map","0:v","-map","1:a","-c:v","libx264","-crf","19","-preset","fast","-c:a","copy","-shortest",final],check=True)
print("saved", final, os.path.getsize(final))
