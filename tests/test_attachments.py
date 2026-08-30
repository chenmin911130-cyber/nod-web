import base64
import unittest
from io import BytesIO

from server.app import attachment_images, attachments_to_prompt, _extract_attachment_text


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
