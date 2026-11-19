"""Render pitch images from the measured output of scripts/run_demo.py."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from run_demo import run

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "images"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
INK = "#142e37"
SOFT = "#4f666d"
TEAL = "#126b5f"
AMBER = "#8a520f"
BG = "#f4f6f2"
WHITE = "#ffffff"


def canvas(title, subtitle):
    image = Image.new("RGB", (1440, 820), BG)
    draw = ImageDraw.Draw(image)

    def text(x, y, content, size=20, color=INK, font=FONT):
        draw.text((x, y), content, fill=color, font=ImageFont.truetype(font, size))

    draw.rectangle((0, 0, 1440, 65), fill=INK)
    text(48, 20, "SME AIOS   /   WHOLESALE OPERATIONS", 20, "#e8f6f0", BOLD)
    text(1080, 23, "EXECUTION EVIDENCE   ·   LOCAL RUN", 15, "#a7c1bc", BOLD)
    text(47, 91, title, 44, INK, BOLD)
    text(49, 157, subtitle, 20, SOFT)
    text(49, 778, "Source  /  scripts/run_demo.py  ·  synthetic purchase order", 16, SOFT, MONO)
    return image, draw, text


def card(draw, bounds, fill=WHITE):
    draw.rounded_rectangle(bounds, radius=13, fill=fill, outline="#d6dfd9", width=2)


def capture_ocr(result):
    image, draw, text = canvas("From purchase order to field evidence",
                               "Tesseract OCR records the source region for every field.")
    card(draw, (47, 213, 712, 735))
    card(draw, (732, 213, 1393, 735))
    text(70, 235, "SOURCE DOCUMENT", 16, TEAL, BOLD)
    source = Image.open(ROOT / "fixtures" / result["artifact"]).convert("RGB")
    original = source.size
    source.thumbnail((603, 420))
    sx, sy = 78, 280
    image.paste(source, (sx, sy))
    left, top, right, bottom = result["conflict"]["ocr"]["bbox"]
    rx, ry = source.width / original[0], source.height / original[1]
    draw.rounded_rectangle((sx + left * rx - 5, sy + top * ry - 5,
                            sx + right * rx + 5, sy + bottom * ry + 5),
                           radius=5, outline="#d3911c", width=3)
    data = result["observed"]
    text(756, 236, "EXTRACTED FIELDS", 16, TEAL, BOLD)
    text(756, 274, f"{data['rows']} line items   /   {data['fields']} field regions", 27, INK, BOLD)
    records = (("Purchase order", "po"), ("Buyer", "buyer"), ("Delivery", "delivery"),
               ("Line 1 · Item", "line.1.sku"), ("Line 1 · Quantity", "line.1.quantity"),
               ("Line 2 · Quantity", "line.2.quantity"), ("Order total", "total"))
    y = 340
    for label, key in records:
        observation = data["fields_data"][key]["ocr"]
        if key == "line.1.quantity":
            draw.rounded_rectangle((751, y - 5, 1370, y + 36), radius=5, fill="#fff0d8")
        text(764, y, label, 20)
        text(1098, y, observation["value"], 20, INK, MONO)
        y += 48
    text(760, 689, f"Highlighted bbox (px)  {result['conflict']['ocr']['bbox']}", 15, SOFT, MONO)
    image.save(OUT / "01-extracted-fields.png", optimize=True)


def capture_review(result):
    image, draw, text = canvas("One disputed field goes to review",
                               "The demo runs real OCR and replays scripted vision responses to exercise routing.")
    card(draw, (47, 213, 712, 735))
    card(draw, (732, 213, 1393, 735))
    text(74, 241, "LINE 1  /  QUANTITY", 16, TEAL, BOLD)
    disputed = result["conflict"]
    candidates = [("Tesseract OCR", disputed["ocr"]["value"])]
    candidates += [(item["reader"], item["value"]) for item in disputed["vision"]]
    y = 298
    for label, value in candidates:
        draw.rounded_rectangle((72, y, 685, y + 58), radius=6, fill="#f2f6f3")
        text(91, y + 15, label, 21)
        text(577, y + 12, value, 26, INK, MONO)
        y += 75
    text(75, 555, "Draft blocked before approval", 23, AMBER, BOLD)
    text(75, 598, result["blocked"], 17, SOFT, MONO)
    text(761, 242, "HUMAN CONFIRMATION  /  BUSINESS VALIDATION", 16, TEAL, BOLD)
    item = result["payload"]["items"][0]
    text(763, 315, f"{item['source_quantity']} cases  →  {item['erp_quantity']} units", 39, INK, BOLD)
    text(763, 384, f"{item['source_sku']}  →  {item['sku']}", 22, SOFT, MONO)
    text(763, 456, f"Line total     HKD {item['line_total']}", 23, INK, MONO)
    text(763, 505, f"Order total    HKD {result['payload']['total']}", 23, INK, MONO)
    text(763, 591, "A second reading did not bypass review.", 22, TEAL, BOLD)
    image.save(OUT / "02-quantity-review.png", optimize=True)


def capture_erp(result):
    image, draw, text = canvas("ERP response lost. One draft verified.",
                               "The sandbox ERP commits first. A separate read-back verifies the approved payload.")
    card(draw, (47, 213, 1393, 735))
    text(76, 241, result["business_key"], 20, SOFT, MONO)
    text(76, 288, result["erp_id"], 52, INK, BOLD)
    text(992, 290, f"{result['erp_draft_count']} matching ERP draft", 27, TEAL, BOLD)
    draw.line((76, 381, 1364, 381), fill="#dce3de", width=2)
    display = {
        "APPROVED": ("Approval", "Snapshot digest bound"),
        "OUTBOX_QUEUED": ("Queued", "Same DB transaction"),
        "SENDING": ("ERP call", "Intent saved before call"),
        "OUTCOME_UNKNOWN": ("Response lost", "Schedule read only"),
        "COMMITTED": ("Read-back matched", "Exact payload confirmed"),
    }
    for i, event in enumerate(result["events"]):
        x = 76 + i * 256
        fill = "#fff2db" if event == "OUTCOME_UNKNOWN" else "#e7f3eb" if event == "COMMITTED" else "#f2f6f3"
        draw.rounded_rectangle((x, 431, x + 230, 563), radius=7, fill=fill)
        text(x + 13, 448, event, 14, TEAL, MONO)
        name, note = display[event]
        text(x + 13, 485, name, 19, INK, BOLD)
        text(x + 13, 526, note, 14, SOFT)
    text(76, 625, "Recovery performed a read; the worker did not dispatch a second write.", 23, INK, BOLD)
    image.save(OUT / "03-erp-reconciliation.png", optimize=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    execution = run()
    capture_ocr(execution)
    capture_review(execution)
    capture_erp(execution)
