from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from server.logging_setup import backup_now
from server.ratelimit import rate_limit
from server.meter import (
    admin_feedback,
    admin_overview,
    admin_sessions,
    admin_set_stt_limit,
    admin_user_detail,
    admin_users,
    delete_user_data,
)
from server import settings
from server.security import require_admin
from server.settings import ADMIN_COOKIE, QUOTA_DISABLED

router = APIRouter()


class AdminLoginIn(BaseModel):
    token: str = ""


@router.post("/api/admin/login", dependencies=[Depends(rate_limit("admin-login", 5, 600))])
def login(body: AdminLoginIn, request: Request, response: Response):
    # Read through the module so the value stays a single source of truth.
    admin_token = settings.ADMIN_TOKEN
    if not admin_token:
        raise HTTPException(503, "Admin API is disabled (ADMIN_TOKEN is not set)")
    offered = (body.token or "").strip()
    if not hmac.compare_digest(offered, admin_token):
        raise HTTPException(401, "Wrong admin token")
    https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(
        key=ADMIN_COOKIE,
        value=admin_token,
        httponly=True,
        samesite="lax",
        secure=https,
        max_age=14 * 86400,
        path="/",
    )
    return {"ok": True, "quota_disabled": QUOTA_DISABLED}


@router.post("/api/admin/logout")
def logout(response: Response):
    response.delete_cookie(key=ADMIN_COOKIE, path="/")
    return {"ok": True}


@router.get("/api/admin/overview")
def overview(_: None = Depends(require_admin)):
    return {"ok": True, **admin_overview()}


@router.get("/api/admin/usage")
def usage(_: None = Depends(require_admin)):
    return {"ok": True, **admin_overview()}


@router.get("/api/admin/users")
def users(q: str = "", _: None = Depends(require_admin)):
    return {"ok": True, "users": admin_users(q)}


@router.get("/api/admin/users/{user_id}")
def user_detail(user_id: str, _: None = Depends(require_admin)):
    row = admin_user_detail(user_id)
    if row is None:
        raise HTTPException(404, "User not found")
    return {"ok": True, "user": row}


class UserQuotaIn(BaseModel):
    minutes: float | None = None


@router.patch("/api/admin/users/{user_id}/quota")
def user_quota(user_id: str, body: UserQuotaIn, _: None = Depends(require_admin)):
    row = admin_set_stt_limit(user_id, body.minutes)
    if row is None:
        raise HTTPException(404, "User not found")
    return {"ok": True, "user": row}


@router.delete("/api/admin/users/{user_id}")
def user_delete(user_id: str, _: None = Depends(require_admin)):
    row = admin_user_detail(user_id)
    if row is None:
        raise HTTPException(404, "User not found")
    delete_user_data(user_id)
    return {"ok": True}


@router.get("/api/admin/sessions")
def sessions(_: None = Depends(require_admin)):
    return {"ok": True, "sessions": admin_sessions()}


@router.get("/api/admin/feedback")
def feedback(_: None = Depends(require_admin)):
    return {"ok": True, "feedback": admin_feedback()}


@router.post("/api/admin/backup")
def backup(_: None = Depends(require_admin)):
    path = backup_now()
    return {"ok": True, "path": str(path) if path else None}
