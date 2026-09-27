# Admin console

`/admin` is the operator console. It unlocks with `ADMIN_TOKEN` and shows overview, usage, users, sessions, and feedback. Without the token every admin endpoint refuses.

## Sub-features

- `admin` covers a wrong token refused (401), no token refused (401), overview / users / feedback / sessions returning 200 with `x-admin-token`, and the `/admin` page rendering.

## How to get to it (user POV)

- Open `/admin`, paste the admin token, and browse the tabs.

## Driving it with control-nod

Preconditions:

- `control-nod up` sets `ADMIN_TOKEN=verify-admin-token` for the local server only.

- **Gate and data.** Run `control-nod drive admin`. The JSON dumps in `scenarios/admin/` hold the real responses; `admin-page.png` shows the login form.

## Gotchas

- `POST /api/admin/login` is limited to 5 attempts per 10 minutes. The scenario uses one wrong attempt and then the header, so reruns stay under the limit.
- The page load logs one 401 before login. That is expected.
