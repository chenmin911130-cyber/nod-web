from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse, Response as RawResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from server.db import AuditLog, Feedback, Order, ResetToken, StripeEvent, UsageSession, User, db_session, utcnow
from server.mailer import send_otp_email, send_reset_email
from server.otp import OTP_OK, consume_otp, issue_otp
from server.meter import delete_history_session, delete_user_data, list_history, list_pending_history, plan_of, session_file_key, session_file_url, usage_snapshot
from server.security import (
    cookie_kwargs,
    current_user,
    hash_password,
    hash_token,
    is_local_request,
    issue_jwt,
    new_id,
    optional_user,
    valid_email,
    verify_password,
)
from server.ratelimit import allow, rate_limit, rate_limit_global
from server.settings import CLERK_PUBLISHABLE_KEY, CONTACT_EMAIL, MAIL_FROM, PLANS, PUBLIC_URL, STRIPE_PRICE_PRO, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

log = logging.getLogger("nod.api")
router = APIRouter()


def _clerk_js_response(name: str) -> RawResponse:
    from server.clerk_auth import load_clerk_js_asset

    body, media = load_clerk_js_asset(name)
    return RawResponse(
        content=body,
        media_type=media,
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/clerk.browser.js")
def clerk_browser_js():
    return _clerk_js_response("clerk.browser.js")


@router.get("/clerk-js/{name}")
def clerk_js_dir(name: str):
    return _clerk_js_response(name)


class RegisterIn(BaseModel):
    email: str
    password: str
    name: str = ""
    consent: bool = False


class LoginIn(BaseModel):
    email: str
    password: str


class OtpRequestIn(BaseModel):
    email: str
    intent: str = "login"
    name: str = ""
    consent: bool = False


class OtpVerifyIn(BaseModel):
    email: str
    code: str
    intent: str = "login"
    name: str = ""
    consent: bool = False


class ForgotIn(BaseModel):
    email: str


class ResetIn(BaseModel):
    token: str
    password: str


class ConsentIn(BaseModel):
    consent: bool = True


class ClerkIn(BaseModel):
    token: str = ""


class FeedbackIn(BaseModel):
    email: str = ""
    message: str = Field(min_length=4, max_length=4000)


class TtsIn(BaseModel):
    text: str = Field(min_length=1, max_length=800)
    voice: str = "female"


def _public_user(user: User) -> dict[str, Any]:
    snap = usage_snapshot(user.id)
    plan = plan_of(user)
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "plan": plan["id"],
        "plan_name": plan["name"],
        "subscription_status": user.subscription_status,
        "consent": bool(user.recording_consent_at),
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "usage": snap,
        "plans": list(PLANS.values()),
        "stripe_enabled": bool(STRIPE_SECRET_KEY and STRIPE_PRICE_PRO),
        "quota_disabled": bool(snap.get("quota_disabled")),
        "sign_in": "google" if user.clerk_id else "email",
    }


def _set_session(response: Response, request: Request, user: User) -> str:
    token = issue_jwt(user.id, user.email)
    https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(value=token, **cookie_kwargs(https))
    return token


LOCAL_TEST_EMAIL = "local@nod.test"


def workspace_user(
    request: Request,
    user: User | None = Depends(optional_user),
) -> User:
    """Same identity as /api/me: a real session if present, local test user on this machine."""
    if user is not None:
        return user
    from server.settings import AUTH_DISABLED

    if AUTH_DISABLED or is_local_request(request):
        return _ensure_local_user()
    raise HTTPException(status_code=401, detail="Please sign in")


def _ensure_local_user() -> User:
    with db_session() as db:
        user = db.execute(select(User).where(User.email == LOCAL_TEST_EMAIL)).scalar_one_or_none()
        if user is None:
            user = User(
                id=new_id(),
                email=LOCAL_TEST_EMAIL,
                name="Local test",
                password_hash="",
                recording_consent_at=utcnow(),
            )
            db.add(user)
            db.flush()
        elif user.recording_consent_at is None:
            user.recording_consent_at = utcnow()
        db.expunge(user)
        return user


@router.post("/api/auth/local-guest")
def local_guest(request: Request, response: Response):
    if not is_local_request(request):
        raise HTTPException(404, "Not found")
    user = _ensure_local_user()
    token = _set_session(response, request, user)
    return {"ok": True, "token": token, "user": _public_user(user)}


@router.post("/api/auth/register")
def register(
    body: RegisterIn,
    request: Request,
    response: Response,
    _: None = Depends(rate_limit("register", 8, 60)),
    __: None = Depends(rate_limit_global("register", 20, 60)),
):
    email = body.email.strip().lower()
    if not valid_email(email):
        raise HTTPException(400, "Enter a valid email")
    if len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    with db_session() as db:
        if db.query(User).filter(User.email == email, User.deleted_at.is_(None)).first():
            raise HTTPException(409, "That email is already registered")
        user = User(
            id=new_id(),
            email=email,
            password_hash=hash_password(body.password),
            name=(body.name or "").strip()[:120],
            plan="free",
            subscription_status="trialing",
            recording_consent_at=utcnow() if body.consent else None,
        )
        db.add(user)
        try:
            db.flush()
        except IntegrityError:
            # Two concurrent signups can both pass the duplicate check above,
            # then race to insert the same email. Turn the loser into 409
            # instead of a 500.
            raise HTTPException(409, "That email is already registered") from None
        db.expunge(user)
    token = _set_session(response, request, user)
    log.info("register user=%s", user.id)
    return {"ok": True, "token": token, "user": _public_user(user)}


@router.post("/api/auth/otp/request")
def otp_request(
    body: OtpRequestIn,
    request: Request,
    _: None = Depends(rate_limit("otp-request", 4, 600)),
    __: None = Depends(rate_limit_global("otp-request", 20, 600)),
):
    email = body.email.strip().lower()
    intent = "signup" if body.intent == "signup" else "login"
    if not valid_email(email):
        raise HTTPException(400, "Enter a valid email")
    if not allow_email_otp(email):
        raise HTTPException(429, "Too many requests. Try again shortly.")
    with db_session() as db:
        user = db.query(User).filter(User.email == email, User.deleted_at.is_(None)).first()
        exists = user is not None
    should_send = intent == "signup" or exists
    code = issue_otp(email, intent, body.name, body.consent) if should_send else ""
    sent = send_otp_email(email, code) if code else False
    payload = {"ok": True, "message": OTP_OK}
    if is_local_request(request) and code:
        payload["dev_code"] = code
    elif should_send and not sent and not is_local_request(request):
        raise HTTPException(503, "Could not send the code. Try again shortly.")
    return payload


@router.post("/api/auth/otp/verify")
def otp_verify(
    body: OtpVerifyIn,
    request: Request,
    response: Response,
    _: None = Depends(rate_limit("otp-verify", 8, 600)),
    __: None = Depends(rate_limit_global("otp-verify", 40, 600)),
):
    email = body.email.strip().lower()
    if not valid_email(email):
        raise HTTPException(400, "Enter a valid email")
    row = consume_otp(email, body.code)
    if row is None:
        raise HTTPException(401, "That code is invalid or expired")
    with db_session() as db:
        user = db.query(User).filter(User.email == email, User.deleted_at.is_(None)).first()
        created = False
        if user is None:
            if row.intent != "signup" and body.intent != "signup":
                raise HTTPException(401, "That code is invalid or expired")
            consented = bool(row.consent or body.consent)
            if not consented:
                raise HTTPException(400, "Agree to the Terms to create an account")
            user = User(
                id=new_id(),
                email=email,
                password_hash="",
                name=(body.name or row.name or "").strip()[:120],
                plan="free",
                subscription_status="trialing",
                recording_consent_at=utcnow() if consented else None,
            )
            db.add(user)
            try:
                db.flush()
                created = True
            except IntegrityError:
                db.rollback()
                existing = db.query(User).filter(User.email == email, User.deleted_at.is_(None)).first()
                if existing is None:
                    raise HTTPException(409, "That email is already registered") from None
                user = existing
                created = False
        db.expunge(user)
    token = _set_session(response, request, user)
    log.info("otp %s user=%s", "signup" if created else "login", user.id)
    return {"ok": True, "token": token, "user": _public_user(user), "created": created}


def allow_email_otp(email: str) -> bool:
    return allow(f"otp-email:{email}", 4, 600)


@router.post("/api/auth/login")
def login(
    body: LoginIn,
    request: Request,
    response: Response,
    _: None = Depends(rate_limit("login", 10, 60)),
    __: None = Depends(rate_limit_global("login", 30, 60)),
):
    email = body.email.strip().lower()
    with db_session() as db:
        user = db.query(User).filter(User.email == email, User.deleted_at.is_(None)).first()
        if user is None:
            raise HTTPException(401, "Email or password is wrong")
        if not (user.password_hash or "").strip():
            raise HTTPException(401, "This account uses Google. Continue with Google.")
        if not verify_password(body.password, user.password_hash):
            raise HTTPException(401, "Email or password is wrong")
        db.expunge(user)
    token = _set_session(response, request, user)
    return {"ok": True, "token": token, "user": _public_user(user)}


@router.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie(key="nod_session", path="/")
    return {"ok": True}


@router.post("/api/auth/clerk")
def clerk_login(
    request: Request,
    response: Response,
    body: ClerkIn | None = None,
    _: None = Depends(rate_limit("clerk", 20, 60)),
):
    from server.clerk_auth import _token_from_request, clerk_profile, verify_clerk_session

    token = _token_from_request(request, body.token if body else "")
    payload = verify_clerk_session(token, request)
    clerk_id = str(payload["sub"])
    email, name = clerk_profile(clerk_id)
    with db_session() as db:
        user = db.query(User).filter(User.clerk_id == clerk_id, User.deleted_at.is_(None)).first()
        if user is None:
            user = db.query(User).filter(User.email == email, User.deleted_at.is_(None)).first()
        if user is None:
            user = User(
                id=new_id(),
                email=email,
                password_hash="",
                clerk_id=clerk_id,
                name=name,
                plan="free",
                subscription_status="trialing",
                recording_consent_at=None,
            )
            db.add(user)
            db.flush()
        else:
            if not user.clerk_id:
                user.clerk_id = clerk_id
            if name and not user.name:
                user.name = name
        db.expunge(user)
    nod_token = _set_session(response, request, user)
    log.info("clerk login user=%s clerk=%s", user.id, clerk_id)
    return {"ok": True, "token": nod_token, "user": _public_user(user)}


@router.post("/api/auth/forgot")
def forgot(body: ForgotIn, _: None = Depends(rate_limit("forgot", 5, 60))):
    email = body.email.strip().lower()
    with db_session() as db:
        user = db.query(User).filter(User.email == email, User.deleted_at.is_(None)).first()
        token = None
        if user:
            raw = new_id() + new_id()
            db.add(
                ResetToken(
                    id=new_id(),
                    user_id=user.id,
                    token_hash=hash_token(raw),
                    expires_at=utcnow() + timedelta(hours=2),
                )
            )
            token = raw
    if token:
        send_reset_email(email, token)
    return {"ok": True, "message": "If that email is registered, we sent a reset link."}


@router.post("/api/auth/reset")
def reset(
    body: ResetIn,
    request: Request,
    response: Response,
    _: None = Depends(rate_limit("reset", 8, 60)),
):
    if len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    th = hash_token(body.token.strip())
    with db_session() as db:
        row = db.query(ResetToken).filter(ResetToken.token_hash == th).first()
        if row is None or row.used_at is not None or row.expires_at < utcnow():
            raise HTTPException(400, "This reset link is invalid or expired")
        user = db.get(User, row.user_id)
        if user is None or user.deleted_at is not None:
            raise HTTPException(400, "This reset link is invalid or expired")
        user.password_hash = hash_password(body.password)
        row.used_at = utcnow()
        db.expunge(user)
    token = _set_session(response, request, user)
    return {"ok": True, "token": token, "user": _public_user(user)}


@router.get("/api/me")
def me(request: Request, user: User | None = Depends(optional_user)):
    if user is None:
        from server.settings import AUTH_DISABLED

        if AUTH_DISABLED or is_local_request(request):
            user = _ensure_local_user()
        else:
            raise HTTPException(status_code=401, detail="Please sign in")
    return _public_user(user)


@router.post("/api/me/consent")
def consent(body: ConsentIn, user: User = Depends(current_user)):
    if not body.consent:
        raise HTTPException(400, "Recording consent is required to use the workspace")
    with db_session() as db:
        row = db.get(User, user.id)
        if row:
            row.recording_consent_at = utcnow()
    return {"ok": True, "consent": True}


ALLOWED_EVENTS = {
    "cta_hero_start",
    "cta_google",
    "cta_signup_email",
    "cta_pricing",
    "scroll_pricing",
    "open_privacy",
    "signup_success",
}


class EventIn(BaseModel):
    name: str = ""
    path: str = ""
    extra: dict[str, Any] = Field(default_factory=dict)


@router.post("/api/events")
def funnel_event(request: Request, body: EventIn, _: None = Depends(rate_limit("events", 40, 60))):
    name = (body.name or "").strip()[:64]
    if name not in ALLOWED_EVENTS:
        return {"ok": False}
    ip = request.client.host if request.client else ""
    detail = json.dumps({"path": (body.path or "")[:200], "extra": body.extra}, ensure_ascii=False)[:2000]
    with db_session() as db:
        db.add(AuditLog(id=new_id(), user_id="", action=name, detail=detail, ip=ip[:64]))
    return {"ok": True}


@router.get("/api/account/history")
def history(pending: bool = False, user: User = Depends(workspace_user)):
    if pending:
        # Recoverable never-saved sessions (max 1, newest) so the client can
        # re-offer "Save this session to History?" after a reconnect.
        return {"ok": True, "sessions": list_pending_history(user.id)}
    return {"ok": True, "sessions": list_history(user.id)}


@router.post("/api/account/history/{session_id}/keep")
def keep_history_http(session_id: str, user: User = Depends(workspace_user)):
    """Watch Save from iPhone native when WKWebView is not running."""
    from server.meter import keep_usage_session

    if not session_id:
        raise HTTPException(400, "Missing session")
    with db_session() as db:
        row = db.get(UsageSession, session_id)
        if not row or row.user_id != user.id or row.discarded_at is not None:
            raise HTTPException(404, "Session not found")
    keep_usage_session(user.id, session_id, keep_content=True, keep_audio=True)
    return {"ok": True, "id": session_id}


@router.delete("/api/account/history/{session_id}")
def delete_history(session_id: str, user: User = Depends(workspace_user)):
    if not delete_history_session(user.id, session_id):
        raise HTTPException(404, "Session not found")
    return {"ok": True}


@router.get("/api/account/files/{session_id}/{kind}")
def download_session_file(
    session_id: str,
    kind: str,
    part: str | None = None,
    filename: str = "",
    proxy: bool = False,
    user: User = Depends(workspace_user),
):
    if kind not in ("audio", "notes"):
        raise HTTPException(404, "Unknown file")
    if proxy:
        from server.r2 import get_bytes

        key = session_file_key(user.id, session_id, kind, part)
        if not key:
            raise HTTPException(404, "File not found")
        body = get_bytes(key)
        if not body:
            raise HTTPException(404, "File not found")
        safe = (filename or "recording.wav").replace('"', "").replace("\n", " ")
        media = "audio/wav" if kind == "audio" else "application/pdf"
        return RawResponse(
            content=body,
            media_type=media,
            headers={"Content-Disposition": f'attachment; filename="{safe}"'},
        )
    url = session_file_url(user.id, session_id, kind, part, filename)
    if not url:
        raise HTTPException(404, "File not found")
    return RedirectResponse(url, status_code=302)


@router.delete("/api/account")
def delete_account(user: User = Depends(current_user), response: Response = None):
    delete_user_data(user.id)
    if response is not None:
        response.delete_cookie(key="nod_session", path="/")
    log.info("deleted account user=%s", user.id)
    return {"ok": True}


@router.get("/api/plans")
def plans():
    return {"ok": True, "plans": list(PLANS.values()), "stripe_enabled": bool(STRIPE_SECRET_KEY and STRIPE_PRICE_PRO)}


@router.post("/api/billing/checkout")
def checkout(user: User = Depends(current_user)):
    if not STRIPE_SECRET_KEY or not STRIPE_PRICE_PRO:
        raise HTTPException(503, "Card payments are not connected yet. Add STRIPE_SECRET_KEY and STRIPE_PRICE_PRO.")
    import stripe

    stripe.api_key = STRIPE_SECRET_KEY
    with db_session() as db:
        row = db.get(User, user.id)
        customer = row.stripe_customer_id if row else ""
        if not customer:
            c = stripe.Customer.create(email=user.email, metadata={"nod_user": user.id})
            customer = c.id
            if row:
                row.stripe_customer_id = customer
        order = Order(
            id=new_id(),
            user_id=user.id,
            plan="pro",
            amount_cents=PLANS["pro"]["price_cents"],
            status="pending",
        )
        db.add(order)
        db.flush()
        oid = order.id
    session = stripe.checkout.Session.create(
        mode="subscription",
        customer=customer,
        line_items=[{"price": STRIPE_PRICE_PRO, "quantity": 1}],
        success_url=f"{PUBLIC_URL.rstrip('/')}/account?paid=1",
        cancel_url=f"{PUBLIC_URL.rstrip('/')}/account?paid=0",
        client_reference_id=user.id,
        metadata={"nod_user": user.id, "order_id": oid},
    )
    with db_session() as db:
        row = db.get(Order, oid)
        if row:
            row.stripe_checkout_id = session.id
    return {"ok": True, "url": session.url}


@router.post("/api/billing/portal")
def portal(user: User = Depends(current_user)):
    if not STRIPE_SECRET_KEY:
        raise HTTPException(503, "Card payments are not connected yet.")
    import stripe

    stripe.api_key = STRIPE_SECRET_KEY
    with db_session() as db:
        row = db.get(User, user.id)
        customer = row.stripe_customer_id if row else ""
    if not customer:
        raise HTTPException(400, "No billing customer yet")
    session = stripe.billing_portal.Session.create(
        customer=customer,
        return_url=f"{PUBLIC_URL.rstrip('/')}/account",
    )
    return {"ok": True, "url": session.url}


@router.post("/api/billing/webhook")
async def stripe_webhook(request: Request):
    if not STRIPE_SECRET_KEY or not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(503, "Stripe webhook is not configured")
    import stripe

    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except Exception as e:
        raise HTTPException(400, f"Invalid webhook: {e}")
    eid = str(event.get("id") or "")
    if eid:
        try:
            with db_session() as db:
                db.add(StripeEvent(id=eid, at=utcnow()))
                db.flush()
        except IntegrityError:
            return {"ok": True}
    etype = event.get("type")
    data = event.get("data", {}).get("object", {})
    if etype in ("checkout.session.completed", "customer.subscription.updated", "customer.subscription.created"):
        meta = data.get("metadata") or {}
        user_id = meta.get("nod_user") or data.get("client_reference_id")
        sub_id = data.get("subscription") if isinstance(data.get("subscription"), str) else (data.get("id") if etype.startswith("customer.subscription") else "")
        status = data.get("status") or "active"
        customer = data.get("customer") if isinstance(data.get("customer"), str) else ""
        with db_session() as db:
            user = db.get(User, user_id) if user_id else None
            if user is None and customer:
                user = db.query(User).filter(User.stripe_customer_id == customer).first()
            if user:
                user.plan = "pro"
                user.subscription_status = "active" if status in ("active", "trialing") else status
                if customer:
                    user.stripe_customer_id = customer
                if sub_id:
                    user.stripe_subscription_id = sub_id
            oid = meta.get("order_id")
            if oid:
                order = db.get(Order, oid)
                if order:
                    order.status = "paid"
                    order.paid_at = utcnow()
                    order.stripe_payment_intent = str(data.get("payment_intent") or "")
    elif etype in ("customer.subscription.deleted", "invoice.payment_failed"):
        customer = data.get("customer") if isinstance(data.get("customer"), str) else ""
        with db_session() as db:
            user = db.query(User).filter(User.stripe_customer_id == customer).first()
            if user:
                if etype.endswith("deleted"):
                    user.plan = "free"
                    user.subscription_status = "canceled"
                else:
                    user.subscription_status = "past_due"
    return {"ok": True}


@router.get("/api/tts/status")
def tts_status():
    from server.tts import elevenlabs_key

    return {"ok": bool(elevenlabs_key())}


@router.post("/api/tts", dependencies=[Depends(rate_limit("tts", 30, 60))])
def tts_speak(
    request: Request,
    body: TtsIn,
    user: User | None = Depends(optional_user),
):
    if user is None and not is_local_request(request):
        raise HTTPException(status_code=401, detail="Please sign in")
    from server.tts import elevenlabs_key, synthesize

    if not elevenlabs_key():
        raise HTTPException(status_code=503, detail="Speech is not configured")
    try:
        audio = synthesize(body.text, body.voice)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return RawResponse(content=audio, media_type="audio/mpeg")


@router.post("/api/feedback")
def feedback(
    body: FeedbackIn,
    user: User | None = Depends(optional_user),
    _: None = Depends(rate_limit("feedback", 5, 60)),
):
    with db_session() as db:
        db.add(
            Feedback(
                id=new_id(),
                user_id=user.id if user else "",
                email=(body.email or (user.email if user else "")).strip()[:255],
                message=body.message.strip(),
            )
        )
    to_admin = CONTACT_EMAIL or MAIL_FROM
    if "@" in to_admin and "localhost" not in to_admin:
        try:
            from server.mailer import send_feedback_copy

            send_feedback_copy(to_admin, body.email, body.message)
        except Exception:
            log.exception("feedback mail failed")
    return {"ok": True}
