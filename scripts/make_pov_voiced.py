"""Build a 9:16 voiced Nodpilot POV ad (SummaryAI-style captions + HeyGen VO)."""
import json, math, os, subprocess
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE = "/Users/minchen/Projects/nod-web/docs/creatify-assets"
TMP = "/tmp/pov_voiced"
os.makedirs(TMP, exist_ok=True)

W, H = 1080, 1920
FPS = 25
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
VO = "/tmp/nodpilot_vo.mp3"
TS = "/tmp/heygen_speech.json"
OUT = os.path.join(BASE, "nodpilot-pov-voiced.mp4")

PINK = (255, 77, 141)
WHITE = (255, 255, 255)
INK = (12, 14, 20)

# (start, end, big_lines, bar_words, highlight_index)
# highlight_index = which bar word is pink, or -1
CAPS = [
    (0.10, 1.80, ["HE'S TALKING"], ["HE'S TALKING"], -1),
    (1.80, 3.48, ["I'M JUST", "LISTENING"], ["I'M", "JUST", "LISTENING"], 1),
    (3.48, 6.10, ["CATCHES", "EVERY WORD"], ["CATCHES", "EVERY", "WORD"], 2),
    (6.10, 7.32, ["AFTER THE", "MEETING"], ["AFTER", "THE", "MEETING"], 0),
    (7.32, 10.48, ["ALREADY", "WRITTEN"], ["DECISIONS", "&", "ACTIONS"], 0),
    (10.48, 12.98, ["ASK OUT", "LOUD"], ["JUST", "ASK", "OUT", "LOUD"], 1),
    (12.98, 15.20, ["TRY", "NODPILOT"], ["IT'S", "FREE"], 1),
]

SCENES = [
    (0.00, 5.50, os.path.join(BASE, "01-meeting-live-report-clean.png")),
    (5.50, 10.50, os.path.join(BASE, "06-meeting-summary.png")),
    (10.50, 20.00, os.path.join(BASE, "07-liveqa-voice.png")),
]


def load_duration():
    data = json.loads(open(TS).read())["data"]
    return float(data["duration"]) + 0.25


def cover(im, tw, th, z=1.0):
    im = im.convert("RGB")
    sw, sh = im.size
    scale = max(tw / sw, th / sh) * z
    nw, nh = max(1, int(sw * scale)), max(1, int(sh * scale))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    x = (nw - tw) // 2
    y = max(0, (nh - th) // 2 - int(th * 0.04))
    return im.crop((x, y, x + tw, y + th))


def scene_at(t):
    for s, e, path in SCENES:
        if s <= t < e:
            return s, e, path
    return SCENES[-1]


def cap_at(t):
    for item in CAPS:
        if item[0] <= t <= item[1]:
            return item
    return None


def draw_big(draw, lines, t, s, e):
    # pop-in over first 0.12s of the caption
    age = max(0.0, t - s)
    pop = min(1.0, age / 0.12)
    size = int(118 * (0.92 + 0.08 * pop))
    font = ImageFont.truetype(FONT, size)
    lh = int(size * 1.08)
    total = lh * len(lines)
    y = int(H * 0.36) - total // 2
    for line in lines:
        bb = draw.textbbox((0, 0), line, font=font)
        tw = bb[2] - bb[0]
        x = (W - tw) // 2
        draw.text((x, y + 7), line, font=font, fill=(0, 0, 0))
        draw.text(
            (x, y),
            line,
            font=font,
            fill=WHITE,
            stroke_width=max(4, int(size * 0.055)),
            stroke_fill=(0, 0, 0),
        )
        y += lh


def draw_bar(draw, words, hi):
    font = ImageFont.truetype(FONT, 36)
    gap = 16
    widths = []
    for w in words:
        bb = draw.textbbox((0, 0), w, font=font)
        widths.append(bb[2] - bb[0])
    total = sum(widths) + gap * (len(words) - 1)
    pad_x, pad_y = 28, 16
    bw, bh = total + pad_x * 2, 36 + pad_y * 2
    x0, y0 = (W - bw) // 2, int(H * 0.82)
    # rounded black bar
    draw.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=14, fill=(8, 8, 10, 230))
    x = x0 + pad_x
    for i, w in enumerate(words):
        color = PINK if i == hi else WHITE
        draw.text((x, y0 + pad_y - 2), w, font=font, fill=color)
        x += widths[i] + gap


def draw_hook(draw, t):
    if t > 2.35:
        return
    font = ImageFont.truetype(FONT, 34)
    text = "Must-have meeting app"
    bb = draw.textbbox((0, 0), text, font=font)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    pad_x, pad_y = 22, 14
    bw, bh = tw + pad_x * 2, th + pad_y * 2
    x0, y0 = (W - bw) // 2, int(H * 0.10)
    draw.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=18, fill=WHITE)
    draw.text((x0 + pad_x, y0 + pad_y - 4), text, font=font, fill=INK)


def draw_brand(draw):
    font = ImageFont.truetype(FONT, 28)
    draw.text((40, 36), "Nodpilot", font=font, fill=(230, 236, 248))


def vignette(im):
    shade = Image.new("RGB", im.size, (5, 7, 14))
    mask = Image.new("L", im.size, 0)
    d = ImageDraw.Draw(mask)
    d.rectangle((0, int(H * 0.62), W, H), fill=170)
    d.rectangle((0, int(H * 0.78), W, H), fill=210)
    mask = mask.filter(ImageFilter.GaussianBlur(48))
    return Image.composite(shade, im, mask)


def main():
    dur = load_duration()
    nf = int(math.ceil(dur * FPS))
    print(f"duration={dur:.2f}s frames={nf}")
    cache = {}
    for i in range(1, nf + 1):
        t = (i - 1) / FPS
        s, e, path = scene_at(t)
        z = 1.0 + 0.07 * ((t - s) / max(0.01, e - s))
        key = (path, round(z, 3))
        if key not in cache:
            cache[key] = cover(Image.open(path), W, H, z)
        im = cache[key].copy()
        im = vignette(im)
        draw = ImageDraw.Draw(im, "RGBA")
        draw_brand(draw)
        draw_hook(draw, t)
        cap = cap_at(t)
        if cap:
            _, _, lines, words, hi = cap
            draw_big(draw, lines, t, cap[0], cap[1])
            draw_bar(draw, words, hi)
        im.convert("RGB").save(os.path.join(TMP, f"f_{i:04d}.png"))
        if i % 50 == 0:
            print(f"  frame {i}/{nf}")

    silent = os.path.join(TMP, "silent.mp4")
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-framerate", str(FPS),
            "-i", os.path.join(TMP, "f_%04d.png"),
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
            "-pix_fmt", "yuv420p",
            silent,
        ],
        check=True,
    )
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-i", silent,
            "-i", VO,
            "-map", "0:v", "-map", "1:a",
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            OUT,
        ],
        check=True,
    )
    print("saved", OUT, os.path.getsize(OUT))


if __name__ == "__main__":
    main()
