"""Configure hello@nodpilot.com via Email Routing. Token never printed."""
from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
ACCOUNT = "1e3d1837bda53ece4872202a04e956ae"
ZONE = "81fb0e6a91ed4499c2c3d91a0edcf03a"
HELLO = "hello@nodpilot.com"


def win_env(name: str, scope: str) -> str:
    raw = subprocess.check_output(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            f"[Environment]::GetEnvironmentVariable('{name}','{scope}')",
        ],
        text=True,
        encoding="utf-8",
        errors="replace",
    ).strip()
    return raw


def clipboard() -> str:
    try:
        raw = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "(Get-Clipboard -Raw).Trim()",
            ],
            text=True,
            encoding="utf-8",
            errors="replace",
        ).strip().strip('"')
        return raw
    except Exception:
        return ""


def find_token() -> tuple[str, str]:
    for name in ("CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"):
        val = os.environ.get(name, "").strip()
        if val:
            return val, f"process:{name}"
        val = win_env(name, "User")
        if val:
            return val, f"user:{name}"
        val = win_env(name, "Machine")
        if val:
            return val, f"machine:{name}"
    clip = clipboard()
    if clip.startswith(("cfat_", "cfut_")) or (len(clip) >= 32 and " " not in clip and "@" not in clip):
        return clip, "clipboard"
    for path in (
        os.path.expanduser(r"~\Desktop\cf-nodpilot-token.txt"),
        os.path.expanduser(r"~\.cursor\cf-api-token"),
    ):
        if os.path.isfile(path):
            val = open(path, encoding="utf-8").read().strip().strip('"')
            if val:
                return val, os.path.basename(path)
    return "", ""


def api(token: str, method: str, path: str, body=None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body_txt = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body_txt)
        except json.JSONDecodeError:
            parsed = {"success": False, "errors": [{"message": body_txt[:300]}]}
        parsed["_http"] = exc.code
        return parsed


def main() -> int:
    token, source = find_token()
    print("token_found", bool(token), "source", source or "none")
    if not token:
        return 2

    verify = api(token, "GET", "/user/tokens/verify")
    print("verify_ok", bool(verify.get("success")), "http", verify.get("_http", 200))
    if not verify.get("success"):
        acct = api(token, "GET", f"/accounts/{ACCOUNT}/tokens/verify")
        print("account_verify_ok", bool(acct.get("success")), "http", acct.get("_http", 200))
        if not acct.get("success"):
            errs = (verify.get("errors") or acct.get("errors") or [])[:2]
            print("verify_errors", json.dumps(errs, ensure_ascii=False)[:400])
            return 3

    settings = api(token, "GET", f"/zones/{ZONE}/email/routing")
    result = settings.get("result") or {}
    print(
        "routing_enabled",
        result.get("enabled"),
        "status",
        result.get("status"),
        "http",
        settings.get("_http", 200),
    )
    if not settings.get("success"):
        print("routing_errors", json.dumps(settings.get("errors") or [], ensure_ascii=False)[:400])

    addrs = api(token, "GET", f"/accounts/{ACCOUNT}/email/routing/addresses")
    dests = addrs.get("result") or []
    print("dest_count", len(dests) if isinstance(dests, list) else 0, "http", addrs.get("_http", 200))
    if not addrs.get("success"):
        print("dest_errors", json.dumps(addrs.get("errors") or [], ensure_ascii=False)[:400])
    verified = []
    pending = []
    if isinstance(dests, list):
        for d in dests:
            email = d.get("email") or "?"
            if d.get("verified"):
                verified.append(email)
            else:
                pending.append(email)
    print("dest_verified", verified)
    print("dest_pending", pending)

    rules = api(token, "GET", f"/zones/{ZONE}/email/routing/rules")
    rule_list = rules.get("result") or []
    print("rule_count", len(rule_list) if isinstance(rule_list, list) else 0, "http", rules.get("_http", 200))
    if not rules.get("success"):
        print("rule_errors", json.dumps(rules.get("errors") or [], ensure_ascii=False)[:400])
    have_hello = False
    if isinstance(rule_list, list):
        for r in rule_list:
            matchers = r.get("matchers") or []
            actions = r.get("actions") or []
            vals = [m.get("value") for m in matchers]
            dest = []
            for a in actions:
                dest.extend(a.get("value") or [])
            print("rule", r.get("name"), "enabled", r.get("enabled"), "match", vals, "to", dest)
            if HELLO in vals:
                have_hello = True

    if have_hello:
        print("hello_rule", "exists")
        return 0
    if not verified:
        print("hello_rule", "blocked_no_verified_destination")
        return 4

    dest_email = verified[0]
    created = api(
        token,
        "POST",
        f"/zones/{ZONE}/email/routing/rules",
        {
            "name": "hello",
            "enabled": True,
            "matchers": [{"type": "literal", "field": "to", "value": HELLO}],
            "actions": [{"type": "forward", "value": [dest_email]}],
        },
    )
    print("hello_create_ok", bool(created.get("success")), "http", created.get("_http", 200))
    if not created.get("success"):
        print("hello_errors", json.dumps(created.get("errors") or [], ensure_ascii=False)[:400])
        return 5
    print("hello_rule", "created")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
