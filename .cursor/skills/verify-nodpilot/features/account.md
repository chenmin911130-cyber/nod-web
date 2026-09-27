# Account, settings and billing

The phone Account sheet offers Sign out and Delete account. Desktop Settings shows opacity, version, and Sign out. Plans are public; card checkout goes through Stripe. A feedback form stores messages for the admin.

## Sub-features

- `account` covers the phone Account sheet, the `Delete my Nodpilot account` confirmation, and the account really being gone (`/api/me` 401).
- `settings` covers the opacity slider and version row, Sign out clearing the token, and `/app` then redirecting to `/login?next=%2Fapp`.
- `billing` covers `/api/plans` and checkout returning a clear 503 without Stripe. Real checkout is NOT VERIFIABLE.
- `feedback` covers `POST /api/feedback` storing a message and rejecting a too-short one.

## How to get to it (user POV)

- Phone: top-right `Account`, then `Sign out` or `Delete account`.
- Desktop: gear `Settings` in the title bar.
- Pricing and upgrade live on `/account` on the hosted site.

## Driving it with control-nod

Preconditions:

- Instance is up. No Stripe keys are set.

- **Delete account.** Run `control-nod drive account`. `2-confirm.png` shows the confirmation and the step `/api/me for the deleted user (non-local Host) -> 401` is ok.
- **Sign out.** Run `control-nod drive settings`. The page lands on `/?signout=1` and reopening `/app` goes to `/login?next=%2Fapp`.
- **Billing.** Run `control-nod drive billing`. Needs `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO` (test mode), and `STRIPE_WEBHOOK_SECRET` to go further.
- **Feedback.** Run `control-nod drive feedback`; `control-nod drive admin` then lists it in `feedback.json`.

## Gotchas

- The isolated-session init script seeds the token once per tab (`sessionStorage` flag). Without that guard, signing out would be undone on the next navigation.
- Console 401s after sign-out or delete are expected: the page polls `/api/me` once more.
