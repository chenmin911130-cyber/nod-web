# Sign-in

On localhost the workspace opens straight away as a shared local guest. Elsewhere a user signs in with Google (Clerk), an emailed six-digit code, or email + password, and every API call carries that session.

## Sub-features

- `auth-local-guest` covers `POST /api/auth/local-guest` working only from a loopback Host, and `/app` on 127.0.0.1 mounting without a login page.
- `auth-password` covers register, `/api/me`, duplicate email 409, wrong password 401, login, logout, and signed-out `/api/me` 401.
- `auth-otp` covers requesting a code (`intent=signup`), rejecting a wrong code, and verifying the right one.
- `auth-clerk` covers a bogus Clerk token being refused. Real Google sign-in is NOT VERIFIABLE locally.

## How to get to it (user POV)

- Localhost: open `http://127.0.0.1:9420/app`.
- Hosted: open `/login` or `/signup`, choose Google or email, and land on `/app`.
- Signed-out visit to `/app` on a non-local host redirects to `/login?next=%2Fapp`.

## Driving it with control-nod

Preconditions:

- Instance is up. No Clerk, Resend, or SMTP keys are set (the launcher strips them).

- **Guest.** Run `control-nod drive auth-local-guest`. `local-guest` from 127.0.0.1 returns a token, the same call with `Host: nodpilot.com` returns 404, and `workspace.png` shows the workspace.
- **Password.** Run `control-nod drive auth-password`. All seven steps are ok.
- **Email code.** Run `control-nod drive auth-otp`. The request returns `dev_code`, and verify with that code must return 200 with a token. `server-log-otp.txt` shows whether the mail step ran.
- **Clerk.** Run `control-nod drive auth-clerk`. A bogus token gets 503 `Google sign-in is not configured`. Status is NOT VERIFIABLE until a Clerk dev instance exists: export `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `NOD_VERIFY_KEEP_SECRETS=1` before `up` (otherwise the launcher strips them), allow `http://nod.localhost:9420` as a redirect in Clerk, and use a Google test account.

## Gotchas

- `/api/me` on a loopback Host returns the local guest when the token is missing or invalid. Probe signed-out behavior with `headers: REMOTE` (`Host: nod.localhost`).
- Node `fetch` silently drops a custom `Host` header, so Host-based checks go through `api()` (node:http).
- `register` is rate-limited to 8 per minute per IP. `newUser()` backs off on 429, so a full run can pause for a few seconds.
- The OTP `dev_code` only appears for loopback requests. Without a mail provider the code is not persisted, so verify fails; see the report of the run that found it.
