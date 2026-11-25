"""Exercise the real office/PDF packages and the authenticated workbench paths."""
from io import BytesIO
import os
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from docx import Document
from fastapi.testclient import TestClient
from fpdf import FPDF
from openpyxl import Workbook, load_workbook
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.util import Inches
import pypdfium2

from aios_platform.api import build_app
from aios_platform.document_service import DEFAULT_NOTO, DocumentError, DocumentTools, INPUT_LIMIT, Report
from aios_platform.identity import DemoIdentity
from aios_platform.providers import DemoPlanner
from aios_platform.service import services

FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")


def file_bytes(file):
    output = BytesIO()
    file.save(output)
    return output.getvalue()


def sample_office():
    word = Document()
    word.add_paragraph("Warehouse agreement 冷鏈交接")
    word.add_table(rows=1, cols=1).cell(0, 0).text = "Dispatch 17:00"
    slides = Presentation()
    slide = slides.slides.add_slide(slides.slide_layouts[6])
    slide.shapes.add_textbox(Inches(0.5), Inches(0.5), Inches(2), Inches(1)).text = "Summary slide"
    slide.shapes.add_table(1, 1, Inches(1), Inches(2), Inches(2), Inches(1)).table.cell(0, 0).text = "Totals"
    book = Workbook()
    book.active.title = "Dispatch"
    book.active.append(("Order", "Pending"))
    book.active.append(("SHP-1001", "=1+1"))
    hidden = book.create_sheet("Hidden")
    hidden.sheet_state = "hidden"
    hidden.append(("hidden worksheet content",))
    return {"docx": file_bytes(word), "pptx": file_bytes(slides), "xlsx": file_bytes(book)}


def text_pdf(text):
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", size=12)
    pdf.cell(text=text)
    return bytes(pdf.output())


class DocumentRoutesTests(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with patch.dict(os.environ, {"AIOS_PROFILE": "demo", "AIOS_PLATFORM_STATE_DIR": tmp.name,
                                     "AIOS_PLATFORM_DSN": "", "AIOS_PLATFORM_DSN_FILE": ""}):
            runtime = services()
        self.tools = DocumentTools()
        self.client = TestClient(build_app(runtime, DemoIdentity("x" * 32), DemoPlanner(), document_tools=self.tools))
        self.addCleanup(self.client.close)

    def headers(self, subject="operator"):
        return {"Authorization": "Bearer " + "x" * 32 + "." + subject}

    def assign(self, *grants, version=0, subject="operator"):
        path = "/v1/workbench/module-access/employees/" + subject + "/agent-documents"
        return self.client.put(path, headers=self.headers("access-admin"), json={
            "version": version, "warehouses": [], "grants": grants,
        })

    def upload(self, name, data, subject="operator"):
        return self.client.post("/v1/workbench/documents/parse", params={"name": name},
                                headers={**self.headers(subject), "Content-Type": "application/octet-stream"}, content=data)

    def export(self, fmt, *, kind="personal-brief", subject="operator", **query):
        return self.client.get("/v1/workbench/reports/export", headers=self.headers(subject),
                               params={"kind": kind, "format": fmt, "locale": "zh-HK", **query})

    def test_true_office_and_pdf_parse_preserve_anchors(self):
        docs = {**sample_office(), "pdf": text_pdf("Delivery date 2026-11-25")}
        self.assertEqual(self.upload("incoming.docx", docs["docx"]).status_code, 403)
        self.assertEqual(self.assign("agent.documents_parse").status_code, 200)
        expected = {
            "docx": ("[Paragraph 1] Warehouse agreement 冷鏈交接", "[Table 2 row 1] Dispatch 17:00"),
            "pptx": ("[Slide 1] Summary slide", "[Slide 1 table row 1] Totals"),
            "xlsx": ("[Sheet Dispatch row 1] Order | Pending", "[Sheet Dispatch row 2] SHP-1001"),
            "pdf": ("[Page 1] Delivery date 2026-11-25",),
        }
        for kind, data in docs.items():
            with self.subTest(kind=kind):
                result = self.upload("incoming." + kind, data)
                self.assertEqual(result.status_code, 200, result.text)
                for content in expected[kind]:
                    self.assertIn(content, result.json()["content"])
                self.assertNotIn("hidden worksheet content", result.text)
                self.assertNotIn("=1+1", result.text)
        self.assertEqual(self.export("csv").status_code, 403, "Parsing does not grant exports")

    def test_input_limits_and_format_errors(self):
        self.upload("enroll.pdf", text_pdf("Enroll first"))
        self.assertEqual(self.assign("agent.documents_parse").status_code, 200)
        for name, raw, expected in (
            ("fake.pdf", b"Not PDF", 422),
            ("legacy.doc", b"word", 415),
            ("report.xlsm", b"sheet", 415),
            ("large.pdf", b"0" * (INPUT_LIMIT + 1), 413),
            ("directory/a.pdf", b"not pdf", 422),
        ):
            with self.subTest(name=name):
                self.assertEqual(self.upload(name, raw).status_code, expected)
        with patch.object(self.tools, "parse", side_effect=DocumentError("DOCUMENT_BUSY", 503)):
            result = self.upload("report.pdf", text_pdf("A"))
            self.assertEqual(result.status_code, 503)
            self.assertEqual(result.headers["retry-after"], "3")
        blank = FPDF()
        blank.add_page()
        result = self.upload("blank.pdf", bytes(blank.output()))
        self.assertEqual(result.json()["detail"]["code"], "DOCUMENT_NO_TEXT")

    def test_generated_spreadsheets_and_documents_with_independent_reader(self):
        self.export("csv")
        self.assertEqual(self.assign("agent.report_export").status_code, 200)
        csv_result = self.export("csv")
        self.assertEqual(csv_result.status_code, 200, csv_result.text)
        self.assertIn("個人工作日報", csv_result.content.decode("utf-8-sig"))
        self.assertIn("attachment", csv_result.headers["content-disposition"])
        self.assertEqual(csv_result.headers["cache-control"], "no-store")
        self.assertEqual(self.upload("incoming.pdf", text_pdf("No grant")).status_code, 403)
        doc_result = self.export("docx")
        self.assertEqual(doc_result.status_code, 200)
        self.assertEqual(Document(BytesIO(doc_result.content)).paragraphs[0].text, "個人工作日報")
        xlsx_result = self.export("xlsx")
        self.assertEqual(xlsx_result.status_code, 200)
        sheet = load_workbook(BytesIO(xlsx_result.content), read_only=True).active
        self.assertEqual(sheet["A1"].value, "個人工作日報")
        self.assertEqual(sheet["B3"].data_type, "n")

    def test_warehouse_report_reuses_scope_and_export_gates(self):
        self.export("csv", subject="manager")
        self.assertEqual(self.assign("agent.report_export", subject="manager").status_code, 200)
        good = self.export("csv", kind="warehouse-summary", subject="manager", warehouse="HK01")
        self.assertEqual(good.status_code, 200, good.text)
        self.assertIn("未結運單,23", good.content.decode("utf-8-sig"))
        self.assertEqual(self.export("csv", kind="warehouse-summary", subject="manager", warehouse="HK02").status_code, 403)
        self.assertEqual(self.export("xlsx", kind="warehouse-summary", subject="manager").status_code, 422)
        self.assertEqual(self.assign(version=1, subject="manager").status_code, 200)
        self.assertEqual(self.export("csv", subject="manager").status_code, 403)

    def test_revocation_while_worker_is_running_discards_result(self):
        raw = text_pdf("Interim report")
        self.upload("enrollment.pdf", raw)
        self.assertEqual(self.assign("agent.documents_parse").status_code, 200)
        parse = self.tools.parse

        def revoke_during(*args):
            self.assertEqual(self.assign(version=1).status_code, 200)
            return parse(*args)

        with patch.object(self.tools, "parse", side_effect=revoke_during):
            output = self.upload("actual.pdf", raw)
            self.assertEqual(output.status_code, 403)
            self.assertNotIn("Interim report", output.text)

    @unittest.skipUnless(DEFAULT_NOTO.is_file(), "Noto Sans CJK font not installed")
    def test_embedded_cjk_pdf_export(self):
        self.export("pdf")
        self.assertEqual(self.assign("agent.report_export").status_code, 200)
        result = self.export("pdf")
        self.assertEqual(result.status_code, 200, result.text[:100])
        pdf = pypdfium2.PdfDocument(result.content)
        try:
            page = pdf[0]
            text = page.get_textpage()
            try:
                self.assertIn("個人工作日報", text.get_text_bounded())
            finally:
                text.close()
                page.close()
        finally:
            pdf.close()

    @unittest.skipUnless(shutil.which("tesseract") and FONT.is_file(), "OCR binary/font unavailable")
    def test_scanned_pdf_uses_optional_local_ocr(self):
        image = Image.new("RGB", (950, 230), "white")
        ImageDraw.Draw(image).text((50, 60), "WAREHOUSE RECEIVING", font=ImageFont.truetype(str(FONT), 48), fill="black")
        pdf = FPDF()
        pdf.add_page()
        pdf.image(image, x=12, y=20, w=185)
        raw = bytes(pdf.output())
        with self.assertRaisesRegex(DocumentError, "DOCUMENT_NO_TEXT"):
            self.tools.parse("pdf", raw)
        text = DocumentTools(ocr_languages="eng").parse("pdf", raw).content.upper()
        self.assertIn("WAREHOUSE RECEIVING", text)

    def test_rejects_archive_missing_required_workbook_part(self):
        package = BytesIO()
        with ZipFile(package, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
        with self.assertRaisesRegex(DocumentError, "DOCUMENT_INVALID"):
            self.tools.parse("xlsx", package.getvalue())

    def test_exported_spreadsheet_preserves_formula_like_text_as_literal(self):
        report = Report("Export", "Today", ("Metric", "Value"), (("Example", "=1+1"),))
        sheet = load_workbook(BytesIO(self.tools.render(report, "xlsx", "en")), read_only=True).active
        self.assertNotEqual(sheet["B3"].data_type, "f")
        self.assertIn("'=1+1", self.tools.render(report, "csv", "en").decode("utf-8-sig"))
