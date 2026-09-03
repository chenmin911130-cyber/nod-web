"""Burn reference-style big captions onto the Nodpilot POV product demo.

Reads /tmp/pov_timeline.mp4 (13.8s, 3 product scenes), writes /Users/.../nodpilot-pov.mp4
Default: word-timed big White-on-black captions, animated pop-in per scene.
"""
import os, math, subprocess
from PIL import Image, ImageDraw, ImageFont

BASE = "/Users/minchen/Desktop/nod-web/docs/creatify-assets"
SRC = "/tmp/pov_timeline.mp4"
TMP = "/tmp/pov_frames"
os.makedirs(TMP, exist_ok=True)

W, H = 1080, 1920
FPS = 25
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

# scene boundaries (4.6s each). Each scene gets one big caption + a smaller sub.
SCENES = [
    (0.2, 4.6,  "NEVER TAKE NOTES", "Nodpilot listens & transcribes live.", 96),
    (4.6, 9.2,  "EVERY DECISION", "Actions, follow-ups — already written.", 96),
    (9.2, 13.8, "ASK IT OUT LOUD", "Miss it? Just ask. Instant answer.", 96),
]

def wrap(draw, text, font, maxw):
    words=text.split(); lines=[]; cur=""
    for w_ in words:
        t=(cur+" "+w_).strip()
        if draw.textbbox((0,0),t,font=font)[2]<=maxw: cur=t
        else: lines.append(cur); cur=w_
    if cur: lines.append(cur)
    return lines

def cap_frame(draw, t):
    # find active scene
    active=None
    for s,e,head,sub,size in SCENES:
        if s<=t<=e: active=(head,sub,size); break
    if not active: return
    head,sub,size=active
    # big head centered upper-third
    font=ImageFont.truetype(FONT,size)
    hw=draw.textbbox((0,0),head,font=font)[2]
    hx=(W-hw)//2; hy=int(H*0.34)
    draw.text((hx,hy+5),head,font=font,fill=(0,0,0))
    draw.text((hx,hy),head,font=font,fill=(255,255,255),stroke_width=int(size*0.055),stroke_fill=(0,0,0))
    # sub-line smaller under it
    sfont=ImageFont.truetype(FONT,int(size*0.44))
    for i,line in enumerate(wrap(draw,sub,sfont,W-160)):
        lw=draw.textbbox((0,0),line,font=sfont)[2]
        lx=(W-lw)//2; ly=hy+int(size*1.15)+i*int(size*0.5)
        draw.text((lx,ly+3),line,font=sfont,fill=(0,0,0))
        draw.text((lx,ly),line,font=sfont,fill=(230,230,230),stroke_width=2,stroke_fill=(0,0,0))

def main():
    dur=float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",SRC],capture_output=True,text=True).stdout.strip())
    nf=int(math.ceil(dur*FPS))
    subprocess.run(["ffmpeg","-y","-v","error","-i",SRC,"-r",str(FPS),os.path.join(TMP,"f_%04d.png")],check=True)
    for i in range(1,nf+1):
        t=(i-1)/FPS
        im=Image.open(os.path.join(TMP,f"f_{i:04d}.png")).convert("RGB")
        d=ImageDraw.Draw(im); cap_frame(d,t)
        im.save(os.path.join(TMP,f"c_{i:04d}.png"))
    outv="/tmp/pov_cap.mp4"
    subprocess.run(["ffmpeg","-y","-v","error","-framerate",str(FPS),"-i",os.path.join(TMP,"c_%04d.png"),"-c:v","libx264","-crf","19","-preset","fast","-pix_fmt","yuv420p",outv],check=True)
    final=os.path.join(BASE,"nodpilot-pov.mp4")
    subprocess.run(["ffmpeg","-y","-v","error","-i",outv,"-c:v","copy",final],check=True)
    print("saved", final, os.path.getsize(final))

if __name__=="__main__": main()
