"""Capture each real browser state from a freshly started loopback demo server."""
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

OUT = Path(os.getenv("AIOS_CAPTURE_DIR", ".state/browser-screenshots"))
OUT.mkdir(parents=True, exist_ok=True)
URL = os.getenv("AIOS_DEMO_URL", "http://127.0.0.1:8758")

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=os.getenv("CHROMIUM_BIN"),
                                         args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(URL)
    expect(page.get_by_text("Draft validated", exact=True)).to_be_visible()
    expect(page.get_by_text("TEA-24 · 2 CASE → 48 EACH", exact=False)).to_be_visible()
    page.screenshot(path=OUT / "01-extracted-fields.png", full_page=True)

    page.get_by_role("button", name="Quantity conflict").click()
    expect(page.get_by_text("Human review", exact=True)).to_be_visible()
    expect(page.get_by_text("Vision B · scripted read 2", exact=False)).to_be_visible()
    expect(page.get_by_text("8 × 240.00 = 1920.00. The source line total is HKD 480.00.")).to_be_visible()
    page.screenshot(path=OUT / "02-quantity-review.png", full_page=True)
    quantity = page.get_by_role("textbox", name="Line 1 · Quantity")
    quantity.fill("8")
    page.get_by_role("button", name="Validate reviewed fields").click()
    expect(page.get_by_role("status")).to_contain_text("quantity × price")
    quantity.fill("2")
    page.get_by_role("button", name="Validate reviewed fields").click()
    expect(page.get_by_text("Draft validated", exact=True)).to_be_visible()
    page.get_by_role("button", name="Approve and queue").click()
    expect(page.get_by_text("Queued", exact=True)).to_be_visible()
    page.get_by_role("button", name="Run worker step").click()
    expect(page.get_by_text("Outcome unknown", exact=True)).to_be_visible()
    page.get_by_role("button", name="Run worker step").click()
    expect(page.get_by_text("Verified in ERP", exact=True)).to_be_visible()
    expect(page.get_by_text("1 matching ERP draft", exact=False)).to_be_visible()
    page.screenshot(path=OUT / "03-erp-reconciliation.png", full_page=True)
    page.reload()
    expect(page.get_by_text("Verified in ERP", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="Approved", exact=True)).to_be_disabled()
    source = Path(__file__).resolve().parents[1] / "fixtures" / "harbour-po.png"
    page.get_by_label("Upload a purchase order").set_input_files(source)
    page.get_by_role("button", name="Extract fields").click()
    expect(page.get_by_text("Local OCR only · 0 vision reads", exact=True)).to_be_visible()
    expect(page.get_by_text("Draft validated", exact=True)).to_be_visible()
    page.screenshot(path=OUT / "04-upload-and-inbox.png", full_page=True)
    assert not errors, errors
    browser.close()
