"""Resource-bounded document extraction child. Input bytes only arrive on stdin."""
from io import BytesIO
import json
import re

import subprocess
import sys
from zipfile import BadZipFile, ZipFile

MAX_INPUT = 5_000_000
MAX_TEXT = 120_000
MAX_PAGES = 60
MAX_OCR_PAGES = 5
OFFICE_MAIN = {"docx": "word/document.xml", "xlsx": "xl/workbook.xml", "pptx": "ppt/presentation.xml"}
_ACTIVE_PART = re.compile(r"(?i)(?:vbaproject|activex/|embeddings/)")


class Rejected(ValueError):
    pass


class ExtractedText:
    def __init__(self):
        self.lines = []
        self.remaining = MAX_TEXT
        self.warnings = set()

    def add(self, anchor, text):
        for line in str(text).splitlines():
            clean = " ".join("".join(ch for ch in line if ch.isprintable() or ch.isspace()).split())
            if not clean:
                continue
            if self.remaining < len(anchor) + 8:
                self.warnings.add("TEXT_TRUNCATED")
                return
            width = min(1200, self.remaining - len(anchor) - 5, len(clean))
            self.lines.append(f"[{anchor}] {clean[:width]}")
            self.remaining -= len(self.lines[-1]) + 1
            if width < len(clean):
                self.warnings.add("TEXT_TRUNCATED")

    def full(self):
        return self.remaining < 128

    def result(self):
        return {"content": "\n".join(self.lines), "warnings": sorted(self.warnings)}


def preflight_office(raw, kind):
    from defusedxml.ElementTree import fromstring
    try:
        with ZipFile(BytesIO(raw)) as archive:
            entries = archive.infolist()
            names = [item.filename for item in entries]
            if (len(entries) > 1200 or len(set(names)) != len(names)
                    or sum(item.file_size for item in entries) > 48_000_000):
                raise Rejected("DOCUMENT_LIMIT")
            if not {OFFICE_MAIN[kind], "[Content_Types].xml"} <= set(names):
                raise Rejected("DOCUMENT_INVALID")
            for item in entries:
                if item.flag_bits & 1:
                    raise Rejected("DOCUMENT_ENCRYPTED")
                if item.file_size > 12_000_000 or item.file_size > max(1, item.compress_size) * 250 + 100_000:
                    raise Rejected("DOCUMENT_LIMIT")
                if _ACTIVE_PART.search(item.filename):
                    raise Rejected("DOCUMENT_ACTIVE_CONTENT")
            content_types = fromstring(archive.read("[Content_Types].xml"))
            if any("macroenabled" in node.get("ContentType", "").lower() for node in content_types):
                raise Rejected("DOCUMENT_ACTIVE_CONTENT")
    except BadZipFile as error:
        raise Rejected("DOCUMENT_INVALID") from error


def word(raw, out):
    from docx import Document
    from docx.text.paragraph import Paragraph
    for index, block in enumerate(Document(BytesIO(raw)).iter_inner_content(), 1):
        if out.full():
            out.warnings.add("TEXT_TRUNCATED")
            break
        if isinstance(block, Paragraph):
            out.add(f"Paragraph {index}", block.text)
        else:
            for row, cells in enumerate(block.rows, 1):
                if row > 100 or out.full():
                    out.warnings.add("TABLE_LIMIT")
                    break
                out.add(f"Table {index} row {row}", " | ".join(cell.text for cell in cells.cells[:32]))


def slides(raw, out):
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    def shapes(items, slide, depth=0):
        if depth > 8:
            out.warnings.add("SLIDE_LIMIT")
            return
        for shape in items:
            if out.full():
                return
            if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                shapes(shape.shapes, slide, depth + 1)
            elif shape.has_text_frame:
                out.add(f"Slide {slide}", shape.text)
            elif shape.has_table:
                for index, row in enumerate(shape.table.rows, 1):
                    if index > 100 or out.full():
                        out.warnings.add("TABLE_LIMIT")
                        break
                    out.add(f"Slide {slide} table row {index}", " | ".join(c.text for c in list(row.cells)[:32]))

    presentation = Presentation(BytesIO(raw))
    for index, slide in enumerate(presentation.slides, 1):
        if index > MAX_PAGES or out.full():
            out.warnings.add("SLIDE_LIMIT")
            break
        if slide._element.get("show") != "0":
            shapes(slide.shapes, index)


def workbook(raw, out):
    from openpyxl import load_workbook
    book = load_workbook(BytesIO(raw), read_only=True, data_only=True, keep_vba=False, keep_links=False)
    try:
        out.warnings.add("XLSX_CACHED_VALUES_ONLY")
        for index, sheet in enumerate((s for s in book.worksheets if s.sheet_state == "visible"), 1):
            if index > 12 or out.full():
                out.warnings.add("SHEET_LIMIT")
                break
            if (sheet.max_row or 0) > 1000 or (sheet.max_column or 0) > 32:
                out.warnings.add("SHEET_LIMIT")
            sheet.reset_dimensions()
            title = " ".join(sheet.title.split())
            for n, values in enumerate(sheet.iter_rows(max_row=1001, max_col=33, values_only=True), 1):
                if n > 1000 or out.full():
                    if any(v is not None for v in values) or out.full():
                        out.warnings.add("SHEET_LIMIT")
                    break
                if values[32] is not None:
                    out.warnings.add("SHEET_LIMIT")
                cells = [" " if v is None else str(v)[:500] for v in values[:32]]
                while cells and not cells[-1].strip():
                    cells.pop()
                if cells:
                    out.add(f"Sheet {title} row {n}", " | ".join(cells))
    finally:
        book.close()


def read_pdf(raw, out, ocr_languages):
    import pypdfium2 as pdfium
    if not raw[:1024].lstrip().startswith(b"%PDF-"):
        raise Rejected("DOCUMENT_INVALID")
    try:
        pdf = pdfium.PdfDocument(raw)
    except pdfium.PdfiumError as error:
        if error.err_code == pdfium.raw.FPDF_ERR_PASSWORD:
            raise Rejected("DOCUMENT_ENCRYPTED") from error
        raise
    ocr_pages = 0
    try:
        for index in range(min(len(pdf), MAX_PAGES)):
            if out.full():
                out.warnings.add("TEXT_TRUNCATED")
                break
            page = pdf[index]
            try:
                text_page = page.get_textpage()
                try:
                    text = text_page.get_text_bounded()
                finally:
                    text_page.close()
                if not text.strip():
                    if ocr_languages and ocr_pages < MAX_OCR_PAGES:
                        ocr_pages += 1
                        text = ocr_page(page, ocr_languages)
                    if not text.strip():
                        out.warnings.add("PDF_PAGES_WITHOUT_TEXT")
                out.add(f"Page {index + 1}", text)
            finally:
                page.close()
        if len(pdf) > MAX_PAGES:
            out.warnings.add("PAGE_LIMIT")
    finally:
        pdf.close()


def ocr_page(page, languages):
    width, height = page.get_size()
    if min(width, height) <= 0:
        return ""
    scale = min(2.0, 1700 / max(width, height))
    image_buffer = BytesIO()
    bitmap = page.render(scale=scale)
    try:
        bitmap.to_pil().save(image_buffer, format="PNG")
    finally:
        bitmap.close()
    try:
        result = subprocess.run(
            ["tesseract", "stdin", "stdout", "-l", languages, "--psm", "3"],
            input=image_buffer.getvalue(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=2.5, check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""
    return result.stdout.decode("utf-8", errors="replace") if result.returncode == 0 else ""


def main():
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024**2, 768 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (13, 14))
    resource.setrlimit(resource.RLIMIT_FSIZE, (20_000_000, 20_000_000))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    kind, languages = sys.argv[1:3]
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    try:
        if not raw or len(raw) > MAX_INPUT:
            raise Rejected("DOCUMENT_LIMIT")
        if kind == "pdf":
            out = ExtractedText()
            read_pdf(raw, out, languages)
        else:
            if raw.startswith(b"\xd0\xcf\x11\xe0"):
                raise Rejected("DOCUMENT_ENCRYPTED_OR_LEGACY")
            preflight_office(raw, kind)
            out = ExtractedText()
            {"docx": word, "xlsx": workbook, "pptx": slides}[kind](raw, out)
        result = out.result()
        if not result["content"]:
            raise Rejected("DOCUMENT_NO_TEXT")
    except Rejected as error:
        result = {"error": str(error)}
    except MemoryError:
        result = {"error": "DOCUMENT_LIMIT"}
    except ImportError:
        result = {"error": "DOCUMENT_TOOLS_UNAVAILABLE"}
    except Exception:
        # Parser errors may contain input values or paths. Keep those out of server logs and responses.
        result = {"error": "DOCUMENT_INVALID"}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
