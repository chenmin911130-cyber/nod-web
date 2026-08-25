from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from server.db import AuditLog, Feedback, Order, ResetToken, User, db_session, utcnow
from server.mailer import send_reset_email
from server.meter import delete_user_data, list_history, plan_of, usage_snapshot
from server.security import (
    cookie_kwargs,
    current_user,
    hash_password,
    hash_token,
    issue_jwt,
    new_id,
    optional_user,
    valid_email,
    verify_password,
)
from server.settings import CLERK_PUBLISHABLE_KEY, MAIL_FROM, PLANS, PUBLIC_URL, STRIPE_PRICE_PRO, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

log = logging.getLogger("nod.api")
router = APIRouter()


class RegisterIn(BaseModel):
    email: str
    password: str
    name: str = ""
    consent: bool = False


class LoginIn(BaseModel):
    email: str
    password: str


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
    }


def _set_session(response: Response, request: Request, user: User) -> str:
    token = issue_jwt(user.id, user.email)
    https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(value=token, **cookie_kwargs(https))
    return token


@router.post("/api/auth/register")
def register(body: RegisterIn, request: Request, response: Response):
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
            recording_consent_at=None,
        )
        db.add(user)
        db.flush()
        db.expunge(user)
    token = _set_session(response, request, user)
    log.info("register user=%s", user.id)
    return {"ok": True, "token": token, "user": _public_user(user)}


@router.post("/api/auth/login")
def login(body: LoginIn, request: Request, response: Response):
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
def clerk_login(request: Request, response: Response, body: ClerkIn | None = None):
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
def forgot(body: ForgotIn):
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
def reset(body: ResetIn, request: Request, response: Response):
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
def me(user: User = Depends(current_user)):
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
def funnel_event(request: Request, body: EventIn):
    name = (body.name or "").strip()[:64]
    if name not in ALLOWED_EVENTS:
        return {"ok": False}
    ip = request.client.host if request.client else ""
    detail = json.dumps({"path": (body.path or "")[:200], "extra": body.extra}, ensure_ascii=False)[:2000]
    with db_session() as db:
        db.add(AuditLog(id=new_id(), user_id="", action=name, detail=detail, ip=ip[:64]))
    return {"ok": True}


@router.get("/api/account/history")
def history(user: User = Depends(current_user)):
    return {"ok": True, "sessions": list_history(user.id)}


@router.get("/api/account/history/{sid}")
def history_one(sid: str, user: User = Depends(current_user)):
    from server.meter import list_segments

    sessions = [row for row in list_history(user.id, 80) if row["id"] == sid]
    if not sessions:
        raise HTTPException(404, "Session not found")
    return {"ok": True, "session": sessions[0], "segments": list_segments(user.id, sid)}


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


@router.post("/api/feedback")
def feedback(body: FeedbackIn, user: User | None = Depends(optional_user)):
    with db_session() as db:
        db.add(
            Feedback(
                id=new_id(),
                user_id=user.id if user else "",
                email=(body.email or (user.email if user else "")).strip()[:255],
                message=body.message.strip(),
            )
        )
    to_admin = MAIL_FROM
    if "@" in MAIL_FROM and "localhost" not in MAIL_FROM:
        try:
            from server.mailer import send_feedback_copy

            send_feedback_copy(MAIL_FROM, body.email, body.message)
        except Exception:
            log.exception("feedback mail failed")
    return {"ok": True}
