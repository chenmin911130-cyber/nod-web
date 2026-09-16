from __future__ import annotations

import re

_HREFLANG_EN = frozenset({"/", "/zh", "/privacy", "/terms", "/consent"})


def site_canonical_url(public_url: str, site_path: str) -> str:
    """Match web/src/siteOrigin.ts siteUrl(): / keeps a trailing slash."""
    base = (public_url or "").rstrip("/")
    path = site_shell_path(site_path)
    if path == "/":
        return f"{base}/"
    return f"{base}{path}"


def site_shell_path(full_path: str) -> str:
    """Normalize a catch-all segment to the SPA route key."""
    raw = (full_path or "").strip("/")
    if not raw:
        return "/"
    if raw == "zh" or raw.startswith("zh/"):
        return "/zh"
    return f"/{raw.split('/', 1)[0]}"


def inject_site_seo(html: str, public_url: str, site_path: str) -> str:
    """Rewrite canonical/hreflang/og:url in the static index shell for crawlers."""
    canonical = site_canonical_url(public_url, site_path)
    base = (public_url or "").rstrip("/")
    en = f"{base}/"
    zh = f"{base}/zh"
    x_default = en
    shell = site_shell_path(site_path)

    html = re.sub(
        r'<link rel="canonical" href="[^"]*"\s*/>',
        f'<link rel="canonical" href="{canonical}" />',
        html,
        count=1,
    )
    html = re.sub(
        r'<link rel="alternate" hreflang="en" href="[^"]*"\s*/>',
        f'<link rel="alternate" hreflang="en" href="{en}" />',
        html,
        count=1,
    )
    html = re.sub(
        r'<link rel="alternate" hreflang="zh-Hans" href="[^"]*"\s*/>',
        f'<link rel="alternate" hreflang="zh-Hans" href="{zh}" />',
        html,
        count=1,
    )
    html = re.sub(
        r'<link rel="alternate" hreflang="x-default" href="[^"]*"\s*/>',
        f'<link rel="alternate" hreflang="x-default" href="{x_default}" />',
        html,
        count=1,
    )
    html = re.sub(
        r'<meta property="og:url" content="[^"]*"\s*/>',
        f'<meta property="og:url" content="{canonical}" />',
        html,
        count=1,
    )
    if shell == "/zh":
        html = re.sub(r"<html lang=\"[^\"]*\"", '<html lang="zh-Hans"', html, count=1)
    elif shell in _HREFLANG_EN and shell != "/zh":
        html = re.sub(r"<html lang=\"[^\"]*\"", '<html lang="en"', html, count=1)
    return html
