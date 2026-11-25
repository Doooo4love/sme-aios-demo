"""Office/PDF extraction and report rendering for authorized workbench requests."""
from dataclasses import dataclass
import csv
from importlib.util import find_spec
from io import BytesIO, StringIO
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import BoundedSemaphore
from typing import Annotated, Literal

from pydantic import Field

from .contracts import Strict
from .document_worker import MAX_INPUT, MAX_TEXT

PARSE_GRANT = "agent.documents_parse"
EXPORT_GRANT = "agent.report_export"
INPUT_LIMIT = MAX_INPUT
FORMATS = {
    "csv": "text/csv", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "pdf": "application/pdf",
}
DEFAULT_NOTO = Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
ReportFormat = Literal["csv", "xlsx", "docx", "pdf"]
ReportKind = Literal["personal-brief", "warehouse-summary"]
ReportLocale = Literal["zh-CN", "zh-HK", "en"]
_ALLOWED_ERRORS = {
    "DOCUMENT_LIMIT", "DOCUMENT_INVALID", "DOCUMENT_ENCRYPTED", "DOCUMENT_ENCRYPTED_OR_LEGACY",
    "DOCUMENT_ACTIVE_CONTENT", "DOCUMENT_NO_TEXT", "DOCUMENT_TOOLS_UNAVAILABLE",
}


class ExtractedDocument(Strict):
    content: Annotated[str, Field(min_length=1, max_length=MAX_TEXT)]
    warnings: Annotated[list[str], Field(max_length=10)]


class DocumentError(ValueError):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.status = status


@dataclass(frozen=True)
class Report:
    title: str
    period: str
    header: tuple[str, str]
    rows: tuple[tuple[str, str | int], ...]


def _spreadsheet_text(value):
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


class DocumentTools:
    def __init__(self, *, font: Path = DEFAULT_NOTO, font_index: int | None = None, ocr_languages: str = ""):
        packages = ("pypdfium2", "docx", "pptx", "openpyxl", "defusedxml", "fpdf", "PIL")
        if missing := [name for name in packages if find_spec(name) is None]:
            raise ValueError("Install requirements-platform-documents.txt (" + ", ".join(missing) + ")")
        if sys.platform != "linux":
            raise ValueError("Cloud document workers require Linux resource isolation")
        if ocr_languages and (
            not re.fullmatch(r"[a-z0-9_]{2,16}(?:\+[a-z0-9_]{2,16}){0,3}", ocr_languages)
            or shutil.which("tesseract", path=os.defpath) is None
        ):
            raise ValueError("Configure valid Tesseract languages with an installed Tesseract binary")
        if font_index is not None and not 0 <= font_index <= 32:
            raise ValueError("Report font index is outside the supported range")
        self.font = font if font.is_file() else None
        self.font_index = font_index
        self.ocr_languages = ocr_languages
        self._parsing = BoundedSemaphore(2)
        self._rendering = BoundedSemaphore(2)

    @property
    def report_formats(self):
        return [fmt for fmt in FORMATS if fmt != "pdf" or self.font is not None]

    @staticmethod
    def file_kind(name: str) -> str:
        if not name or not name.isprintable() or any(ch in name for ch in "/\\"):
            raise DocumentError("DOCUMENT_INVALID_NAME", 422)
        kind = Path(name).suffix.lower().removeprefix(".")
        if kind not in {"docx", "xlsx", "pptx", "pdf"}:
            raise DocumentError("DOCUMENT_FORMAT_UNSUPPORTED", 415)
        return kind

    def parse(self, kind: str, raw: bytes) -> ExtractedDocument:
        if kind not in {"docx", "xlsx", "pptx", "pdf"}:
            raise DocumentError("DOCUMENT_FORMAT_UNSUPPORTED", 415)
        if not raw or len(raw) > INPUT_LIMIT:
            raise DocumentError("DOCUMENT_LIMIT", 413)
        if not self._parsing.acquire(blocking=False):
            raise DocumentError("DOCUMENT_BUSY", 503)
        try:
            with TemporaryDirectory(prefix="aios-document-") as scratch:
                worker = subprocess.Popen(
                    [sys.executable, "-I", str(Path(__file__).with_name("document_worker.py").resolve()),
                     kind, self.ocr_languages],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    cwd=scratch, start_new_session=True,
                    env={"PATH": os.defpath, "HOME": scratch, "LANG": "C.UTF-8", "OMP_THREAD_LIMIT": "1",
                         "PYTHONUTF8": "1", "TMPDIR": scratch},
                )
                try:
                    output, _ = worker.communicate(input=raw, timeout=17)
                except subprocess.TimeoutExpired as error:
                    try:
                        os.killpg(worker.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    worker.communicate()
                    raise DocumentError("DOCUMENT_TIMEOUT", 503) from error
            if worker.returncode != 0:
                raise DocumentError("DOCUMENT_LIMIT", 422)
            if len(output) > 800_000:
                raise DocumentError("DOCUMENT_LIMIT", 422)
            result = json.loads(output)
            if isinstance(result, dict) and result.get("error") in _ALLOWED_ERRORS:
                code = result["error"]
                raise DocumentError(code, 503 if code == "DOCUMENT_TOOLS_UNAVAILABLE" else 422)
            return ExtractedDocument.model_validate(result)
        except DocumentError:
            raise
        except (ValueError, OSError) as error:
            raise DocumentError("DOCUMENT_TOOLS_UNAVAILABLE", 503) from error
        finally:
            self._parsing.release()

    def render(self, report: Report, fmt: ReportFormat, locale: ReportLocale) -> bytes:
        if fmt not in self.report_formats:
            raise DocumentError("REPORT_FORMAT_UNAVAILABLE", 503)
        if not self._rendering.acquire(blocking=False):
            raise DocumentError("REPORT_BUSY", 503)
        try:
            try:
                if fmt == "pdf":
                    return self._pdf(report, locale)
                return {"csv": _csv, "xlsx": _xlsx, "docx": _docx}[fmt](report)
            except (OSError, ValueError, KeyError) as error:
                raise DocumentError("REPORT_RENDER_FAILED", 503) from error
        finally:
            self._rendering.release()

    def _pdf(self, report: Report, locale: ReportLocale) -> bytes:
        from fpdf import FPDF
        from fpdf.fonts import FontFace
        pdf = FPDF()
        index = self.font_index
        if index is None:
            index = {"zh-CN": 2, "zh-HK": 4, "en": 0}[locale] if self.font == DEFAULT_NOTO else 0
        pdf.add_font("work", fname=self.font, collection_font_number=index)
        pdf.set_title(report.title)
        pdf.set_auto_page_break(auto=True, margin=18)
        pdf.add_page()
        pdf.set_font("work", size=20)
        pdf.multi_cell(w=0, h=12, text=report.title, new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("work", size=10)
        pdf.multi_cell(w=0, h=8, text=report.period, new_x="LMARGIN", new_y="NEXT")
        with pdf.table(col_widths=(3, 2), line_height=9, headings_style=FontFace(fill_color=(229, 235, 243))) as table:
            table.row(report.header)
            for label, value in report.rows:
                table.row((label, str(value)))
        return bytes(pdf.output())


def _csv(report: Report) -> bytes:
    output = StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow((_spreadsheet_text(report.title), _spreadsheet_text(report.period)))
    writer.writerow(report.header)
    writer.writerows((_spreadsheet_text(label), _spreadsheet_text(value)) for label, value in report.rows)
    return output.getvalue().encode("utf-8-sig")


def _xlsx(report: Report) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    book = Workbook()
    sheet = book.active
    sheet.title = "Report"
    sheet.append((_spreadsheet_text(report.title), _spreadsheet_text(report.period)))
    sheet.append(report.header)
    for row in report.rows:
        sheet.append(tuple(_spreadsheet_text(value) for value in row))
    sheet.column_dimensions["A"].width = 38
    sheet.column_dimensions["B"].width = 38
    sheet.freeze_panes = "A3"
    for cell in sheet[2]:
        cell.font = Font(bold=True)
    output = BytesIO()
    book.save(output)
    book.close()
    return output.getvalue()


def _docx(report: Report) -> bytes:
    from docx import Document

    doc = Document()
    doc.add_heading(report.title, level=0)
    doc.add_paragraph(report.period)
    table = doc.add_table(rows=1, cols=2)
    table.style = "Light Shading Accent 1"
    for cell, label in zip(table.rows[0].cells, report.header):
        cell.text = label
    for row in report.rows:
        for cell, value in zip(table.add_row().cells, row):
            cell.text = str(value)
    output = BytesIO()
    doc.save(output)
    return output.getvalue()
