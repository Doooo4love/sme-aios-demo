"""API-first workspace document parsing, OOXML draft generation, and LibreOffice preview hook."""
from __future__ import annotations

import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any, Callable
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape as xml_escape
import zipfile

if __package__ in (None, ""):
    from sandbox import WorkspaceSandbox
else:
    from .sandbox import WorkspaceSandbox

_SECRET_ENV_PREFIXES = (
    "DEEPSEEK_",
    "OPENAI_",
    "ANTHROPIC_",
    "GEMINI_",
    "QWEN_",
    "AIOS_LLM_",
    "AIOS_DEMO_SECRET",
    "AIOS_ASSURANCE_KEY",
    "AIOS_BROWSER_SESSION",
    "AIOS_REVIEWER_",
    "CLOUDFLARE_",
)


def _sanitized_subprocess_env() -> dict[str, str]:
    """Strip any LLM/API secrets before spawning local utilities such as LibreOffice."""
    clean: dict[str, str] = {}
    for key, val in os.environ.items():
        upper = key.upper()
        if any(upper.startswith(p) for p in _SECRET_ENV_PREFIXES):
            continue
        if upper.endswith("_API_KEY") or upper.endswith("_SECRET") or upper.endswith("_TOKEN"):
            continue
        clean[key] = val
    return clean


def _has_module(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def inspect_capabilities() -> dict[str, Any]:
    """Probe optional OSS document/CUA libraries and binaries without failing on stdlib-only hosts."""
    packages = {
        "docling": _has_module("docling"),
        "markitdown": _has_module("markitdown"),
        "python_docx": _has_module("docx"),
        "python_pptx": _has_module("pptx"),
        "openpyxl": _has_module("openpyxl"),
        "playwright": _has_module("playwright"),
        "presidio": _has_module("presidio_analyzer"),
        "omniparser": _has_module("omniparser") or bool(os.environ.get("OMNIPARSER_HOME")),
    }
    soffice_bin = shutil.which("soffice") or shutil.which("libreoffice")
    pdftoppm_bin = shutil.which("pdftoppm")

    return {
        "native_stdlib_ready": True,
        "native_formats": [".txt", ".md", ".csv", ".tsv", ".json", ".docx", ".pptx", ".xlsx"],
        "optional_packages": packages,
        "system_binaries": {
            "libreoffice": bool(soffice_bin),
            "libreoffice_path": soffice_bin,
            "pdftoppm": bool(pdftoppm_bin),
        },
        "recommended_engines": {
            "pdf": "docling" if packages["docling"] else ("markitdown" if packages["markitdown"] else "unavailable"),
            "docx": "python-docx" if packages["python_docx"] else "stdlib-ooxml",
            "pptx": "python-pptx" if packages["python_pptx"] else "stdlib-ooxml",
            "xlsx": "openpyxl" if packages["openpyxl"] else "stdlib-ooxml",
            "pii_redaction": "presidio+regex" if packages["presidio"] else "stdlib-regex",
            "visual_qa_preview": "libreoffice" if soffice_bin else "unavailable",
        },
    }


def _csv_to_markdown(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    header = rows[0]
    width = max(len(r) for r in rows)
    pad = lambda r: [c.replace("|", "\\|").strip() for c in (r + [""] * (width - len(r)))]
    lines = [
        "| " + " | ".join(pad(header)) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    for row in rows[1:]:
        lines.append("| " + " | ".join(pad(row)) + " |")
    return "\n".join(lines)


def _extract_docx_stdlib(path: Path) -> str:
    with zipfile.ZipFile(path, "r") as zf:
        xml_bytes = zf.read("word/document.xml")
    root = ET.fromstring(xml_bytes)
    paragraphs: list[str] = []
    for p_el in root.iter():
        if p_el.tag.endswith("}p"):
            texts = [t.text for t in p_el.iter() if t.tag.endswith("}t") and t.text]
            if texts:
                paragraphs.append("".join(texts))
    return "\n".join(paragraphs)


def _extract_pptx_stdlib(path: Path) -> str:
    chunks: list[str] = []
    with zipfile.ZipFile(path, "r") as zf:
        slide_names = sorted(
            name for name in zf.namelist()
            if re.match(r"^ppt/slides/slide\d+\.xml$", name)
        )
        for idx, name in enumerate(slide_names, start=1):
            root = ET.fromstring(zf.read(name))
            texts = [t.text.strip() for t in root.iter() if t.tag.endswith("}t") and t.text and t.text.strip()]
            if texts:
                chunks.append(f"## Slide {idx}\n" + "\n".join(texts))
    return "\n\n".join(chunks)


def _extract_xlsx_stdlib(path: Path) -> str:
    rows_out: list[list[str]] = []
    with zipfile.ZipFile(path, "r") as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            s_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in s_root:
                parts = [t.text for t in si.iter() if t.tag.endswith("}t") and t.text]
                shared.append("".join(parts))

        sheet_names = sorted(
            name for name in zf.namelist()
            if re.match(r"^xl/worksheets/sheet\d+\.xml$", name)
        )
        if sheet_names:
            w_root = ET.fromstring(zf.read(sheet_names[0]))
            for row_el in w_root.iter():
                if not row_el.tag.endswith("}row"):
                    continue
                row_vals: list[str] = []
                for cell in row_el:
                    if not cell.tag.endswith("}c"):
                        continue
                    cell_type = cell.attrib.get("t", "")
                    val_text = ""
                    if cell_type == "inlineStr":
                        val_text = "".join(t.text for t in cell.iter() if t.tag.endswith("}t") and t.text)
                    else:
                        v_el = next((c for c in cell if c.tag.endswith("}v")), None)
                        raw_v = v_el.text if v_el is not None and v_el.text is not None else ""
                        if cell_type == "s" and raw_v.isdigit():
                            idx = int(raw_v)
                            val_text = shared[idx] if 0 <= idx < len(shared) else raw_v
                        else:
                            val_text = raw_v
                    row_vals.append(val_text)
                if any(row_vals):
                    rows_out.append(row_vals)
    return _csv_to_markdown(rows_out)


def parse_document(
    sandbox: WorkspaceSandbox,
    path: str | Path,
    *,
    max_chars: int = 200_000,
) -> dict[str, Any]:
    """Parse a workspace document inside `sandbox` using API-first native or optional OSS parsers."""
    resolved = sandbox.resolve_path(path, allow_nonexistent=False)
    if not resolved.is_file():
        raise IsADirectoryError(f"Expected a document file inside workspace: {path}")

    rel_path = sandbox.relative_posix(resolved)
    ext = resolved.suffix.lower()

    if ext in {".txt", ".md", ".markdown", ".log"}:
        raw_text = sandbox.read_text(resolved)
        truncated = len(raw_text) > max_chars
        text = raw_text[:max_chars]
        return {
            "status": "parsed",
            "path": rel_path,
            "format": ext.lstrip("."),
            "engine": "stdlib-text",
            "text": text,
            "char_count": len(raw_text),
            "line_count": len(raw_text.splitlines()),
            "truncated": truncated,
            "metadata": {},
        }

    if ext in {".csv", ".tsv"}:
        raw_text = sandbox.read_text(resolved)
        delimiter = "\t" if ext == ".tsv" else ","
        rows = list(csv.reader(io.StringIO(raw_text), delimiter=delimiter))
        md_text = _csv_to_markdown(rows)
        truncated = len(md_text) > max_chars
        return {
            "status": "parsed",
            "path": rel_path,
            "format": ext.lstrip("."),
            "engine": "stdlib-csv",
            "text": md_text[:max_chars],
            "char_count": len(md_text),
            "line_count": len(rows),
            "truncated": truncated,
            "metadata": {
                "headers": rows[0] if rows else [],
                "row_count": max(0, len(rows) - 1),
            },
        }

    if ext == ".json":
        raw_text = sandbox.read_text(resolved)
        parsed = json.loads(raw_text)
        pretty = json.dumps(parsed, ensure_ascii=False, indent=2)
        truncated = len(pretty) > max_chars
        return {
            "status": "parsed",
            "path": rel_path,
            "format": "json",
            "engine": "stdlib-json",
            "text": pretty[:max_chars],
            "char_count": len(pretty),
            "line_count": len(pretty.splitlines()),
            "truncated": truncated,
            "metadata": {"top_level_type": type(parsed).__name__},
        }

    if ext == ".docx":
        engine = "stdlib-ooxml"
        if _has_module("docx"):
            import docx  # type: ignore[import-not-found]

            doc = docx.Document(str(resolved))
            text = "\n".join(p.text for p in doc.paragraphs if p.text)
            engine = "python-docx"
        elif _has_module("markitdown"):
            from markitdown import MarkItDown  # type: ignore[import-not-found]

            text = str(MarkItDown().convert(str(resolved)).text_content or "")
            engine = "markitdown"
        else:
            text = _extract_docx_stdlib(resolved)
        truncated = len(text) > max_chars
        return {
            "status": "parsed",
            "path": rel_path,
            "format": "docx",
            "engine": engine,
            "text": text[:max_chars],
            "char_count": len(text),
            "line_count": len(text.splitlines()),
            "truncated": truncated,
            "metadata": {},
        }

    if ext == ".pptx":
        engine = "stdlib-ooxml"
        if _has_module("pptx"):
            import pptx  # type: ignore[import-not-found]

            prs = pptx.Presentation(str(resolved))
            slide_texts: list[str] = []
            for idx, slide in enumerate(prs.slides, start=1):
                lines = [
                    shape.text.strip()
                    for shape in slide.shapes
                    if getattr(shape, "has_text_frame", False) and shape.text.strip()
                ]
                if lines:
                    slide_texts.append(f"## Slide {idx}\n" + "\n".join(lines))
            text = "\n\n".join(slide_texts)
            engine = "python-pptx"
        else:
            text = _extract_pptx_stdlib(resolved)
        truncated = len(text) > max_chars
        return {
            "status": "parsed",
            "path": rel_path,
            "format": "pptx",
            "engine": engine,
            "text": text[:max_chars],
            "char_count": len(text),
            "line_count": len(text.splitlines()),
            "truncated": truncated,
            "metadata": {},
        }

    if ext == ".xlsx":
        engine = "stdlib-ooxml"
        if _has_module("openpyxl"):
            import openpyxl  # type: ignore[import-not-found]

            wb = openpyxl.load_workbook(str(resolved), data_only=True, read_only=True)
            ws = wb.active
            rows_vals = [
                ["" if cell is None else str(cell) for cell in row]
                for row in ws.iter_rows(values_only=True)
            ]
            wb.close()
            text = _csv_to_markdown(rows_vals)
            engine = "openpyxl"
        else:
            text = _extract_xlsx_stdlib(resolved)
        truncated = len(text) > max_chars
        return {
            "status": "parsed",
            "path": rel_path,
            "format": "xlsx",
            "engine": engine,
            "text": text[:max_chars],
            "char_count": len(text),
            "line_count": len(text.splitlines()),
            "truncated": truncated,
            "metadata": {},
        }

    if ext == ".pdf":
        if _has_module("docling"):
            from docling.document_converter import DocumentConverter  # type: ignore[import-not-found]

            res = DocumentConverter().convert(str(resolved))
            text = res.document.export_to_markdown()
            return {
                "status": "parsed",
                "path": rel_path,
                "format": "pdf",
                "engine": "docling",
                "text": text[:max_chars],
                "char_count": len(text),
                "line_count": len(text.splitlines()),
                "truncated": len(text) > max_chars,
                "metadata": {},
            }
        if _has_module("markitdown"):
            from markitdown import MarkItDown  # type: ignore[import-not-found]

            text = str(MarkItDown().convert(str(resolved)).text_content or "")
            return {
                "status": "parsed",
                "path": rel_path,
                "format": "pdf",
                "engine": "markitdown",
                "text": text[:max_chars],
                "char_count": len(text),
                "line_count": len(text.splitlines()),
                "truncated": len(text) > max_chars,
                "metadata": {},
            }
        return {
            "status": "unavailable",
            "path": rel_path,
            "format": "pdf",
            "engine": None,
            "requires_one_of": ["docling", "markitdown"],
            "text": "",
            "char_count": 0,
            "line_count": 0,
            "truncated": False,
            "metadata": {},
        }

    raise ValueError(f"Unsupported document extension: {ext}")


def _ensure_extension(path: str | Path, expected_ext: str) -> None:
    if Path(os.fspath(path)).suffix.lower() != expected_ext:
        raise ValueError(f"Output path must use '{expected_ext}' extension: {path}")


def build_docx_draft(
    sandbox: WorkspaceSandbox,
    output_path: str | Path,
    *,
    title: str,
    paragraphs: list[str],
    tables: list[list[list[str]]] | None = None,
) -> dict[str, Any]:
    """Create a Word (.docx) draft inside `sandbox` using python-docx or pure stdlib OOXML."""
    _ensure_extension(output_path, ".docx")
    resolved = sandbox.resolve_path(output_path, allow_nonexistent=True)
    resolved.parent.mkdir(parents=True, exist_ok=True)

    if _has_module("docx"):
        import docx  # type: ignore[import-not-found]

        doc = docx.Document()
        doc.add_heading(title, level=1)
        for p in paragraphs:
            doc.add_paragraph(p)
        for tbl in tables or []:
            if not tbl:
                continue
            cols = max(len(r) for r in tbl)
            word_tbl = doc.add_table(rows=len(tbl), cols=cols)
            for r_idx, row in enumerate(tbl):
                for c_idx, val in enumerate(row):
                    word_tbl.cell(r_idx, c_idx).text = str(val)
        doc.save(str(resolved))
        engine = "python-docx"
    else:
        body_parts = [
            f"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{xml_escape(title)}</w:t></w:r></w:p>"
        ]
        for p in paragraphs:
            body_parts.append(
                f'<w:p><w:r><w:t xml:space="preserve">{xml_escape(p)}</w:t></w:r></w:p>'
            )
        for tbl in tables or []:
            rows_xml = []
            for row in tbl:
                cells_xml = "".join(
                    f'<w:tc><w:p><w:r><w:t xml:space="preserve">{xml_escape(str(c))}</w:t></w:r></w:p></w:tc>'
                    for c in row
                )
                rows_xml.append(f"<w:tr>{cells_xml}</w:tr>")
            body_parts.append(f"<w:tbl>{''.join(rows_xml)}</w:tbl>")

        document_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body>{''.join(body_parts)}<w:sectPr/></w:body>"
            "</w:document>"
        )
        content_types = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>"
        )
        rels_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/>'
            "</Relationships>"
        )
        with zipfile.ZipFile(resolved, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("[Content_Types].xml", content_types)
            zf.writestr("_rels/.rels", rels_xml)
            zf.writestr("word/document.xml", document_xml)
        engine = "stdlib-ooxml"

    return {
        "status": "written",
        "path": sandbox.relative_posix(resolved),
        "format": "docx",
        "engine": engine,
        "bytes": resolved.stat().st_size,
    }


def build_pptx_draft(
    sandbox: WorkspaceSandbox,
    output_path: str | Path,
    *,
    title: str,
    slides: list[dict[str, Any]],
) -> dict[str, Any]:
    """Create a PowerPoint (.pptx) draft inside `sandbox` using python-pptx or pure stdlib OOXML."""
    _ensure_extension(output_path, ".pptx")
    resolved = sandbox.resolve_path(output_path, allow_nonexistent=True)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    normalized_slides = slides or [{"title": title, "bullets": []}]

    if _has_module("pptx"):
        import pptx  # type: ignore[import-not-found]

        prs = pptx.Presentation()
        layout = prs.slide_layouts[1] if len(prs.slide_layouts) > 1 else prs.slide_layouts[0]
        for slide_spec in normalized_slides:
            slide = prs.slides.add_slide(layout)
            if slide.shapes.title:
                slide.shapes.title.text = str(slide_spec.get("title") or title)
            if len(slide.placeholders) > 1:
                tf = slide.placeholders[1].text_frame
                bullets = [str(b) for b in (slide_spec.get("bullets") or [])]
                if bullets:
                    tf.text = bullets[0]
                    for item in bullets[1:]:
                        tf.add_paragraph().text = item
        prs.save(str(resolved))
        engine = "python-pptx"
    else:
        slide_overrides = []
        slide_rels = []
        slide_ids = []
        with zipfile.ZipFile(resolved, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for idx, slide_spec in enumerate(normalized_slides, start=1):
                s_title = str(slide_spec.get("title") or title)
                bullets = [str(b) for b in (slide_spec.get("bullets") or [])]
                text_lines = [s_title] + bullets
                paras = "".join(
                    f"<a:p><a:r><a:t>{xml_escape(line)}</a:t></a:r></a:p>"
                    for line in text_lines
                )
                slide_xml = (
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
                    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
                    "<p:cSld><p:spTree>"
                    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
                    "<p:grpSpPr/>"
                    "<p:sp>"
                    '<p:nvSpPr><p:cNvPr id="2" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
                    "<p:spPr/>"
                    f"<p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody>"
                    "</p:sp>"
                    "</p:spTree></p:cSld></p:sld>"
                )
                zf.writestr(f"ppt/slides/slide{idx}.xml", slide_xml)
                slide_overrides.append(
                    f'<Override PartName="/ppt/slides/slide{idx}.xml" '
                    'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
                )
                slide_rels.append(
                    f'<Relationship Id="rId{idx}" '
                    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
                    f'Target="slides/slide{idx}.xml"/>'
                )
                slide_ids.append(f'<p:sldId id="{255 + idx}" r:id="rId{idx}"/>')

            content_types = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                '<Default Extension="xml" ContentType="application/xml"/>'
                '<Override PartName="/ppt/presentation.xml" '
                'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
                f"{''.join(slide_overrides)}"
                "</Types>"
            )
            root_rels = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                'Target="ppt/presentation.xml"/>'
                "</Relationships>"
            )
            pres_rels = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                f"{''.join(slide_rels)}"
                "</Relationships>"
            )
            pres_xml = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
                'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
                f"<p:sldIdLst>{''.join(slide_ids)}</p:sldIdLst>"
                "</p:presentation>"
            )
            zf.writestr("[Content_Types].xml", content_types)
            zf.writestr("_rels/.rels", root_rels)
            zf.writestr("ppt/_rels/presentation.xml.rels", pres_rels)
            zf.writestr("ppt/presentation.xml", pres_xml)
        engine = "stdlib-ooxml"

    return {
        "status": "written",
        "path": sandbox.relative_posix(resolved),
        "format": "pptx",
        "engine": engine,
        "slide_count": len(normalized_slides),
        "bytes": resolved.stat().st_size,
    }


def _col_letter(index: int) -> str:
    letters = ""
    n = index + 1
    while n > 0:
        n, rem = divmod(n - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def build_xlsx_draft(
    sandbox: WorkspaceSandbox,
    output_path: str | Path,
    *,
    sheet_name: str,
    headers: list[str],
    rows: list[list[Any]],
) -> dict[str, Any]:
    """Create an Excel (.xlsx) draft inside `sandbox` using openpyxl or pure stdlib OOXML."""
    _ensure_extension(output_path, ".xlsx")
    resolved = sandbox.resolve_path(output_path, allow_nonexistent=True)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    safe_sheet = re.sub(r"[\\/*?:\[\]]+", "_", sheet_name).strip()[:31] or "Sheet1"
    all_rows = ([headers] if headers else []) + list(rows)

    if _has_module("openpyxl"):
        import openpyxl  # type: ignore[import-not-found]

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = safe_sheet
        for row in all_rows:
            ws.append(list(row))
        wb.save(str(resolved))
        engine = "openpyxl"
    else:
        row_xml_parts: list[str] = []
        for r_idx, row in enumerate(all_rows, start=1):
            cells_xml: list[str] = []
            for c_idx, value in enumerate(row):
                ref = f"{_col_letter(c_idx)}{r_idx}"
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    cells_xml.append(f'<c r="{ref}"><v>{value}</v></c>')
                else:
                    cells_xml.append(
                        f'<c r="{ref}" t="inlineStr"><is><t>{xml_escape(str(value))}</t></is></c>'
                    )
            row_xml_parts.append(f'<row r="{r_idx}">{"".join(cells_xml)}</row>')

        sheet_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f"<sheetData>{''.join(row_xml_parts)}</sheetData>"
            "</worksheet>"
        )
        workbook_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheets><sheet name="{xml_escape(safe_sheet)}" sheetId="1" r:id="rId1"/></sheets>'
            "</workbook>"
        )
        wb_rels = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            'Target="worksheets/sheet1.xml"/>'
            "</Relationships>"
        )
        root_rels = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="xl/workbook.xml"/>'
            "</Relationships>"
        )
        content_types = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            "</Types>"
        )
        with zipfile.ZipFile(resolved, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("[Content_Types].xml", content_types)
            zf.writestr("_rels/.rels", root_rels)
            zf.writestr("xl/_rels/workbook.xml.rels", wb_rels)
            zf.writestr("xl/workbook.xml", workbook_xml)
            zf.writestr("xl/worksheets/sheet1.xml", sheet_xml)
        engine = "stdlib-ooxml"

    return {
        "status": "written",
        "path": sandbox.relative_posix(resolved),
        "format": "xlsx",
        "engine": engine,
        "row_count": len(rows),
        "bytes": resolved.stat().st_size,
    }


def render_libreoffice_preview(
    sandbox: WorkspaceSandbox,
    input_path: str | Path,
    output_dir: str | Path = "previews",
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> dict[str, Any]:
    """Render Office/PDF document to PNG inside `sandbox` via headless LibreOffice for visual overlap QA."""
    resolved_in = sandbox.resolve_path(input_path, allow_nonexistent=False)
    resolved_out = sandbox.resolve_path(output_dir, allow_nonexistent=True)
    resolved_out.mkdir(parents=True, exist_ok=True)

    soffice_bin = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice_bin and runner is None:
        return {
            "status": "unavailable",
            "engine": "libreoffice",
            "input_path": sandbox.relative_posix(resolved_in),
            "output_dir": sandbox.relative_posix(resolved_out),
            "png_paths": [],
            "visual_qa_ready": False,
            "message": "LibreOffice (soffice) is not installed on this host; skipping PNG preview render.",
        }

    cmd = [
        soffice_bin or "soffice",
        "--headless",
        "--norestore",
        "--convert-to",
        "png",
        "--outdir",
        str(resolved_out),
        str(resolved_in),
    ]
    exec_fn = runner or subprocess.run
    proc = exec_fn(
        cmd,
        shell=False,
        capture_output=True,
        text=True,
        timeout=30,
        env=_sanitized_subprocess_env(),
        cwd=str(sandbox.root_dir),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"LibreOffice preview conversion failed (exit={proc.returncode}).")

    pngs = sorted(
        sandbox.relative_posix(sandbox.resolve_path(p, allow_nonexistent=False))
        for p in resolved_out.glob("*.png")
    )
    return {
        "status": "rendered",
        "engine": "libreoffice",
        "input_path": sandbox.relative_posix(resolved_in),
        "output_dir": sandbox.relative_posix(resolved_out),
        "png_paths": pngs,
        "visual_qa_ready": len(pngs) > 0,
        "message": f"Rendered {len(pngs)} PNG preview(s) inside workspace sandbox.",
    }
