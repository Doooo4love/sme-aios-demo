"""Rebuild the synthetic order fixtures. No customer information is used."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1] / "fixtures"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def render(name: str, po: str) -> None:
    page = Image.new("RGB", (1200, 940), "#fffefa")
    draw = ImageDraw.Draw(page)

    def write(x, y, message, size=34, bold=False, color="#182636"):
        font = ImageFont.truetype(BOLD if bold else FONT, size)
        draw.text((x, y), message, font=font, fill=color)

    write(64, 56, "HARBOUR SUPPLY", 34, True)
    write(64, 102, "HONG KONG  /  WHOLESALE BUYING DESK", 19, color="#5a6877")
    draw.line((64, 154, 1136, 154), fill="#25475b", width=3)
    write(64, 183, "PURCHASE ORDER", 54, True)
    write(68, 302, f"PO NO: {po}")
    write(650, 302, "BUYER: HBR-47")
    write(68, 366, "DELIVERY: 2026-11-25")
    write(650, 366, "CURRENCY: HKD")
    draw.rounded_rectangle((64, 463, 1138, 526), radius=8, fill="#eaf0f2")
    for col, label in zip((86, 475, 620, 778, 978), ("ITEM CODE", "QTY", "UNIT", "PRICE", "AMOUNT")):
        write(col, 479, label, 25, True)
    for y, values in (
        (550, ("TEA-24", "2", "CASE", "240.00", "480.00")),
        (620, ("SODA-12", "3", "CASE", "108.00", "324.00")),
    ):
        for col, value in zip((86, 475, 620, 778, 978), values):
            write(col, y, value, 30)
        draw.line((73, y + 52, 1128, y + 52), fill="#d1d8db", width=2)
    write(760, 712, "TOTAL: 804.00", 39, True)
    draw.line((64, 808, 1136, 808), fill="#d1d8db", width=2)
    write(66, 844, "SYNTHETIC DEMO DOCUMENT", 21, color="#526578")
    page.save(ROOT / name, optimize=True)


if __name__ == "__main__":
    ROOT.mkdir(exist_ok=True)
    render("harbour-po.png", "PO-1042")
    render("harbour-review.png", "PO-1043")
