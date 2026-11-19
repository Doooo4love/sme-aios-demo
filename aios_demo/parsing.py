"""Read the demo PO schema with real Tesseract OCR and precise image evidence."""
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
from io import BytesIO, StringIO
from pathlib import Path
import csv
import re
import subprocess

from PIL import Image

PATTERNS = {
    "po": r"PO-[0-9]{4,10}",
    "buyer": r"HBR-[0-9]{2}",
    "delivery": r"[0-9]{4}-[0-9]{2}-[0-9]{2}",
    "currency": r"HKD|USD",
    "sku": r"[A-Z]{2,8}-[0-9]{1,6}",
    "quantity": r"[1-9][0-9]{0,3}",
    "unit": r"CASE|EACH",
    "unit_price": r"[0-9]{1,7}\.[0-9]{2}",
    "amount": r"[0-9]{1,7}\.[0-9]{2}",
    "total": r"[0-9]{1,7}\.[0-9]{2}",
}
HEADERS = {"PO NO": "po", "BUYER": "buyer", "DELIVERY": "delivery",
           "CURRENCY": "currency", "TOTAL": "total"}
ROW_FIELDS = ("sku", "quantity", "unit", "unit_price", "amount")
TABLE_HEAD = ("ITEM", "CODE", "QTY", "UNIT", "PRICE", "AMOUNT")


@dataclass(frozen=True)
class Observation:
    value: str
    source: str
    bbox: tuple[int, int, int, int]
    score: float | None = None


@dataclass
class Parsed:
    fields: dict[str, Observation]
    required: tuple[str, ...]
    row_count: int
    complete: bool
    page: Image.Image


def valid(field: str, value: str) -> bool:
    return bool(re.fullmatch(PATTERNS[field.rsplit(".", 1)[-1]], value))


def _tokens(page: Image.Image) -> list[list[dict]]:
    encoded = BytesIO()
    page.save(encoded, format="PNG")
    result = subprocess.run(
        ["tesseract", "stdin", "stdout", "--psm", "6", "-l", "eng", "tsv"],
        input=encoded.getvalue(), capture_output=True, check=True, timeout=12,
    )
    lines = defaultdict(list)
    for row in csv.DictReader(StringIO(result.stdout.decode()), delimiter="\t"):
        if row.get("level") != "5" or not row["text"].strip():
            continue
        key = (row["block_num"], row["par_num"], row["line_num"])
        x, y, w, h = (int(row[k]) for k in ("left", "top", "width", "height"))
        lines[key].append({"text": row["text"].strip(), "bbox": (x, y, x + w, y + h),
                           "score": float(row["conf"])})
    return list(lines.values())


def _line(words: list[dict]) -> tuple[str, list[tuple[int, int, dict]]]:
    spans = []
    start = 0
    for word in words:
        end = start + len(word["text"])
        spans.append((start, end, word))
        start = end + 1
    return " ".join(word["text"] for word in words), spans


def _evidence(value: str, words: list[dict]) -> Observation:
    edges = [word["bbox"] for word in words]
    return Observation(
        value, "tesseract-ocr", (min(b[0] for b in edges), min(b[1] for b in edges),
                                max(b[2] for b in edges), max(b[3] for b in edges)),
        round(min(word["score"] for word in words), 1),
    )


def parse_image(path: Path) -> Parsed:
    if path.stat().st_size > 8_000_000:
        raise ValueError("Image exceeds 8 MB")
    with Image.open(path) as source:
        if source.format not in {"PNG", "JPEG"} or source.width * source.height > 8_000_000:
            raise ValueError("Use PNG/JPEG under eight megapixels")
        page = source.convert("RGB")

    lines = _tokens(page)
    fields = {}
    duplicates = set()
    row_count = 0
    inside = False
    complete = True

    def remember(field: str, observation: Observation) -> None:
        if field in fields:
            duplicates.add(field)
        fields[field] = observation

    for words in lines:
        text, spans = _line(words)
        for label, field in HEADERS.items():
            for match in re.finditer(rf"(?<![A-Z]){label}:\s*(\S+)", text):
                value = match[1]
                if valid(field, value):
                    hits = [word for a, b, word in spans if b > match.start(1) and a < match.end(1)]
                    remember(field, _evidence(value, hits))
        if tuple(word["text"] for word in words) == TABLE_HEAD:
            if inside or row_count:
                complete = False
            inside = True
            continue
        if inside and text.startswith("TOTAL:"):
            inside = False
            continue
        if inside:
            row_count += 1
            if len(words) != len(ROW_FIELDS):
                complete = False
                continue
            for key, word in zip(ROW_FIELDS, words, strict=True):
                if valid(key, word["text"]):
                    remember(f"line.{row_count}.{key}", _evidence(word["text"], [word]))
    required = tuple(HEADERS.values()) + tuple(
        f"line.{number}.{key}" for number in range(1, row_count + 1) for key in ROW_FIELDS
    )
    return Parsed(fields, required, row_count, complete and not duplicates
                  and not inside and 0 < row_count <= 30, page)


def amount(value: str) -> Decimal:
    return Decimal(value)
