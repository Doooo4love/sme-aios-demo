"""Read the demo PO schema with real local OCR and pixel evidence."""
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
from io import BytesIO, StringIO
from pathlib import Path
import csv
import re
import subprocess

from PIL import Image, ImageChops, ImageFilter, ImageOps

PATTERNS = {
    "po": r"PO-[0-9]{4,10}",
    "buyer": r"HBR-[0-9]{2}",
    "delivery": r"[0-9]{4}-[0-9]{2}-[0-9]{2}",
    "currency": r"HKD|USD",
    "sku": r"[A-Z]{2,8}-(?:[0-9]{1,6}|[A-Z]{2,8})",
    "quantity": r"[1-9][0-9]{0,3}",
    "unit": r"CASE|EACH",
    "unit_price": r"[0-9]{1,7}\.[0-9]{2}",
    "amount": r"[0-9]{1,7}\.[0-9]{2}",
    "total": r"[0-9]{1,7}\.[0-9]{2}",
}
HEADERS = {"PO NO": "po", "BUYER": "buyer", "DELIVERY": "delivery",
           "CURRENCY": "currency", "TOTAL": "total"}
ROW_FIELDS = ("sku", "quantity", "unit", "unit_price", "amount")
MAX_UPLOAD_BYTES = 8_000_000
MAX_IMAGE_PIXELS = 8_000_000


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


def _native_tsv(data: bytes, segmentation: str, whitelist: str = "") -> bytes:
    args = ["tesseract", "stdin", "stdout", "--psm", segmentation, "-l", "eng"]
    if whitelist:
        args.extend(["-c", "tessedit_char_whitelist=" + whitelist])
    return subprocess.run(args + ["tsv"], input=data, capture_output=True,
                          check=True, timeout=12).stdout


def _tokens(page: Image.Image, segmentation="6", whitelist="", offset=(0, 0)) -> list[list[dict]]:
    encoded = BytesIO()
    page.save(encoded, format="PNG")
    try:
        output = _native_tsv(encoded.getvalue(), segmentation, whitelist)
        source = "tesseract-ocr"
    except FileNotFoundError:
        from .local_ocr import wasm_tsv
        output = wasm_tsv(encoded.getvalue(), segmentation, whitelist)
        source = "tesseract-wasm-ind"
    lines = defaultdict(list)
    for row in csv.DictReader(StringIO(output.decode()), delimiter="\t", quoting=csv.QUOTE_NONE):
        if row.get("level") != "5" or not row["text"].strip():
            continue
        x, y, w, h = (int(row[k]) for k in ("left", "top", "width", "height"))
        x += offset[0]
        y += offset[1]
        key = (row["block_num"], row["par_num"], row["line_num"])
        lines[key].append({"text": row["text"].strip(), "bbox": (x, y, x + w, y + h),
                           "score": float(row["conf"]), "source": source})
    return list(lines.values())


def _long_rules(ink: Image.Image, length: int) -> Image.Image:
    """Mark long, connected dark runs without changing the page geometry."""
    raw = ink.tobytes()
    mask = bytearray(len(raw))
    pattern = re.compile(b"\x00{%d,}" % length)
    for y in range(ink.height):
        start = y * ink.width
        for run in pattern.finditer(raw, start, start + ink.width):
            mask[run.start():run.end()] = b"\xff" * (run.end() - run.start())
    return Image.frombytes("L", ink.size, bytes(mask))


def _ruled_lines(page: Image.Image, lines: list[list[dict]]) -> list[list[dict]]:
    # Header/footer anchors bound the search. The table edges come from the rules
    # themselves. Unruled pages continue with their original OCR observations.
    preceding = [w["bbox"][3] for row in lines for w in row
                 if w["text"] in ("DELIVERY:", "CURRENCY:")]
    following = [w["bbox"][1] for row in lines for w in row if w["text"] == "TOTAL:"]
    if not preceding or not following or max(preceding) >= min(following):
        return lines
    top, bottom = max(preceding), min(following)
    gray = page.convert("L")
    background = gray.filter(ImageFilter.BoxBlur(max(8, min(gray.size) // 45)))
    ink = ImageChops.subtract(background, gray).point(lambda v: 0 if v >= 42 else 255)
    strip = ink.crop((0, top, ink.width, bottom))
    horizontal = _long_rules(strip, max(50, strip.width // 10))
    bands = []
    runs = []
    full_rule = re.compile(b"\xff{%d,}" % max(50, strip.width // 2))
    raw = horizontal.tobytes()
    for y in range(strip.height):
        start = y * strip.width
        for match in full_rule.finditer(raw, start, start + strip.width):
            runs.append((match.end() - match.start(), match.start() - start, match.end() - start))
            if not bands or y > bands[-1] + 1:
                bands.append(y)
            else:
                bands[-1] = y
    if len(bands) < 3:
        return lines
    _, left, right = max(runs)
    transpose = Image.Transpose.TRANSPOSE
    vertical = _long_rules(strip.transpose(transpose), max(48, page.height // 18)).transpose(transpose)
    mask = ImageChops.lighter(horizontal, vertical).filter(ImageFilter.MaxFilter(5))
    strip.paste(255, mask=mask)
    # Exclude the outer frame, retaining the whitespace around the characters.
    left += 5
    right -= 5
    table = _tokens(strip.crop((left, 0, right, strip.height)), offset=(left, top))
    before = [row for row in lines if min(w["bbox"][1] for w in row) < top]
    after = [row for row in lines if any(w["bbox"][1] >= bottom for w in row)
             and row not in before]
    return before + table + after


def _cell(page: Image.Image, word: dict, limits: tuple[int, int]):
    left, top, right, bottom = word["bbox"]
    x = max(limits[0], left - 2, 0)
    y = max(0, top - 2)
    right = min(right + 2, page.width, limits[1])
    bottom = min(bottom + 2, page.height)
    if x >= right or y >= bottom:
        return None
    gray = page.crop((x, y, right, bottom)).convert("L")
    ink = gray.point(lambda v: 255 if v < 135 else 0).getbbox()
    if ink is None:
        return None
    a, b, c, d = ink
    return gray.crop(ink), (x + a, y + b, x + c, y + d)


def _reread(crop: Image.Image, field: str, word: dict) -> dict:
    numeric = field in ("quantity", "unit_price", "amount", "total")
    whitelist = ("0123456789" if field == "quantity" else "0123456789.") if numeric else ""
    original = word["text"]
    readings = defaultdict(list)
    for mode, scale, threshold in (("7", 2, 135), ("8", 1, 110)):
        binary = crop.point(lambda v: 0 if v < threshold else 255)
        tight = ImageOps.invert(binary).getbbox()
        if tight is None:
            continue
        binary = binary.crop(tight)
        scan = binary.resize((binary.width * scale, binary.height * scale), Image.Resampling.LANCZOS)
        lines = _tokens(ImageOps.expand(scan, 12, 255), mode, whitelist)
        words = [token for line in lines for token in line]
        if len(words) != 1 or not valid(field, words[0]["text"]):
            continue
        text = words[0]["text"]
        readings[text].append(words[0]["score"])
        # A differently read, syntactically valid original needs corroboration.
        if text == original or not valid(field, original) or len(readings[text]) >= 2:
            score = max(readings[text] + ([word["score"]] if text == original else []))
            word = {**word, "text": text, "score": score}
            if score >= 80:
                break
    return word


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
        value, words[0].get("source", "tesseract-ocr"), (min(b[0] for b in edges), min(b[1] for b in edges),
                                max(b[2] for b in edges), max(b[3] for b in edges)),
        round(min(word["score"] for word in words), 1),
    )


def read_image(data: bytes) -> Image.Image:
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError("Image exceeds 8 MB")
    try:
        with Image.open(BytesIO(data), formats=("PNG", "JPEG")) as image:
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ValueError("Use images under eight megapixels")
            return ImageOps.exif_transpose(image).convert("RGB")
    except (OSError, Image.DecompressionBombError) as error:
        raise ValueError("Use a readable PNG or JPEG") from error


def parse_image(path: Path) -> Parsed:
    with path.open("rb") as file:
        return parse_page(read_image(file.read(MAX_UPLOAD_BYTES + 1)))


def parse_page(page: Image.Image) -> Parsed:
    lines = _ruled_lines(page, _tokens(page))
    edges = []
    rereads = 0
    fields = {}
    duplicates = set()
    row_count = 0
    inside = False
    complete = True

    def remember(field: str, observation: Observation) -> None:
        if field in fields:
            duplicates.add(field)
        fields[field] = observation

    for raw_words in lines:
        words = [w for w in raw_words if not re.fullmatch(r"[|¦]+", w["text"])]
        if not words:
            continue
        text, spans = _line(words)
        for label, field in HEADERS.items():
            for match in re.finditer(rf"(?<![A-Z]){label}:\s*(\S+)", text):
                value = match[1]
                hits = [word for a, b, word in spans if b > match.start(1) and a < match.end(1)]
                observation = _evidence(value, hits)
                if len(hits) == 1 and hits[0]["text"] == value and observation.score < 80 and rereads < 12:
                    rereads += 1
                    l, t, r, b = observation.bbox
                    region = page.crop((max(0, l - 8), max(0, t - 5),
                                        min(page.width, r + 8), min(page.height, b + 5)))
                    reread = [w for line in _tokens(region, "8") for w in line]
                    if len(reread) == 1 and reread[0]["text"] == value:
                        observation = Observation(value, observation.source, observation.bbox,
                                                  max(observation.score, round(reread[0]["score"], 1)))
                remember(field, observation)
        heading = "".join(w["text"] for w in words).upper()
        if re.fullmatch(r"ITEMCODE[QOG]TYUNITPRICEAMOUNT", heading):
            edges = [w["bbox"] for w in raw_words if w["text"] in ("|", "¦")]
            if inside or row_count:
                complete = False
            inside = True
            continue
        if inside and any(w["text"] == "TOTAL:" for w in words):
            inside = False
            continue
        if inside:
            # Tesseract may read crossings in an ASCII divider as 2 or p.
            # Check the pixels for a horizontal stroke across the putative row.
            if "-" in text and text.count("-") >= 5 and not any(valid("sku", w["text"]) for w in words):
                left = min(w["bbox"][0] for w in words)
                right = max(w["bbox"][2] for w in words)
                top = min(w["bbox"][1] for w in words)
                bottom = max(w["bbox"][3] for w in words)
                strip = page.crop((left, top, right, bottom)).convert("L").point(lambda v: 255 if v < 135 else 0)
                if any(strip.crop((0, i, strip.width, i + 1)).histogram()[255] > strip.width * .5
                       for i in range(strip.height)):
                    continue
            row_count += 1
            if len(words) != len(ROW_FIELDS):
                complete = False
                continue
            for i, (key, word) in enumerate(zip(ROW_FIELDS, words, strict=True)):
                bounds = (0, page.width)
                if len(edges) == len(ROW_FIELDS) - 1:
                    bounds = (edges[i - 1][2] + 2 if i else 0,
                              edges[i][0] - 2 if i < len(edges) else page.width)
                cell = _cell(page, word, bounds)
                if cell:
                    crop, bbox = cell
                    word = {**word, "bbox": bbox}
                    if rereads < 12 and (word["score"] < 80 or not valid(key, word["text"])):
                        rereads += 1
                        word = _reread(crop, key, word)
                remember(f"line.{row_count}.{key}", _evidence(word["text"], [word]))
    required = tuple(HEADERS.values()) + tuple(
        f"line.{number}.{key}" for number in range(1, row_count + 1) for key in ROW_FIELDS
    )
    return Parsed(fields, required, row_count, complete and not duplicates
                  and not inside and 0 < row_count <= 30, page)


def amount(value: str) -> Decimal:
    return Decimal(value)
