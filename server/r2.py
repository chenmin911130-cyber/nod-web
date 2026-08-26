from __future__ import annotations

import logging
import struct
from functools import lru_cache
from typing import Any

from server.settings import MAX_AUDIO_HOURS, R2_ACCESS_KEY_ID, R2_ACCOUNT_ID, R2_BUCKET, R2_SECRET_ACCESS_KEY

log = logging.getLogger("nod.r2")

SAMPLE_RATE = 16000
PART_SECONDS = 30 * 60
MAX_AUDIO_SECONDS = int(MAX_AUDIO_HOURS * 3600)
PART_BYTES = SAMPLE_RATE * 2 * PART_SECONDS
MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS


def enabled() -> bool:
    return bool(R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY and R2_BUCKET)


def pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    n = len(pcm)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + n,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        n,
    )
    return header + pcm


@lru_cache(maxsize=1)
def _client() -> Any:
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def put_bytes(key: str, body: bytes, content_type: str) -> bool:
    if not enabled() or not key or not body:
        return False
    _client().put_object(Bucket=R2_BUCKET, Key=key, Body=body, ContentType=content_type)
    return True


def presign(key: str, expires: int = 3600) -> str:
    if not enabled() or not key:
        return ""
    return _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": R2_BUCKET, "Key": key},
        ExpiresIn=expires,
    )


def list_keys(prefix: str) -> list[str]:
    if not enabled() or not prefix:
        return []
    keys: list[str] = []
    token = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": R2_BUCKET, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        listing = _client().list_objects_v2(**kwargs)
        keys.extend(obj["Key"] for obj in listing.get("Contents") or [])
        if not listing.get("IsTruncated"):
            break
        token = listing.get("NextContinuationToken")
    return keys


def delete_key(key: str) -> None:
    if not enabled() or not key:
        return
    try:
        _client().delete_object(Bucket=R2_BUCKET, Key=key)
    except Exception:
        log.exception("r2 delete failed key=%s", key)


def delete_prefix(prefix: str) -> None:
    if not enabled() or not prefix:
        return
    token = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": R2_BUCKET, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        listing = _client().list_objects_v2(**kwargs)
        keys = [obj["Key"] for obj in listing.get("Contents") or []]
        for key in keys:
            delete_key(key)
        if not listing.get("IsTruncated"):
            break
        token = listing.get("NextContinuationToken")
