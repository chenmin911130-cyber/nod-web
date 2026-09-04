import base64
import unittest
from io import BytesIO
from unittest import mock

from starlette.testclient import TestClient

from server.app import (
    attach_b64_too_large,
    attach_body_too_large,
    attachment_images,
    attachments_to_prompt,
    _extract_attachment_text,
)
from server.settings import COOKIE_NAME


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


class AttachmentExtractTests(unittest.TestCase):
    def test_plain_text(self):
        text = attachments_to_prompt(
            [{"name": "notes.txt", "mime": "text/plain", "data": _b64(b"hello from the file")}]
        )
        self.assertIn("hello from the file", text)
        self.assertIn("notes.txt", text)

    def test_image_without_mime_still_vision(self):
        imgs = attachment_images(
            [{"name": "shot.jpg", "mime": "application/octet-stream", "data": "abc123"}]
        )
        self.assertEqual(len(imgs), 1)
        self.assertEqual(imgs[0]["mime"], "image/jpeg")

    def test_docx_text(self):
        from docx import Document

        buf = BytesIO()
        doc = Document()
        doc.add_paragraph("Quarterly revenue was 12 million.")
        doc.save(buf)
        body = _extract_attachment_text("report.docx", "", buf.getvalue())
        self.assertIn("12 million", body)

    def test_old_doc_is_rejected_clearly(self):
        body = _extract_attachment_text("resume.doc", "", b"not a real doc")
        self.assertIn(".docx", body)

    def test_store_and_take_attach(self):
        from server.app import store_attach_files, take_attach_files

        aid = store_attach_files([{"name": "a.pdf", "mime": "application/pdf", "data": "xx"}])
        files = take_attach_files(aid)
        self.assertEqual(files[0]["name"], "a.pdf")
        self.assertIsNone(take_attach_files(aid))


class AttachExtractGuardTests(unittest.TestCase):
    def test_body_limit_is_five_times_eight_mb(self):
        self.assertFalse(attach_body_too_large(None))
        self.assertFalse(attach_body_too_large(str(40 * 1024 * 1024)))
        self.assertTrue(attach_body_too_large(str(40 * 1024 * 1024 + 1)))
        self.assertTrue(attach_body_too_large("nope"))

    def test_one_file_base64_over_eight_mb_is_rejected(self):
        from server.app import ATTACH_MAX_B64_CHARS

        self.assertFalse(attach_b64_too_large("abc"))
        self.assertTrue(attach_b64_too_large("x" * (ATTACH_MAX_B64_CHARS + 1)))
        self.assertTrue(attach_b64_too_large(None))

    def test_anonymous_upload_is_rejected(self):
        from server.app import app

        res = TestClient(app).post("/api/attach/extract", json={"files": [{"name": "a.txt", "data": _b64(b"hi")}]})
        self.assertEqual(res.status_code, 401)

    def test_signed_in_small_file_is_stored(self):
        from server.app import app
        from server.db import User, db_session
        from server.security import issue_jwt, new_id

        uid = new_id()
        email = f"{uid}@test.local"
        with db_session() as db:
            db.add(User(id=uid, email=email, password_hash=""))
        token = issue_jwt(uid, email)
        client = TestClient(app)
        res = client.post(
            "/api/attach/extract",
            json={"files": [{"name": "a.txt", "mime": "text/plain", "data": _b64(b"hello")}]},
            cookies={COOKIE_NAME: token},
        )
        self.assertEqual(res.status_code, 200, res.text)
        self.assertTrue(res.json().get("id"))

    def test_oversize_content_length_is_413(self):
        from server.app import app
        from server.db import User, db_session
        from server.security import issue_jwt, new_id

        uid = new_id()
        email = f"{uid}@test.local"
        with db_session() as db:
            db.add(User(id=uid, email=email, password_hash=""))
        token = issue_jwt(uid, email)
        with mock.patch("server.app.ATTACH_MAX_BODY_BYTES", 32):
            res = TestClient(app).post(
                "/api/attach/extract",
                json={"files": [{"name": "a.txt", "data": _b64(b"hello")}]},
                cookies={COOKIE_NAME: token},
            )
        self.assertEqual(res.status_code, 413)

    def test_oversize_base64_is_413(self):
        from server.app import app
        from server.db import User, db_session
        from server.security import issue_jwt, new_id

        uid = new_id()
        email = f"{uid}@test.local"
        with db_session() as db:
            db.add(User(id=uid, email=email, password_hash=""))
        token = issue_jwt(uid, email)
        with mock.patch("server.app.ATTACH_MAX_B64_CHARS", 8):
            res = TestClient(app).post(
                "/api/attach/extract",
                json={"files": [{"name": "a.txt", "data": "abcdefghij"}]},
                cookies={COOKIE_NAME: token},
            )
        self.assertEqual(res.status_code, 413)
