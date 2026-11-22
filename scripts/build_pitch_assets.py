#!/usr/bin/env python3
"""Build V3 Swiss-editorial visual & brand assets for the Theodic Pitch Deck.

Run with:
    /Users/rexzheng/.local/bin/uv run --with pillow --with matplotlib --with segno python3 \
        /Users/rexzheng/Documents/AIOS/scripts/build_pitch_assets.py
"""

from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.patches as patches
import matplotlib.pyplot as plt
import numpy as np
import segno
from PIL import Image, ImageDraw, ImageFilter

# ---------------------------------------------------------------------------
# Paths & V2 Warm Museum Alabaster Editorial Tokens
# ---------------------------------------------------------------------------
REPO_ROOT = Path("/Users/rexzheng/Documents/AIOS")
OUT_DIR = REPO_ROOT / "docs" / "pitch" / "assets"
REVIEWER_PASS_JSON = REPO_ROOT / "deploy" / "cloudflare-worker" / ".reviewer-pass.local.json"
DEFAULT_COVER_RAW = Path(
    "/Users/rexzheng/.gemini/antigravity/brain/84630f65-49ab-46e5-b3fd-8365d4641387"
    "/theodic_cover_arch_harbour_1795351918372.jpg"
)
BRAND_LOGO_JPG = Path(
    "/Users/rexzheng/.gemini/antigravity/brain/3870a0f8-e084-444d-8f30-caf5a7395a56"
    "/.user_uploaded/media_1795361064516_6a68b5ca.jpg"
)

SRC_SCREENSHOTS = {
    "ocr_review": REPO_ROOT / "docs" / "browser" / "02-quantity-review.png",
    "inbox_light": REPO_ROOT / "web" / "e2e" / "screenshots" / "13-inbox-light-en.png",
    "proposal_dark": REPO_ROOT / "web" / "e2e" / "screenshots" / "21-dark-en-proposal-stepper.png",
}

LEGACY_V1_ASSETS = [
    "ui_login_dark.png",
    "ui_inbox_light.png",
    "ui_proposal_receipt_dark.png",
    "ui_po_ocr_evidence.png",
]

# Strict V2 Editorial Palette (Monochrome + Single Surgical Accent)
PAPER = "#FAF8F5"
WELL = "#F1ECE4"
CARD_WHITE = "#FFFFFF"
CARBON = "#171717"
CHARCOAL = "#4A4640"
WARM_STONE = "#7A746B"
SAND = "#CFC8BE"
SAND_MID = "#E3DDD4"
SAND_LIGHT = "#EFEAE2"
HAIRLINE = "#DCD5CB"
HAIRLINE_UI = "#D8D1C7"

# Single Editorial Accent: Deep Ink Navy-Cobalt
NAVY_COBALT = "#1B4F9C"
NAVY_WASH = "#EDF1F7"

DPI = 300


def configure_matplotlib() -> None:
    """Apply crisp Avenir Next / Georgia editorial styling on #FAF8F5 paper."""
    plt.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": ["Avenir Next", "Helvetica Neue", "Arial", "DejaVu Sans"],
            "axes.edgecolor": HAIRLINE,
            "axes.linewidth": 0.75,
            "axes.facecolor": PAPER,
            "figure.facecolor": PAPER,
            "savefig.facecolor": PAPER,
            "savefig.dpi": DPI,
            "text.color": CARBON,
            "xtick.color": WARM_STONE,
            "ytick.color": CHARCOAL,
            "axes.unicode_minus": False,
            "text.parse_math": False,
        }
    )


# ---------------------------------------------------------------------------
# 0. Transparent Brand Assets Extracted via Tonal Unmixing
# ---------------------------------------------------------------------------
def extract_theodic_brand_assets(src_jpg: Path, out_dir: Path) -> dict[str, tuple[int, int]]:
    """Extract 3x-Lanczos transparent RGBA lockups and arch marks via tonal unmixing."""
    if not src_jpg.exists():
        raise FileNotFoundError(f"Brand logo source not found: {src_jpg}")

    src_img = Image.open(src_jpg).convert("RGB")
    c_bg = np.array(src_img.getpixel((5, 5)), dtype=np.float32)
    c_ink = np.array([23.0, 23.0, 23.0], dtype=np.float32)
    denom = c_bg - c_ink

    specs: list[tuple[str, tuple[int, int, int, int], tuple[int, int, int]]] = [
        ("theodic_logo_dark.png", (156, 130, 875, 245), (23, 23, 23)),
        ("theodic_logo_light.png", (156, 130, 875, 245), (250, 246, 240)),
        ("theodic_mark_dark.png", (156, 130, 381, 245), (23, 23, 23)),
        ("theodic_mark_light.png", (156, 130, 381, 245), (250, 246, 240)),
    ]

    dims: dict[str, tuple[int, int]] = {}
    for fname, box, target_rgb in specs:
        crop = src_img.crop(box)
        up_w, up_h = crop.width * 3, crop.height * 3
        crop_hi = crop.resize((up_w, up_h), Image.Resampling.LANCZOS)

        rgb = np.asarray(crop_hi, dtype=np.float32)
        t = np.clip(((c_bg - rgb) / denom).mean(axis=2), 0.0, 1.0)
        t[t < 0.025] = 0.0

        rgba = np.empty((up_h, up_w, 4), dtype=np.uint8)
        rgba[:, :, 0] = target_rgb[0]
        rgba[:, :, 1] = target_rgb[1]
        rgba[:, :, 2] = target_rgb[2]
        rgba[:, :, 3] = np.round(255.0 * t).astype(np.uint8)

        out_path = out_dir / fname
        out_img = Image.fromarray(rgba, mode="RGBA")
        out_img.save(out_path, format="PNG", optimize=True)
        dims[fname] = out_img.size
    return dims


# ---------------------------------------------------------------------------
# 1. Tightly Cropped, High-Legibility UI Visuals (Zero Fake Window Chrome)
# ---------------------------------------------------------------------------
def build_ui_zoom_crop(
    src_path: Path,
    out_path: Path,
    *,
    crop_box: tuple[int, int, int, int],
    border_rgba: tuple[int, int, int, int] = (216, 209, 199, 255),
    shadow_alpha: int = 56,
) -> tuple[int, int]:
    """Crop a screenshot tightly to focal UI evidence with a crisp 1px hairline and ambient shadow."""
    cropped = Image.open(src_path).convert("RGBA").crop(crop_box)
    cw, ch = cropped.size

    # Crisp 1px architectural hairline around exact crop
    framed = cropped.copy()
    draw = ImageDraw.Draw(framed)
    draw.rectangle([0, 0, cw - 1, ch - 1], outline=border_rgba, width=1)

    pad_x, pad_top, pad_bot = 18, 10, 26
    canvas_w = cw + pad_x * 2
    canvas_h = ch + pad_top + pad_bot

    shadow_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    shadow_rect = Image.new("RGBA", (cw, ch), (23, 23, 23, shadow_alpha))
    shadow_layer.paste(shadow_rect, (pad_x, pad_top + 8))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=11))

    final_img = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    final_img = Image.alpha_composite(final_img, shadow_layer)
    final_img.paste(framed, (pad_x, pad_top))
    final_img.save(out_path, format="PNG", optimize=True)
    return final_img.size


def generate_ui_zoom_crops() -> dict[str, tuple[int, int]]:
    """Build the 3 enlarged tightly cropped UI evidence visuals."""
    specs = [
        (
            "ui_po_conflict_zoom.png",
            SRC_SCREENSHOTS["ocr_review"],
            (38, 212, 1402, 760),
            (216, 209, 199, 255),
            52,
        ),
        (
            "ui_agent_lookup_zoom.png",
            SRC_SCREENSHOTS["inbox_light"],
            (495, 118, 1255, 515),
            (216, 209, 199, 255),
            52,
        ),
        (
            "ui_receipt_stepper_zoom.png",
            SRC_SCREENSHOTS["proposal_dark"],
            (154, 198, 1286, 892),
            (54, 52, 48, 255),
            76,
        ),
    ]
    dims: dict[str, tuple[int, int]] = {}
    for fname, src, box, border_col, sh_alpha in specs:
        dims[fname] = build_ui_zoom_crop(
            src,
            OUT_DIR / fname,
            crop_box=box,
            border_rgba=border_col,
            shadow_alpha=sh_alpha,
        )
    return dims


# ---------------------------------------------------------------------------
# 2. Chart 1 (Slide 3): HK SME & Wholesale Funnel + Software/AI Gap
# ---------------------------------------------------------------------------
def build_chart_hk_sme_gap(out_path: Path) -> tuple[int, int]:
    """Create monochrome Slide 3 chart directly on #FAF8F5 paper with #1B4F9C focal wedge."""
    fig = plt.figure(figsize=(7.6, 4.9), dpi=DPI, facecolor=PAPER)

    # --- Top Panel: Stepped Discovery Funnel ---
    ax_top = fig.add_axes([0.03, 0.50, 0.94, 0.45])
    ax_top.set_facecolor(PAPER)
    ax_top.set_xlim(0, 100)
    ax_top.set_ylim(0, 4.75)
    ax_top.axis("off")

    ax_top.text(
        0.0,
        4.62,
        "A. Hong Kong SMEs to Target Operating Tier (Official Units)",
        fontsize=12.4,
        fontweight="bold",
        color=CARBON,
        va="top",
    )
    ax_top.text(
        100.0,
        4.60,
        "Normalized widths",
        fontsize=9.8,
        color=WARM_STONE,
        ha="right",
        va="top",
        style="italic",
    )

    tiers = [
        {
            "y": 2.95,
            "w": 43.0,
            "fill": SAND_LIGHT,
            "edge": HAIRLINE,
            "ink": CARBON,
            "count": "357,965",
            "label": "All Hong Kong SMEs",
            "sub": ">98% of firms · broad service & B2B base · TID Jun 2026",
        },
        {
            "y": 1.62,
            "w": 32.5,
            "fill": SAND_MID,
            "edge": SAND,
            "ink": CARBON,
            "count": "92,307",
            "label": "Trade, Wholesale & Logistics SMEs",
            "sub": "83,759 import/export & wholesale + 8,548 transport · TID Jun 2026",
        },
    ]

    bar_cx = 22.0
    bar_h = 0.92
    call_x = 45.8
    for t in tiers:
        x0 = bar_cx - t["w"] / 2.0
        rect = patches.Rectangle(
            (x0, t["y"]),
            t["w"],
            bar_h,
            facecolor=t["fill"],
            edgecolor=t["edge"],
            linewidth=0.85,
        )
        ax_top.add_patch(rect)
        ax_top.text(
            bar_cx,
            t["y"] + bar_h / 2.0,
            t["count"],
            fontsize=13.0,
            fontweight="bold",
            color=t["ink"],
            ha="center",
            va="center",
        )
        ax_top.plot([x0 + t["w"] + 0.8, call_x - 1.0], [t["y"] + bar_h / 2.0, t["y"] + bar_h / 2.0], color=HAIRLINE, lw=0.85)
        ax_top.text(call_x, t["y"] + bar_h * 0.68, t["label"], fontsize=11.0, fontweight="bold", color=CARBON, va="center")
        ax_top.text(call_x, t["y"] + bar_h * 0.25, t["sub"], fontsize=9.6, color=WARM_STONE, va="center")

    # Tier 3: 8,202 10-49 B2B units (7,626 I/E & Wholesale + 576 Transport Support)
    y_bot = 0.28
    w_ie_ws = 14.5
    w_tr = 7.5
    gap_w = 0.8
    total_bot = w_ie_ws + gap_w + w_tr
    x_start = bar_cx - total_bot / 2.0

    ax_top.add_patch(patches.Rectangle((x_start, y_bot), w_ie_ws, bar_h, facecolor=NAVY_COBALT, edgecolor=NAVY_COBALT, linewidth=0.85))
    ax_top.add_patch(patches.Rectangle((x_start + w_ie_ws + gap_w, y_bot), w_tr, bar_h, facecolor=CARBON, edgecolor=CARBON, linewidth=0.85))
    ax_top.text(x_start + w_ie_ws / 2.0, y_bot + bar_h / 2.0, "7,626", fontsize=12.4, fontweight="bold", color="#FFFFFF", ha="center", va="center")
    ax_top.text(x_start + w_ie_ws + gap_w + w_tr / 2.0, y_bot + bar_h / 2.0, "576", fontsize=12.0, fontweight="bold", color="#FFFFFF", ha="center", va="center")
    ax_top.plot([x_start + total_bot + 0.8, call_x - 1.0], [y_bot + bar_h / 2.0, y_bot + bar_h / 2.0], color=NAVY_COBALT, lw=1.0)
    ax_top.text(
        call_x,
        y_bot + bar_h * 0.68,
        "8,202 Operating 10–49 B2B Units",
        fontsize=11.0,
        fontweight="bold",
        color=NAVY_COBALT,
        va="center",
    )
    ax_top.text(
        call_x,
        y_bot + bar_h * 0.25,
        "6,680 import/export, 946 wholesale & 576 transport · C&SD 2024",
        fontsize=9.5,
        color=CHARCOAL,
        va="center",
    )

    # --- Bottom Left: Enterprise Software Stack Gap ---
    ax_bl = fig.add_axes([0.19, 0.08, 0.30, 0.30])
    ax_bl.set_facecolor(PAPER)
    for spine in ["top", "right"]:
        ax_bl.spines[spine].set_visible(False)
    ax_bl.spines["left"].set_color(HAIRLINE)
    ax_bl.spines["bottom"].set_color(HAIRLINE)

    sw_labels = ["ERP Systems", "Supply Chain", "Accounting"]
    sw_vals = [6.0, 26.7, 45.5]
    sw_colors = [CARBON, WARM_STONE, SAND]
    y_pos = np.arange(len(sw_labels))

    bars_bl = ax_bl.barh(y_pos, sw_vals, height=0.52, color=sw_colors, edgecolor="none")
    ax_bl.set_yticks(y_pos)
    ax_bl.set_yticklabels(sw_labels, fontsize=10.5, fontweight="bold", color=CARBON)
    ax_bl.set_xlim(0, 76)
    ax_bl.set_xticks([0, 20, 40, 60])
    ax_bl.set_xticklabels(["0%", "20%", "40%", "60%"], fontsize=9.8, color=WARM_STONE)
    ax_bl.xaxis.grid(True, color=HAIRLINE, linestyle="--", linewidth=0.6)
    ax_bl.set_axisbelow(True)
    ax_bl.tick_params(axis="y", length=0, pad=6)
    ax_bl.set_title(
        "B. System Stack (n = 320,710 firms)\nOverlapping economy-wide categories",
        fontsize=11.0,
        fontweight="bold",
        color=CARBON,
        loc="left",
        pad=10,
    )
    for bar, val, col in zip(bars_bl, sw_vals, sw_colors):
        note = " (94% no ERP)" if val == 6.0 else ""
        tcol = CARBON if val == 6.0 else CHARCOAL
        ax_bl.text(
            val + 1.6,
            bar.get_y() + bar.get_height() / 2.0,
            f"{val:.1f}%{note}",
            va="center",
            ha="left",
            fontsize=10.6,
            fontweight="bold",
            color=tcol,
        )

    # --- Bottom Right: AI Interest vs Paid Adoption ---
    ax_br = fig.add_axes([0.62, 0.08, 0.29, 0.30])
    ax_br.set_facecolor(PAPER)
    for spine in ["top", "right"]:
        ax_br.spines[spine].set_visible(False)
    ax_br.spines["left"].set_color(HAIRLINE)
    ax_br.spines["bottom"].set_color(HAIRLINE)

    ai_labels = ["Paid AI Tools\n(AI users*)", "Use or Plan AI\n(within 12 mos)"]
    ai_vals = [32.0, 55.0]
    ai_colors = [NAVY_COBALT, WARM_STONE]
    y_pos2 = np.arange(len(ai_labels))

    bars_br = ax_br.barh(y_pos2, ai_vals, height=0.45, color=ai_colors, edgecolor="none")
    ax_br.set_yticks(y_pos2)
    ax_br.set_yticklabels(ai_labels, fontsize=10.5, fontweight="bold", color=CARBON)
    ax_br.set_ylim(-0.55, 1.55)
    ax_br.set_xlim(0, 74)
    ax_br.set_xticks([0, 20, 40, 60])
    ax_br.set_xticklabels(["0%", "20%", "40%", "60%"], fontsize=9.8, color=WARM_STONE)
    ax_br.xaxis.grid(True, color=HAIRLINE, linestyle="--", linewidth=0.6)
    ax_br.set_axisbelow(True)
    ax_br.tick_params(axis="y", length=0, pad=6)
    ax_br.set_title(
        "C. AI Adoption Gap (n = 819)\n*Share among existing AI users",
        fontsize=10.8,
        fontweight="bold",
        color=CARBON,
        loc="left",
        pad=10,
    )
    for bar, val, col in zip(bars_br, ai_vals, ai_colors):
        ax_br.text(
            val + 2.0,
            bar.get_y() + bar.get_height() / 2.0,
            f"{val:.0f}%",
            va="center",
            ha="left",
            fontsize=11.4,
            fontweight="bold",
            color=NAVY_COBALT if val == 32.0 else CHARCOAL,
        )

    fig.savefig(out_path, dpi=DPI)
    plt.close(fig)
    with Image.open(out_path) as im:
        return im.size


# ---------------------------------------------------------------------------
# 3. Chart 2 (Slide 6): Buyer Task Economics & 36-Month Modeled ARR
# ---------------------------------------------------------------------------
def simulate_excel_som_cases() -> dict[str, list[float]]:
    """Replicate exact capacity-constrained M1..M36 Exit ARR (HK$k) from HK_wholesale_TAM_SAM_SOM_model."""
    cases: dict[str, dict[str, float]] = {
        "C1": dict(
            contrib=3, wk=10, qa=40, res=0.15, prosp=4, p2q=0.25, q2d=0.20,
            h_init=2, h_sales=16, t_sales=4, t_dvp=2, t_prod=1,
            h_dvp=78, h_prod=40, d2p=0.70, h_supp=8, churn=0.02, fee=4000,
        ),
        "C2": dict(
            contrib=3, wk=20, qa=40, res=0.15, prosp=4, p2q=0.50, q2d=0.25,
            h_init=2, h_sales=16, t_sales=3, t_dvp=2, t_prod=1,
            h_dvp=78, h_prod=40, d2p=0.80, h_supp=8, churn=0.01, fee=4000,
        ),
        "C3": dict(
            contrib=3, wk=20, qa=40, res=0.15, prosp=8, p2q=0.50, q2d=0.25,
            h_init=1, h_sales=10, t_sales=2, t_dvp=2, t_prod=1,
            h_dvp=50, h_prod=30, d2p=0.90, h_supp=4, churn=0.005, fee=4000,
        ),
    }
    trajectories: dict[str, list[float]] = {}
    for name, c in cases.items():
        avail = c["contrib"] * c["wk"] * 52.0 / 12.0 * (1.0 - c["res"]) - c["qa"]
        wins_raw = c["prosp"] * c["p2q"] * c["q2d"]
        sales_h_per_win = (c["h_init"] + c["p2q"] * c["h_sales"]) / (c["p2q"] * c["q2d"])

        def unit_h(m: int, d: int, cfg: dict[str, float] = c, sh: float = sales_h_per_win) -> float:
            age = m - d
            if age < 0:
                return 0.0
            if age < cfg["t_sales"]:
                return sh / cfg["t_sales"]
            if age < cfg["t_sales"] + cfg["t_dvp"]:
                return cfg["h_dvp"] / cfg["t_dvp"]
            if age < cfg["t_sales"] + cfg["t_dvp"] + cfg["t_prod"]:
                return cfg["d2p"] * cfg["h_prod"] / cfg["t_prod"]
            return (
                cfg["d2p"]
                * ((1.0 - cfg["churn"]) ** (age - cfg["t_sales"] - cfg["t_dvp"] - cfg["t_prod"]))
                * cfg["h_supp"]
            )

        admitted: list[float] = []
        used = {m: 0.0 for m in range(1, 75)}
        for d in range(1, 37):
            cap = wins_raw
            for m in range(1, 75):
                uh = unit_h(m, d)
                if uh > 0:
                    cap = min(cap, max(0.0, avail - used[m]) / uh)
            admitted.append(cap)
            for m in range(1, 75):
                used[m] += cap * unit_h(m, d)

        active = 0.0
        arr_k: list[float] = [0.0]
        delay = int(c["t_sales"] + c["t_dvp"] + c["t_prod"])
        for m in range(1, 37):
            new_live = admitted[m - 1 - delay] * c["d2p"] if m > delay else 0.0
            active = active * (1.0 - c["churn"]) + new_live
            arr_k.append(active * c["fee"] * 12.0 / 1000.0)
        trajectories[name] = arr_k
    return trajectories


def build_chart_unit_economics_som(out_path: Path) -> tuple[int, int]:
    """Create monochrome Slide 6 chart on #FAF8F5 paper with #1B4F9C focal trajectories."""
    fig = plt.figure(figsize=(7.2, 4.7), dpi=DPI, facecolor=PAPER)

    # --- Top Left: Handling Time per Case ---
    ax_tl = fig.add_axes([0.15, 0.57, 0.29, 0.34])
    ax_tl.set_facecolor(PAPER)
    for spine in ["top", "right"]:
        ax_tl.spines[spine].set_visible(False)
    ax_tl.spines["left"].set_color(HAIRLINE)
    ax_tl.spines["bottom"].set_color(HAIRLINE)

    ax_tl.barh([1], [8.0], height=0.44, color=SAND)
    ax_tl.barh([0], [2.0], height=0.44, color=NAVY_COBALT)
    ax_tl.barh([0], [1.0], left=[2.0], height=0.44, color=WARM_STONE)

    ax_tl.set_yticks([0, 1])
    ax_tl.set_yticklabels(["Theodic\nBlended", "Manual\nBaseline"], fontsize=10.4, fontweight="bold", color=CARBON)
    ax_tl.set_ylim(-0.55, 1.55)
    ax_tl.set_xlim(0, 14.5)
    ax_tl.set_xticks([0, 2, 4, 6, 8, 10])
    ax_tl.set_xticklabels(["0", "2", "4", "6", "8", "10m"], fontsize=9.6, color=WARM_STONE)
    ax_tl.xaxis.grid(True, color=HAIRLINE, linestyle="--", linewidth=0.6)
    ax_tl.set_axisbelow(True)
    ax_tl.tick_params(axis="y", length=0, pad=6)
    ax_tl.set_title("A. Handling Time per Case", fontsize=11.4, fontweight="bold", color=CARBON, loc="left", pad=10)

    ax_tl.text(8.25, 1.0, "8.0 min", va="center", fontsize=10.4, fontweight="bold", color=CHARCOAL)
    ax_tl.text(3.25, 0.16, "3.0 min net (–62.5%)", va="center", fontsize=10.4, fontweight="bold", color=NAVY_COBALT)
    ax_tl.text(3.25, -0.26, "2.0 min clean + 1.0 min tail", va="center", fontsize=8.8, color=WARM_STONE)

    # --- Bottom Left: Buyer Yr-1 Cash Bridge (1,800 cases/mo) ---
    ax_bl = fig.add_axes([0.15, 0.08, 0.29, 0.34])
    ax_bl.set_facecolor(PAPER)
    for spine in ["top", "right"]:
        ax_bl.spines[spine].set_visible(False)
    ax_bl.spines["left"].set_color(HAIRLINE)
    ax_bl.spines["bottom"].set_color(HAIRLINE)

    labels_cash = ["Year-1 Net\nCash Gain", "Fees + Setup\n+ Review", "Gross Time\nSavings"]
    vals_cash = [40.39, 105.86, 146.25]
    cols_cash = [NAVY_COBALT, SAND, CARBON]
    y_c = np.arange(len(labels_cash))

    bars_c = ax_bl.barh(y_c, vals_cash, height=0.50, color=cols_cash)
    ax_bl.set_yticks(y_c)
    ax_bl.set_yticklabels(labels_cash, fontsize=10.2, fontweight="bold", color=CARBON)
    ax_bl.set_xlim(0, 285)
    ax_bl.set_xticks([0, 50, 100, 150])
    ax_bl.set_xticklabels(["0", "50k", "100k", "150k"], fontsize=9.6, color=WARM_STONE)
    ax_bl.xaxis.grid(True, color=HAIRLINE, linestyle="--", linewidth=0.6)
    ax_bl.set_axisbelow(True)
    ax_bl.tick_params(axis="y", length=0, pad=6)
    ax_bl.set_title("B. First-Year Buyer Cash (1,800/mo)", fontsize=11.4, fontweight="bold", color=CARBON, loc="left", pad=10)

    text_lbls = ["+HK$40,390 (10-mo payback)", "–HK$105,860", "+HK$146,250"]
    text_cols = [NAVY_COBALT, WARM_STONE, CARBON]
    for bar, lbl, col in zip(bars_c, text_lbls, text_cols):
        ax_bl.text(
            bar.get_width() + 4.5,
            bar.get_y() + bar.get_height() / 2.0,
            lbl,
            va="center",
            ha="left",
            fontsize=9.8,
            fontweight="bold",
            color=col,
        )

    # --- Right Panel: 36-Month Modeled ARR Trajectories ---
    ax_r = fig.add_axes([0.56, 0.09, 0.41, 0.81])
    ax_r.set_facecolor(PAPER)
    for spine in ["top", "right"]:
        ax_r.spines[spine].set_visible(False)
    ax_r.spines["left"].set_color(HAIRLINE)
    ax_r.spines["bottom"].set_color(HAIRLINE)

    traj = simulate_excel_som_cases()
    months = np.arange(0, 37)

    ax_r.plot(months, traj["C3"], color=CARBON, lw=2.3)
    ax_r.plot(months, traj["C2"], color=NAVY_COBALT, lw=2.8)
    ax_r.plot(months, traj["C1"], color=WARM_STONE, lw=1.8, linestyle="--")

    ax_r.fill_between(months, traj["C1"], traj["C2"], color=NAVY_COBALT, alpha=0.045)
    ax_r.fill_between(months, traj["C2"], traj["C3"], color=CARBON, alpha=0.03)

    ax_r.axvline(3, color=NAVY_COBALT, linestyle=":", linewidth=1.1, alpha=0.85)
    ax_r.axvline(6, color=WARM_STONE, linestyle=":", linewidth=1.0, alpha=0.7)
    ax_r.text(3.5, 1135, "M3 Launch\n(≤ 90d)", fontsize=9.2, fontweight="bold", color=NAVY_COBALT, va="top")
    ax_r.text(6.8, 970, "M6 Target", fontsize=9.0, color=WARM_STONE, va="top")

    end_specs = [
        ("C3", CARBON, "C3 Reuse\nHK$1,166k"),
        ("C2", NAVY_COBALT, "C2 Reference\nHK$500k"),
        ("C1", WARM_STONE, "C1 Stress\nHK$149k"),
    ]
    for key, col, lbl in end_specs:
        y_end = traj[key][-1]
        ax_r.scatter([36], [y_end], color=col, s=38, zorder=5)
        ax_r.text(37.2, y_end, lbl, fontsize=10.0, fontweight="bold", color=col, va="center", ha="left")

    ax_r.set_xlim(0, 50.0)
    ax_r.set_ylim(-25, 1345)
    ax_r.set_xticks([0, 6, 12, 18, 24, 30, 36])
    ax_r.set_xticklabels(["M0", "M6", "M12", "M18", "M24", "M30", "M36"], fontsize=9.8, color=WARM_STONE)
    ax_r.set_yticks([0, 250, 500, 750, 1000, 1250])
    ax_r.set_yticklabels(["0", "250k", "500k", "750k", "1,000k", "1,250k"], fontsize=9.8, color=WARM_STONE)
    ax_r.yaxis.grid(True, color=HAIRLINE, linestyle="--", linewidth=0.6)
    ax_r.set_axisbelow(True)
    ax_r.set_title("C. 36-Month Exit ARR (HK$k)", fontsize=11.6, fontweight="bold", color=CARBON, loc="left", pad=12)

    ax_r.text(
        1.5,
        1278,
        "MODELED · CAPACITY-CONSTRAINED",
        fontsize=9.0,
        fontweight="bold",
        color=CHARCOAL,
        ha="left",
        va="center",
        bbox=dict(boxstyle="square,pad=0.35", facecolor=WELL, edgecolor=HAIRLINE, linewidth=0.75),
    )

    fig.savefig(out_path, dpi=DPI)
    plt.close(fig)
    with Image.open(out_path) as im:
        return im.size


# ---------------------------------------------------------------------------
# 4. Chart 3 (Slide 7): 2x2 Strategic Positioning Map
# ---------------------------------------------------------------------------
def build_chart_competitor_map(out_path: Path) -> tuple[int, int]:
    """Create monochrome Slide 7 2x2 positioning scatter on #FAF8F5 with #1B4F9C target."""
    fig = plt.figure(figsize=(6.0, 4.9), dpi=DPI, facecolor=PAPER)
    ax = fig.add_axes([0.16, 0.13, 0.80, 0.78])
    ax.set_facecolor(PAPER)

    ax.add_patch(patches.Rectangle((50, 50), 50, 50, facecolor=NAVY_WASH, alpha=0.80, zorder=0))
    ax.add_patch(patches.Rectangle((0, 0), 50, 50, facecolor=WELL, alpha=0.55, zorder=0))

    ax.axvline(50, color=SAND, linestyle="--", linewidth=1.0, zorder=1)
    ax.axhline(50, color=SAND, linestyle="--", linewidth=1.0, zorder=1)

    for spine in ["top", "right"]:
        ax.spines[spine].set_visible(False)
    ax.spines["left"].set_color(HAIRLINE)
    ax.spines["bottom"].set_color(HAIRLINE)

    ax.text(97.5, 97.5, "TARGET WEDGE\nGoverned + Fast SME Deploy", fontsize=9.4, fontweight="bold", color=NAVY_COBALT, ha="right", va="top")
    ax.text(2.5, 97.5, "Enterprise / Heavy IDP\nHigh Governance · Slow/Costly", fontsize=9.0, color=WARM_STONE, ha="left", va="top")
    ax.text(2.5, 2.5, "Legacy Custom\nSlow Setup · Weak Audit", fontsize=9.0, color=WARM_STONE, ha="left", va="bottom")
    ax.text(97.5, 2.5, "Point Tools & Manual\nFast Start · Weak Guardrails", fontsize=9.0, color=WARM_STONE, ha="right", va="bottom")

    points: list[tuple[float, float, str, str, str, float, float, float, str, bool]] = [
        (89, 85, "Theodic (Target Wedge)", "HK$4k/mo · Draft-only + Signed Audit", NAVY_COBALT, 165, 85.2, 86.2, "right", False),
        (11, 74, "Conexiom / Esker", "Enterprise · long ERP rollouts", CHARCOAL, 62, 14.2, 75.2, "left", False),
        (10, 62, "Rossum", "Enterprise IDP · no TC presets", CHARCOAL, 62, 13.2, 63.2, "left", False),
        (44, 54.5, "Ricoh InnoAI", "SI/hardware · opaque SME quote", WARM_STONE, 62, 47.2, 55.6, "left", False),
        (61, 64, "AirPurchase (Adjacent)", "F&B buyer AP · single vertical", CARBON, 64, 64.0, 65.2, "left", True),
        (55, 43, "Odoo 20 Native AI", "Requires Odoo core · soft lock", CHARCOAL, 62, 51.8, 44.2, "right", False),
        (73, 35, "Zoo AI", "HK$28k+ start · no read-back", WARM_STONE, 60, 69.8, 34.0, "right", False),
        (88, 25, "PrimeFlow", "HK$5k/mo × 12 · workflow tool", WARM_STONE, 60, 84.8, 26.2, "right", False),
        (65, 15, "Manual + Excel", "No migration · no audit trail", CARBON, 60, 61.8, 16.2, "right", True),
    ]

    ax.scatter([89], [85], s=420, color=NAVY_COBALT, alpha=0.14, edgecolors="none", zorder=3)

    for x, y, name, sub, col, sz, tx, ty, ha, hollow in points:
        if hollow:
            ax.scatter([x], [y], s=sz, facecolors=PAPER, edgecolors=col, linewidths=1.8, zorder=4)
        else:
            ax.scatter([x], [y], s=sz, color=col, edgecolors=PAPER, linewidths=1.2, zorder=4)

        is_ours = name.startswith("Theodic")
        ax.text(
            tx,
            ty,
            name,
            fontsize=10.8 if is_ours else 9.6,
            fontweight="bold",
            color=NAVY_COBALT if is_ours else (col if col != WARM_STONE else CARBON),
            ha=ha,
            va="center",
            zorder=5,
        )
        ax.text(
            tx,
            ty - 4.5,
            sub,
            fontsize=9.0 if is_ours else 8.6,
            fontweight="bold" if is_ours else "normal",
            color=CARBON if is_ours else WARM_STONE,
            ha=ha,
            va="center",
            zorder=5,
        )

    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.set_xticks([15, 50, 85])
    ax.set_xticklabels(["Heavy / Slow", "Moderate", "SME-Affordable & Fast"], fontsize=9.6, color=WARM_STONE)
    ax.set_yticks([15, 50, 85])
    ax.set_yticklabels(["Ad-hoc", "Partial", "Hard Gate\n+ Audit"], fontsize=9.6, color=WARM_STONE)
    ax.tick_params(length=0, pad=5)

    ax.set_xlabel("SME Affordability & Zero-Migration Speed (Low to High)", fontsize=10.6, fontweight="bold", color=CARBON, labelpad=8)
    ax.set_ylabel("Execution Governance & Auditability (Low to High)", fontsize=10.6, fontweight="bold", color=CARBON, labelpad=6)
    ax.set_title("Strategic Positioning: Draft-Only Governance", fontsize=12.2, fontweight="bold", color=CARBON, loc="left", pad=12)

    fig.savefig(out_path, dpi=DPI)
    plt.close(fig)
    with Image.open(out_path) as im:
        return im.size


# ---------------------------------------------------------------------------
# 5. Chart 4 (Slide 10): Exact HK$100,000 Budget + 3-Tranche Disbursement
# ---------------------------------------------------------------------------
def build_chart_budget_tranches(out_path: Path) -> tuple[int, int]:
    """Create monochrome Slide 10 chart on #FAF8F5 paper with #1B4F9C launch tranche."""
    fig = plt.figure(figsize=(6.4, 4.6), dpi=DPI, facecolor=PAPER)

    # --- Panel A: Full-width 100% Split Bar (Dev HK$64k vs Ops HK$36k) ---
    ax_s = fig.add_axes([0.03, 0.80, 0.94, 0.15])
    ax_s.set_facecolor(PAPER)
    ax_s.set_xlim(0, 100)
    ax_s.set_ylim(0, 1.35)
    ax_s.axis("off")

    ax_s.text(0.0, 1.28, "A. HK$100,000 Seed Grant Split (64% Dev / 36% Ops & GTM)", fontsize=11.8, fontweight="bold", color=CARBON, va="top")
    ax_s.barh([0.42], [64], height=0.58, left=0, color=CARBON)
    ax_s.barh([0.42], [36], height=0.58, left=64, color=WARM_STONE)
    ax_s.text(32, 0.42, "Product Dev · HK$64k (64%)", color="#FFFFFF", fontsize=10.2, fontweight="bold", ha="center", va="center")
    ax_s.text(82, 0.42, "Ops & GTM · HK$36k (36%)", color="#FFFFFF", fontsize=10.0, fontweight="bold", ha="center", va="center")

    # --- Panel B: 6 Line Items Exact Breakdown ---
    ax_b = fig.add_axes([0.40, 0.34, 0.55, 0.41])
    ax_b.set_facecolor(PAPER)
    for spine in ["top", "right"]:
        ax_b.spines[spine].set_visible(False)
    ax_b.spines["left"].set_color(HAIRLINE)
    ax_b.spines["bottom"].set_color(HAIRLINE)

    items = [
        ("Company & BR Registration", 4.0, SAND, "4%"),
        ("SME Clinics & Pilot GTM", 14.0, "#A69F95", "14%"),
        ("6-Month Cloud & AI Ops", 18.0, WARM_STONE, "18%"),
        ("Pilot Benchmark & Guides", 10.0, CHARCOAL, "10%"),
        ("Independent Security Audit", 16.0, NAVY_COBALT, "16%"),
        ("Connector & Eval Eng.", 38.0, CARBON, "38%"),
    ]
    assert sum(x[1] for x in items) == 100.0, "Budget must equal HK$100,000"

    labels = [x[0] for x in items]
    vals = [x[1] for x in items]
    cols = [x[2] for x in items]
    pcts = [x[3] for x in items]
    y_i = np.arange(len(items))

    bars = ax_b.barh(y_i, vals, height=0.58, color=cols)
    ax_b.axhline(2.5, color=SAND, linestyle="--", linewidth=0.9)
    ax_b.set_yticks(y_i)
    ax_b.set_yticklabels(labels, fontsize=10.2, fontweight="bold", color=CARBON)
    ax_b.set_xlim(0, 65)
    ax_b.set_xticks([0, 10, 20, 30, 40])
    ax_b.set_xticklabels(["0", "10k", "20k", "30k", "40k"], fontsize=9.6, color=WARM_STONE)
    ax_b.xaxis.grid(True, color=HAIRLINE, linestyle="--", linewidth=0.6)
    ax_b.set_axisbelow(True)
    ax_b.tick_params(axis="y", length=0, pad=6)

    for bar, val, pct, col in zip(bars, vals, pcts, cols):
        lbl_col = col if col not in (SAND, "#A69F95") else CHARCOAL
        ax_b.text(
            val + 1.2,
            bar.get_y() + bar.get_height() / 2.0,
            f"HK${int(val * 1000):,} ({pct})",
            va="center",
            ha="left",
            fontsize=10.0,
            fontweight="bold",
            color=lbl_col,
        )

    # --- Panel C: Full-width 3-Tranche Disbursement Bar (10% / 45% / 45%) ---
    ax_t = fig.add_axes([0.03, 0.04, 0.94, 0.24])
    ax_t.set_facecolor(PAPER)
    ax_t.set_xlim(0, 100)
    ax_t.set_ylim(-0.45, 1.45)
    ax_t.axis("off")

    ax_t.text(0.0, 1.38, "B. Milestone-Gated Tranches (10% / 45% / 45%)", fontsize=11.8, fontweight="bold", color=CARBON, va="top")

    tranches = [
        (0.0, 9.6, SAND, CARBON, "10%", "M1 Start\nHK$10,000", 0.0, "left"),
        (10.2, 44.5, NAVY_COBALT, "#FFFFFF", "45% · HK$45,000", "M3 Launch (≤ 90d)\nCommercial Product KPI", 32.45, "center"),
        (55.3, 44.7, CARBON, "#FFFFFF", "45% · HK$45,000", "M6 Final Acceptance\n3 Active SMEs · 1,500+ Events", 77.65, "center"),
    ]
    for tx, tw, tcol, t_ink, inside, below, lx, lha in tranches:
        r = patches.Rectangle((tx, 0.45), tw, 0.52, facecolor=tcol, edgecolor=tcol)
        ax_t.add_patch(r)
        ax_t.text(tx + tw / 2.0, 0.71, inside, color=t_ink, fontsize=10.4, fontweight="bold", ha="center", va="center")
        ax_t.text(lx, 0.28, below, color=CHARCOAL, fontsize=9.6, fontweight="bold", ha=lha, va="top", linespacing=1.3)

    fig.savefig(out_path, dpi=DPI)
    plt.close(fig)
    with Image.open(out_path) as im:
        return im.size


# ---------------------------------------------------------------------------
# 6. QR Code Asset (Slide 13): Clean Square Card on #FFFFFF / #DCD5CB
# ---------------------------------------------------------------------------
def build_qr_reviewer_pass(pass_json_path: Path, out_path: Path) -> tuple[int, int]:
    """Render clean square Level-H QR card in #171717 on #FFFFFF with #DCD5CB hairline."""
    data: dict[str, Any] = json.loads(pass_json_path.read_text(encoding="utf-8"))
    url = str(data.get("reviewer_fragment_url", "")).strip()
    if not url:
        raise ValueError(f"Missing 'reviewer_fragment_url' in {pass_json_path}")

    qr = segno.make(url, error="h")
    buf = io.BytesIO()
    qr.save(
        buf,
        kind="png",
        scale=16,
        border=4,
        dark=CARBON,
        finder_dark=CARBON,
        light=CARD_WHITE,
    )
    buf.seek(0)
    qr_img = Image.open(buf).convert("RGBA")

    # Keep the 2px #DCD5CB hairline strictly outside the 4-module quiet zone.
    w, h = qr_img.size
    border_px = 2
    framed = Image.new("RGBA", (w + border_px * 2, h + border_px * 2), (255, 255, 255, 255))
    framed.paste(qr_img, (border_px, border_px))
    draw = ImageDraw.Draw(framed)
    draw.rectangle(
        [0, 0, framed.width - 1, framed.height - 1],
        outline=(220, 213, 203, 255),
        width=border_px,
    )
    framed.save(out_path, format="PNG", optimize=True)
    return framed.size


# ---------------------------------------------------------------------------
# 7. Bespoke Editorial Cover Processing (2560x1440 16:9 w/ Left Feather)
# ---------------------------------------------------------------------------
def build_cover_editorial_bg(raw_img_path: Path, out_path: Path) -> tuple[int, int]:
    """Crop/scale generated cover key visual to 2560x1440 and feather left ~46% to #FAF8F5."""
    target_w, target_h = 2560, 1440
    img = Image.open(raw_img_path).convert("RGB")
    src_w, src_h = img.size

    # Center-crop to 16:9 then Lanczos resize to 2560x1440
    target_ratio = target_w / target_h
    src_ratio = src_w / src_h
    if src_ratio > target_ratio:
        new_w = int(round(src_h * target_ratio))
        x0 = (src_w - new_w) // 2
        img = img.crop((x0, 0, x0 + new_w, src_h))
    elif src_ratio < target_ratio:
        new_h = int(round(src_w / target_ratio))
        y0 = (src_h - new_h) // 2
        img = img.crop((0, y0, src_w, y0 + new_h))
    img = img.resize((target_w, target_h), Image.Resampling.LANCZOS)

    arr = np.asarray(img, dtype=np.float32)
    paper_rgb = np.array([250.0, 248.0, 245.0], dtype=np.float32)  # #FAF8F5

    # Subtle luminance lift toward #FAF8F5 across left 0..42% (preserving tactile plaster, arches untouched)
    xs = np.linspace(0.0, 1.0, target_w, dtype=np.float32)
    alpha = np.full_like(xs, 0.28)
    p0, p1 = 0.34, 0.50
    mask_mid = (xs >= p0) & (xs <= p1)
    u = (xs[mask_mid] - p0) / (p1 - p0)
    alpha[mask_mid] = 0.28 * 0.5 * (1.0 + np.cos(np.pi * u))
    alpha[xs > p1] = 0.0

    blend = alpha[None, :, None]

    out_arr = np.clip(arr * (1.0 - blend) + paper_rgb * blend, 0.0, 255.0).astype(np.uint8)
    out_img = Image.fromarray(out_arr, mode="RGB")
    out_img.save(out_path, format="PNG", optimize=True)
    return out_img.size


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Build V3 Theodic editorial visual & brand assets.")
    parser.add_argument(
        "--require-qr",
        action="store_true",
        help="Fail if deploy/cloudflare-worker/.reviewer-pass.local.json is missing.",
    )
    parser.add_argument(
        "--cover-raw",
        type=Path,
        default=None,
        help="Optional path to raw image-generator output to process into cover_editorial_bg.png.",
    )
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in LEGACY_V1_ASSETS:
        stale_path = OUT_DIR / stale
        if stale_path.exists():
            stale_path.unlink()
            print(f"REMOVED stale V1 asset: {stale}")

    configure_matplotlib()

    results: dict[str, tuple[int, int]] = {}
    results.update(extract_theodic_brand_assets(BRAND_LOGO_JPG, OUT_DIR))
    results.update(generate_ui_zoom_crops())
    results["chart_hk_sme_gap.png"] = build_chart_hk_sme_gap(OUT_DIR / "chart_hk_sme_gap.png")
    results["chart_unit_economics_som.png"] = build_chart_unit_economics_som(OUT_DIR / "chart_unit_economics_som.png")
    results["chart_competitor_map.png"] = build_chart_competitor_map(OUT_DIR / "chart_competitor_map.png")
    results["chart_budget_tranches.png"] = build_chart_budget_tranches(OUT_DIR / "chart_budget_tranches.png")

    if REVIEWER_PASS_JSON.exists():
        results["qr_mvp_reviewer_pass.png"] = build_qr_reviewer_pass(
            REVIEWER_PASS_JSON, OUT_DIR / "qr_mvp_reviewer_pass.png"
        )
    elif args.require_qr:
        raise FileNotFoundError(f"Reviewer pass JSON not found: {REVIEWER_PASS_JSON}")
    else:
        print(f"WARN: {REVIEWER_PASS_JSON} not found yet; skipped qr_mvp_reviewer_pass.png")

    cover_src = args.cover_raw if args.cover_raw is not None else (DEFAULT_COVER_RAW if DEFAULT_COVER_RAW.exists() else None)
    if cover_src is not None:
        results["cover_editorial_bg.png"] = build_cover_editorial_bg(
            cover_src, OUT_DIR / "cover_editorial_bg.png"
        )

    for name, (w, h) in results.items():
        size_kb = (OUT_DIR / name).stat().st_size / 1024.0
        print(f"OK {name}: {w}x{h} px ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
