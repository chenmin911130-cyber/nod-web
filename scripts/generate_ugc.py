"""Generate a Nodpilot UGC ad via the agent-media REST API.

Usage:
  1. Register at https://app.agent-media.ai  and create an API key (starts with `ma_`).
  2. Put it in scripts/.env  as:  AGENT_MEDIA_API_KEY=ma_xxxx
  3. Run:  python generate_ugc.py                 # uses the built-in Nodpilot script
          python generate_ugc.py --actor marco --duration 30 --list-actors
"""
import argparse, json, os, sys, time

try:
    import requests
except ImportError:
    sys.exit("pip install requests  first.")

BASE = "https://agent-media.ai/api/v1"

# A ready 30-45s English confessional-style UGC script for Nodpilot.
DEFAULT_SCRIPT = (
    "I used to be the person furiously typing notes in every meeting, "
    "and I still kept missing what people actually said. Then I found Nodpilot. "
    "It listens in the background, transcribes everything live, and translates "
    "meetings into my own language. When the call ends, it hands me the decisions, "
    "the action items, and the follow-ups — already written. And when I didn't "
    "catch something, I just asked out loud and it answered instantly. No typing. "
    "It's free while it's in beta — try Nodpilot."
)


def get_key() -> str:
    # load from scripts/.env
    envp = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(envp):
        for line in open(envp):
            line = line.strip()
            if line.startswith("AGENT_MEDIA_API_KEY="):
                return line.split("=", 1)[1].strip()
    k = os.environ.get("AGENT_MEDIA_API_KEY", "")
    if not k:
        sys.exit("No AGENT_MEDIA_API_KEY. Put it in scripts/.env or export it.")
    return k


def list_actors(key: str):
    r = requests.get(f"{BASE}/actors", headers={"Authorization": f"Bearer {key}"})
    r.raise_for_status()
    data = r.json()
    actors = data.get("actors", [])
    for a in actors[:40]:
        print(f"  {a['slug']:<16} {a.get('name','')[:20]:<22} {a.get('gender',''):<8} variants={a.get('variants')}")
    print(f"... {data.get('total', len(actors))} total")
    return actors


def create_video(key: str, script: str, actor: str, duration: int,
                 subtitle_style: str, aspect_ratio: str, broll_url: str | None,
                 voice_tone: str):
    body = {
        "script": script,
        "actor": actor,
        "duration": duration,
        "subtitle_style": subtitle_style,
        "aspect_ratio": aspect_ratio,   # 9:16
        "voice_tone": voice_tone,
    }
    if broll_url:
        body["broll_url"] = broll_url   # public URL to your product screenshots
    r = requests.post(f"{BASE}/videos", headers={"Authorization": f"Bearer {key}"},
                      json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def poll(key: str, vid: str):
    for _ in range(90):  # up to ~15 min
        r = requests.get(f"{BASE}/videos/{vid}", headers={"Authorization": f"Bearer {key}"},
                         timeout=30)
        r.raise_for_status()
        d = r.json()
        st = d.get("status")
        print(f"  status={st}")
        if st == "completed":
            return d.get("output_url")
        if st == "failed":
            sys.exit(f"FAILED: {d}")
        time.sleep(10)
    sys.exit("Timed out waiting for render.")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--script", default=None, help="Override the default Nodpilot script")
    p.add_argument("--actor", default="sofia", help="actor slug from --list-actors")
    p.add_argument("--duration", type=int, default=30)
    p.add_argument("--subtitle-style", default="hormozi", choices=["hormozi", "tiktok", "minimal"])
    p.add_argument("--aspect-ratio", default="9:16")
    p.add_argument("--voice-tone", default="conversational")
    p.add_argument("--broll-url", default=None,
                   help="Public URL (image/video) of a product screenshot to overlay as b-roll")
    p.add_argument("--list-actors", action="store_true")
    a = p.parse_args()

    key = get_key()
    if a.list_actors:
        list_actors(key)
        return

    script = a.script or DEFAULT_SCRIPT
    print("Creating video...")
    out = create_video(key, script, a.actor, a.duration, a.subtitle_style,
                       a.aspect_ratio, a.broll_url, a.voice_tone)
    vid = out.get("id")
    print("job:", vid, "credits_charged:", out.get("credits_charged"))
    url = poll(key, vid)
    print("DONE:", url)


if __name__ == "__main__":
    main()
