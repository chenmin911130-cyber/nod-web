"""Assemble Higgsfield POV clips + HeyGen VO into a 9:16 Nodpilot ad."""
import json, math, os, subprocess
from PIL import Image, ImageDraw, ImageFont

BASE = "/Users/minchen/Desktop/nod-web/docs/creatify-assets"
CLIPS = "/tmp/hf_clips"
TMP = "/tmp/pov_live"
os.makedirs(TMP, exist_ok=True)
os.makedirs(CLIPS, exist_ok=True)

W, H = 1080, 1920
FPS = 25
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
VO = "/tmp/nodpilot_vo.mp3"
if not os.path.exists(VO):
    VO = os.path.join(BASE, "nodpilot-pov-vo.mp3")
OUT = os.path.join(BASE, "nodpilot-pov-live.mp4")
PINK = (255, 77, 141)
WHITE = (255, 255, 255)
INK = (12, 14, 20)

# clip files downloaded as clip_0.mp4 ... (meeting, watch, hallway, cta)
# VO timing from earlier HeyGen timestamps
# 0.14-3.48 talking/listening  -> meeting
# 3.48-6.10 every word         -> watch
# 6.10-10.48 after meeting     -> hallway
# 10.48-15.20 ask / try        -> cta (or summary if present)

CAPS = [
    (0.10, 1.80, ["HE'S TALKING"], ["HE'S TALKING"], -1),
    (1.80, 3.48, ["I'M JUST", "LISTENING"], ["I'M", "JUST", "LISTENING"], 1),
    (3.48, 6.10, ["CATCHES", "EVERY WORD"], ["CATCHES", "EVERY", "WORD"], 2),
    (6.10, 7.32, ["AFTER THE", "MEETING"], ["AFTER", "THE", "MEETING"], 0),
    (7.32, 10.48, ["ALREADY", "WRITTEN"], ["DECISIONS", "&", "ACTIONS"], 0),
    (10.48, 12.98, ["ASK OUT", "LOUD"], ["JUST", "ASK", "OUT", "LOUD"], 1),
    (12.98, 15.20, ["TRY", "NODPILOT"], ["IT'S", "FREE"], 1),
]


def vo_duration():
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", VO],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip()) + 0.15


# (filename, seconds to keep) aligned to the VO beats
CLIP_BEATS = [
    ("clip_0.mp4", 3.50),
    ("clip_1.mp4", 2.60),
    ("clip_2.mp4", 4.40),
    ("clip_4.mp4", 5.00),
]


def concat_picture():
    parts = []
    for i, (name, hold) in enumerate(CLIP_BEATS):
        src = os.path.join(CLIPS, name)
        if not os.path.exists(src):
            continue
        outp = os.path.join(TMP, f"p_{i}.mp4")
        subprocess.run([
            "ffmpeg", "-y", "-v", "error", "-i", src, "-t", f"{hold:.2f}",
            "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS}",
            "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-an",
            "-pix_fmt", "yuv420p", outp,
        ], check=True)
        parts.append(outp)
    if not parts:
        raise SystemExit("No Higgsfield clips in /tmp/hf_clips")
    lst = os.path.join(TMP, "list.txt")
    with open(lst, "w") as f:
        for p in parts:
            f.write(f"file '{p}'\n")
    silent = os.path.join(TMP, "picture.mp4")
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst,
        "-c", "copy", silent,
    ], check=True)
    return silent


def draw_big(draw, lines):
    size = 110
    font = ImageFont.truetype(FONT, size)
    lh = int(size * 1.08)
    y = int(H * 0.36) - (lh * len(lines)) // 2
    for line in lines:
        tw = draw.textbbox((0, 0), line, font=font)[2]
        x = (W - tw) // 2
        draw.text((x, y + 7), line, font=font, fill=(0, 0, 0))
        draw.text((x, y), line, font=font, fill=WHITE, stroke_width=6, stroke_fill=(0, 0, 0))
        y += lh


def draw_bar(draw, words, hi):
    font = ImageFont.truetype(FONT, 36)
    gap = 16
    widths = [draw.textbbox((0, 0), w, font=font)[2] for w in words]
    total = sum(widths) + gap * (len(words) - 1)
    pad_x, pad_y = 28, 16
    bw, bh = total + pad_x * 2, 36 + pad_y * 2
    x0, y0 = (W - bw) // 2, int(H * 0.82)
    draw.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=14, fill=(8, 8, 10))
    x = x0 + pad_x
    for i, w in enumerate(words):
        draw.text((x, y0 + pad_y - 2), w, font=font, fill=PINK if i == hi else WHITE)
        x += widths[i] + gap


def draw_hook(draw, t):
    if t > 2.35:
        return
    font = ImageFont.truetype(FONT, 34)
    text = "Must-have meeting app"
    tw = draw.textbbox((0, 0), text, font=font)[2]
    th = 34
    pad_x, pad_y = 22, 14
    bw, bh = tw + pad_x * 2, th + pad_y * 2
    x0, y0 = (W - bw) // 2, int(H * 0.10)
    draw.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=18, fill=WHITE)
    draw.text((x0 + pad_x, y0 + pad_y - 4), text, font=font, fill=INK)


def burn_captions(src, dur):
    nf = int(math.ceil(dur * FPS))
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-i", src, "-t", f"{dur:.3f}",
        "-r", str(FPS), os.path.join(TMP, "f_%04d.png"),
    ], check=True)
    for i in range(1, nf + 1):
        t = (i - 1) / FPS
        im = Image.open(os.path.join(TMP, f"f_{i:04d}.png")).convert("RGB")
        d = ImageDraw.Draw(im)
        draw_hook(d, t)
        for s, e, lines, words, hi in CAPS:
            if s <= t <= e:
                draw_big(d, lines)
                draw_bar(d, words, hi)
                break
        im.save(os.path.join(TMP, f"c_{i:04d}.png"))
        if i % 50 == 0:
            print(f"  frame {i}/{nf}")
    cap = os.path.join(TMP, "captioned.mp4")
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-framerate", str(FPS),
        "-i", os.path.join(TMP, "c_%04d.png"),
        "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-pix_fmt", "yuv420p", cap,
    ], check=True)
    return cap


def main():
    dur = vo_duration()
    print("vo", dur)
    picture = concat_picture()
    cap = burn_captions(picture, dur)
    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-i", cap, "-i", VO,
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest", "-movflags", "+faststart",
        OUT,
    ], check=True)
    print("saved", OUT, os.path.getsize(OUT))


if __name__ == "__main__":
    main()
