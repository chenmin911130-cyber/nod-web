# Site, health and SEO

The public marketing site at `/` (English) and `/zh`, the legal pages, and the sign-in shells render without an account. The public API answers health and bootstrap config without leaking secrets, and unknown paths return 404.

## Sub-features

- `api-health` covers `/api/health` ok, `/api/config` free of secrets, `/robots.txt`, `/sitemap.xml`, unknown `/api/*` 404, and path traversal refused.
- `site-pages` covers `/`, `/zh`, `/privacy`, `/terms`, `/consent`, `/login`, `/signup` returning 200 with content, and `/no-such-page` returning 404.
- `prod-readonly` covers `GET https://nodpilot.com/api/health` and `GET https://nodpilot.com/`.

## How to get to it (user POV)

- Open `http://127.0.0.1:9420/` and follow the footer links to Privacy and Terms.
- Open `/zh` for the Chinese landing page.
- Monitors and the deploy check read `/api/health`.

## Driving it with control-nod

Preconditions:

- Instance is up and `doctor` is OK. `prod-readonly` needs outbound HTTPS only.

- **API.** Run `control-nod drive api-health`. Every step is ok; `scenarios/api-health/health.json` shows `"ok": true`, and `config.json` has no `sk_` or secret values.
- **Pages.** Run `control-nod drive site-pages`. Each page reports status 200 and more than 40 characters of text; `page_*.png` shows each page.
- **Production.** Run `control-nod drive prod-readonly`. `prod-health.json` holds the live payload. The `sha` field is the deployed commit prefix; compare it with `git rev-parse origin/main`.

## Gotchas

- Locally `/api/health` has `"sha": ""` because `RAILWAY_GIT_COMMIT_SHA` is unset. That is expected.
- `site-pages` logs one console 404: the deliberate `/no-such-page` visit.
- `prod-readonly` is excluded from `drive all`. Run it on purpose, and never add a scenario that POSTs to production.
