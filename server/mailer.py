from __future__ import annotations

import html as html_escape
import logging
import smtplib
from email.message import EmailMessage

import httpx

from server.settings import (
    CF_ACCOUNT_ID,
    CF_API_TOKEN,
    MAIL_FROM,
    PUBLIC_URL,
    RESEND_API_KEY,
    SMTP_HOST,
    SMTP_PASSWORD,
    SMTP_PORT,
    SMTP_USER,
)

log = logging.getLogger("nod.mail")


def _send_smtp(to: str, subject: str, html: str, text: str) -> bool:
    if not SMTP_HOST:
        return False
    msg = EmailMessage()
    msg["From"] = MAIL_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as smtp:
        smtp.starttls()
        if SMTP_USER:
            smtp.login(SMTP_USER, SMTP_PASSWORD)
        smtp.send_message(msg)
    return True


def _send_resend(to: str, subject: str, html: str, text: str) -> bool:
    if not RESEND_API_KEY:
        return False
    r = httpx.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
        json={"from": MAIL_FROM, "to": [to], "subject": subject, "html": html, "text": text},
        timeout=20,
    )
    r.raise_for_status()
    return True


def _send_cloudflare(to: str, subject: str, html: str, text: str) -> bool:
    if not CF_API_TOKEN or not CF_ACCOUNT_ID:
        return False
    r = httpx.post(
        f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/email/sending/send",
        headers={"Authorization": f"Bearer {CF_API_TOKEN}"},
        json={"from": MAIL_FROM, "to": to, "subject": subject, "html": html, "text": text},
        timeout=20,
    )
    r.raise_for_status()
    return True


def send_mail(to: str, subject: str, html: str, text: str) -> bool:
    try:
        if RESEND_API_KEY:
            return _send_resend(to, subject, html, text)
        if CF_API_TOKEN and CF_ACCOUNT_ID:
            return _send_cloudflare(to, subject, html, text)
        if SMTP_HOST:
            return _send_smtp(to, subject, html, text)
    except Exception:
        log.exception("email send failed")
        return False
    log.warning("no mail provider; message to %s subject=%s", to, subject)
    return False


def send_reset_email(to: str, token: str) -> bool:
    link = f"{PUBLIC_URL.rstrip('/')}/reset?token={token}"
    text = (
        f"Reset your Nod password:\n{link}\n\n"
        "This link expires in 2 hours. If you did not ask for it, ignore this email."
    )
    html = (
        f"<p>Reset your Nod password:</p><p><a href='{link}'>{link}</a></p>"
        "<p>This link expires in 2 hours.</p>"
    )
    sent = send_mail(to, "Reset your Nod password", html, text)
    if not sent:
        log.info("password reset email was not sent for %s", to)
    return sent


def send_otp_email(to: str, code: str) -> bool:
    text = (
        f"Your Nod sign-in code is {code}.\n\n"
        "It expires in 10 minutes. If you did not ask for it, ignore this email."
    )
    html = (
        f"<p>Your Nod sign-in code is <strong>{html_escape.escape(code)}</strong>.</p>"
        "<p>It expires in 10 minutes. If you did not ask for it, ignore this email.</p>"
    )
    sent = send_mail(to, "Your Nod sign-in code", html, text)
    if not sent:
        log.info("sign-in code email was not sent for %s", to)
    return sent


def send_feedback_copy(to_admin: str, from_email: str, message: str) -> None:
    # Both fields are user supplied and land in an inbox we read.
    safe_email = html_escape.escape(from_email or "")
    safe_message = html_escape.escape(message or "")
    send_mail(
        to_admin,
        f"Nod feedback from {from_email or 'anonymous'}",
        f"<p>{safe_email}</p><pre>{safe_message}</pre>",
        f"{from_email}\n\n{message}",
    )
