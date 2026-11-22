#!/usr/bin/env python3
"""Build the V3 14-slide Swiss Editorial pitch deck for Theodic.

Outputs:
  - /Users/rexzheng/Documents/AIOS/deliverables/Theodic_Pitch_Deck.pptx
  - /Users/rexzheng/Documents/AIOS/deliverables/Theodic_Pitch_Deck.pdf

V3 Swiss Editorial Design System (Zero AI-Slop, Fund-Agnostic):
  - Unified #FAF8F5 Warm Museum Alabaster paper across Slides 02-14 (Slide 01 uses
    full-bleed bespoke architectural photography cover_editorial_bg.png).
  - Zero ROUNDED_RECTANGLE shapes, zero capsule pills, zero thick vertical accent bars,
    zero fake browser chrome, zero inline source brackets on Core Slides 01-12, zero comments.
  - Strict Palette: #171717 Carbon, #4A4640 Body Charcoal, #857F76 Muted Stone,
    #DCD5CB 0.5pt Hairlines, flat #F1ECE4 Limestone (Appendix B Declaration only),
    and ONE accent #1B4F9C Deep Ink Cobalt (<=5% area).
  - Typography: Georgia (headlines & top-ruled KPI numerals) + Avenir Next (body,
    tracked kickers, tables). Menlo restricted solely to Slide 13 URL & passcode.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Literal, Sequence

from lxml import etree
from PIL import Image, ImageFont
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt


# ---------------------------------------------------------------------------
# Paths & Constants
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[1]
ASSETS_DIR = REPO_ROOT / "docs" / "pitch" / "assets"
REVIEWER_PASS_PATH = REPO_ROOT / "deploy" / "cloudflare-worker" / ".reviewer-pass.local.json"
DELIVERABLES_DIR = REPO_ROOT / "deliverables"
DEFAULT_PPTX_PATH = DELIVERABLES_DIR / "Theodic_Pitch_Deck.pptx"
DEFAULT_PDF_PATH = DELIVERABLES_DIR / "Theodic_Pitch_Deck.pdf"

# Exact 16:9 widescreen dimensions: 13.333... in x 7.5 in (960pt x 540pt)
SLIDE_W_EMU = 12192000
SLIDE_H_EMU = 6858000
SLIDE_W_IN = SLIDE_W_EMU / 914400.0
SLIDE_H_IN = SLIDE_H_EMU / 914400.0
MAX_SHAPE_X_IN = 13.333334
MAX_SHAPE_Y_IN = 7.500001

MARGIN_X = 0.60
CONTENT_W = 13.333 - 2 * MARGIN_X  # 12.133 in
RAIL_Y = 0.28
TITLE_Y = 0.56
RULE_Y = 1.44
BODY_TOP = 1.60
BODY_BOTTOM = 6.88
BODY_H = BODY_BOTTOM - BODY_TOP    # 5.28 in
FOLIO_Y = 7.06

FONT_SERIF = "Georgia"
FONT_SANS = "Avenir Next"
FONT_MONO = "Menlo"

GEORGIA_REG_TTF = "/System/Library/Fonts/Supplemental/Georgia.ttf"
GEORGIA_BOLD_TTF = "/System/Library/Fonts/Supplemental/Georgia Bold.ttf"
AVENIR_NEXT_TTC = "/System/Library/Fonts/Avenir Next.ttc"
MENLO_TTC = "/System/Library/Fonts/Menlo.ttc"

# Strict Unified Swiss Editorial Palette
PAPER = RGBColor(0xFA, 0xF8, 0xF5)       # #FAF8F5 Warm Museum Alabaster
LIMESTONE = RGBColor(0xF1, 0xEC, 0xE4)   # #F1ECE4 Flat unbordered structural strip
INK_PRIMARY = RGBColor(0x17, 0x17, 0x17) # #171717 Carbon
INK_BODY = RGBColor(0x4A, 0x46, 0x40)    # #4A4640 Body Charcoal
INK_MUTED = RGBColor(0x85, 0x7F, 0x76)   # #857F76 Muted Kicker / Folio
HAIRLINE = RGBColor(0xDC, 0xD5, 0xCB)    # #DCD5CB 0.5pt Hairline
COBALT = RGBColor(0x1B, 0x4F, 0x9C)      # #1B4F9C Deep Ink Cobalt (single accent)

BANNED_AI_SLOP = (
    "revolutionize",
    "revolutionizing",
    "seamless",
    "seamlessly",
    "game-changing",
    "game changer",
    "unlock",
    "unlocking",
    "delve",
    "cutting-edge",
    "empower",
    "empowering",
    "leverage",
    "synergy",
    "disruptive",
    "transformative",
    "holistic",
    "next-gen",
    "reimagine",
    "streamline",
    "harness",
)

FORBIDDEN_V3_SUBSTRINGS = (
    "ccmf",
    "cyberport",
    "founders",
    "otheon",
    "partnar",
    "odoo/xero partner",
)

FORBIDDEN_ASCII_OPS = ("->", "<=", ">=", "!=", "→")

NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
NS_P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
NS_P159 = "http://schemas.microsoft.com/office/powerpoint/2015/09/main"


# ---------------------------------------------------------------------------
# Typography & Text Measurement
# ---------------------------------------------------------------------------

_FONT_CACHE: dict[tuple[str, bool, int], ImageFont.FreeTypeFont | None] = {}


def _get_pil_font(font_name: str, bold: bool, size_pt: float) -> ImageFont.FreeTypeFont | None:
    key = (font_name, bold, int(round(size_pt * 2)))
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    px = max(8, int(round(size_pt)))
    loaded: ImageFont.FreeTypeFont | None = None
    try:
        if font_name == FONT_MONO and Path(MENLO_TTC).exists():
            loaded = ImageFont.truetype(MENLO_TTC, px, index=1 if bold else 0)
        elif font_name == FONT_SERIF:
            p = Path(GEORGIA_BOLD_TTF if bold else GEORGIA_REG_TTF)
            if p.exists():
                loaded = ImageFont.truetype(str(p), px)
        elif Path(AVENIR_NEXT_TTC).exists():
            # Avenir Next.ttc: index 0=Bold, 2=Demi Bold, 7=Regular
            loaded = ImageFont.truetype(AVENIR_NEXT_TTC, px, index=0 if bold else 7)
    except OSError:
        loaded = None
    _FONT_CACHE[key] = loaded
    return loaded


def _measure_text_pt(text: str, font_name: str, bold: bool, size_pt: float) -> float:
    font = _get_pil_font(font_name, bold, 100.0)
    if font is not None:
        return float(font.getlength(text)) * (size_pt / 100.0) * 1.035
    factor = 0.60 if font_name == FONT_MONO else (0.56 if bold else 0.51)
    return len(text) * size_pt * factor


@dataclass
class TextRunSpec:
    text: str
    size_pt: float = 12.6
    bold: bool = False
    color: RGBColor | None = None
    font_name: str = FONT_SANS
    italic: bool = False
    hyperlink: str | None = None


@dataclass
class ParagraphSpec:
    runs: Sequence[TextRunSpec]
    space_after_pt: float = 4.0
    space_before_pt: float = 0.0
    line_spacing: float = 1.26
    align: PP_ALIGN = PP_ALIGN.LEFT


@dataclass
class PlacedImageRecord:
    slide_num: int
    path: Path
    src_w: int
    src_h: int
    placed_w_in: float
    placed_h_in: float


@dataclass
class DeckContext:
    prs: Presentation
    reviewer_pass: dict[str, str]
    placed_images: list[PlacedImageRecord] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Frameless Swiss Editorial Primitives (Zero ROUNDED_RECTANGLE)
# ---------------------------------------------------------------------------

def set_theme_hyperlink_color(prs: Presentation, hex_rgb: str = "1B4F9C") -> None:
    """Set presentation theme hyperlink color to Deep Ink Cobalt on Warm Alabaster."""
    for rel in prs.slide_masters[0].part.rels.values():
        if rel.reltype.endswith("/theme"):
            theme_el = etree.fromstring(rel.target_part.blob)
            for tag in ("hlink", "folHlink"):
                node = theme_el.find(f".//{{{NS_A}}}{tag}")
                if node is not None:
                    for child in list(node):
                        node.remove(child)
                    etree.SubElement(node, f"{{{NS_A}}}srgbClr", val=hex_rgb)
            rel.target_part._blob = etree.tostring(
                theme_el, xml_declaration=True, encoding="UTF-8", standalone=True
            )


def set_slide_background(slide, color: RGBColor) -> None:
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = color


def add_hairline(
    container,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    *,
    color: RGBColor = HAIRLINE,
    width_pt: float = 0.5,
    name: str | None = None,
):
    conn = container.shapes.add_connector(
        MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2)
    )
    if name:
        conn.name = name
    conn.shadow.inherit = False
    conn.line.color.rgb = color
    conn.line.width = Pt(width_pt)
    return conn


def add_flat_fill(
    container,
    x: float,
    y: float,
    w: float,
    h: float,
    fill: RGBColor = LIMESTONE,
    name: str | None = None,
):
    shape = container.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h)
    )
    if name:
        shape.name = name
    shape.shadow.inherit = False
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    shape.line.fill.background()
    return shape


def add_node_marker(
    container,
    cx: float,
    cy: float,
    size_in: float,
    fill: RGBColor,
    name: str | None = None,
):
    shape = container.shapes.add_shape(
        MSO_SHAPE.OVAL,
        Inches(cx - size_in / 2.0),
        Inches(cy - size_in / 2.0),
        Inches(size_in),
        Inches(size_in),
    )
    if name:
        shape.name = name
    shape.shadow.inherit = False
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    shape.line.fill.background()
    return shape


def add_textbox(
    container,
    x: float,
    y: float,
    w: float,
    h: float,
    paragraphs: Sequence[ParagraphSpec],
    default_color: RGBColor = INK_BODY,
    anchor: MSO_ANCHOR = MSO_ANCHOR.TOP,
    margin_lr_pt: float = 0.0,
    margin_tb_pt: float = 0.0,
    word_wrap: bool = True,
    name: str | None = None,
):
    tb = container.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    if name:
        tb.name = name
    tf = tb.text_frame
    tf.word_wrap = word_wrap
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.vertical_anchor = anchor
    tf.margin_left = Pt(margin_lr_pt)
    tf.margin_right = Pt(margin_lr_pt)
    tf.margin_top = Pt(margin_tb_pt)
    tf.margin_bottom = Pt(margin_tb_pt)

    for idx, pspec in enumerate(paragraphs):
        p = tf.paragraphs[0] if idx == 0 else tf.add_paragraph()
        p.alignment = pspec.align
        p.line_spacing = pspec.line_spacing
        p.space_before = Pt(pspec.space_before_pt)
        p.space_after = Pt(pspec.space_after_pt)
        for rspec in pspec.runs:
            run = p.add_run()
            run.text = rspec.text
            run.font.name = rspec.font_name
            run.font.size = Pt(rspec.size_pt)
            run.font.bold = rspec.bold
            run.font.italic = rspec.italic
            run.font.color.rgb = rspec.color if rspec.color is not None else default_color
            if rspec.hyperlink:
                run.hyperlink.address = rspec.hyperlink
    return tb


def add_image_fit(
    ctx: DeckContext,
    slide_num: int,
    container,
    path: Path,
    box_x: float,
    box_y: float,
    box_w: float,
    box_h: float,
    align_x: Literal["left", "center", "right"] = "center",
    align_y: Literal["top", "center", "bottom"] = "center",
    name: str | None = None,
):
    if not path.exists():
        raise FileNotFoundError(f"Missing visual asset: {path}")
    with Image.open(path) as im:
        src_w, src_h = im.size
    if src_w <= 0 or src_h <= 0:
        raise ValueError(f"Invalid image dimensions for {path}: {src_w}x{src_h}")

    scale = min(box_w / src_w, box_h / src_h)
    placed_w = src_w * scale
    placed_h = src_h * scale

    if align_x == "left":
        px = box_x
    elif align_x == "right":
        px = box_x + (box_w - placed_w)
    else:
        px = box_x + (box_w - placed_w) / 2.0

    if align_y == "top":
        py = box_y
    elif align_y == "bottom":
        py = box_y + (box_h - placed_h)
    else:
        py = box_y + (box_h - placed_h) / 2.0

    pic = container.shapes.add_picture(
        str(path), Inches(px), Inches(py), width=Inches(placed_w), height=Inches(placed_h)
    )
    if name:
        pic.name = name
    ctx.placed_images.append(
        PlacedImageRecord(
            slide_num=slide_num,
            path=path,
            src_w=src_w,
            src_h=src_h,
            placed_w_in=placed_w,
            placed_h_in=placed_h,
        )
    )
    return pic


def start_group(slide, name: str):
    grp = slide.shapes.add_group_shape()
    grp.name = name
    return grp


def init_editorial_slide(
    ctx: DeckContext,
    slide_num: int,
    running_header: str,
    action_title: str,
    folio_text: str,
    *,
    title_size_pt: float = 24.0,
):
    """Initialize a unified #FAF8F5 Swiss editorial slide with upscaled typography."""
    slide = ctx.prs.slides.add_slide(ctx.prs.slide_layouts[6])
    set_slide_background(slide, PAPER)

    add_image_fit(
        ctx, slide_num, slide, ASSETS_DIR / "theodic_mark_dark.png",
        MARGIN_X, RAIL_Y, 0.43, 0.26,
        align_x="left", align_y="center", name="!!rail_mark",
    )
    add_textbox(
        slide, MARGIN_X + 0.54, RAIL_Y, 9.80, 0.26,
        [ParagraphSpec([TextRunSpec(running_header, 10.5, True, INK_MUTED, FONT_SANS)], space_after_pt=0)],
        INK_MUTED, anchor=MSO_ANCHOR.MIDDLE, name="!!rail_section",
    )
    add_textbox(
        slide, 10.8, RAIL_Y, 13.333 - MARGIN_X - 10.8, 0.26,
        [ParagraphSpec([TextRunSpec("THEODIC", 10.5, True, INK_MUTED, FONT_SANS)], space_after_pt=0, align=PP_ALIGN.RIGHT)],
        INK_MUTED, anchor=MSO_ANCHOR.MIDDLE, name="!!rail_brand",
    )

    add_textbox(
        slide, MARGIN_X, TITLE_Y, CONTENT_W, 0.84,
        [ParagraphSpec([TextRunSpec(action_title, title_size_pt, True, INK_PRIMARY, FONT_SERIF)], space_after_pt=0, line_spacing=1.10)],
        INK_PRIMARY, anchor=MSO_ANCHOR.MIDDLE, name=f"action_title_{slide_num}",
    )

    add_hairline(slide, MARGIN_X, RULE_Y, MARGIN_X + CONTENT_W, RULE_Y, color=HAIRLINE, width_pt=0.5, name="!!header_rule")

    add_textbox(
        slide, 10.5, FOLIO_Y, 13.333 - MARGIN_X - 10.5, 0.26,
        [ParagraphSpec([TextRunSpec(folio_text, 10.5, False, INK_MUTED, FONT_SANS)], space_after_pt=0, align=PP_ALIGN.RIGHT)],
        INK_MUTED, anchor=MSO_ANCHOR.MIDDLE, name="!!footer_counter",
    )
    return slide


# ---------------------------------------------------------------------------
# OpenXML Transitions & Automatic Entrance Cascades
# ---------------------------------------------------------------------------

def apply_transition_and_timing(
    slide,
    *,
    mode: Literal["fade", "morph"],
    dur_ms: int,
    animate_shape_ids: Sequence[int],
    step_ms: int = 90,
    effect_dur_ms: int = 260,
    max_delay_ms: int = 360,
) -> None:
    """Inject schema-ordered transition + staggered automatic entrance timing."""
    sld_el = slide._element
    for tag in (qn("p:transition"), f"{{{NS_MC}}}AlternateContent", qn("p:timing")):
        for old in sld_el.findall(tag):
            sld_el.remove(old)

    if mode == "morph":
        trans_el = etree.fromstring(
            f'<mc:AlternateContent xmlns:mc="{NS_MC}" xmlns:p="{NS_P}" '
            f'xmlns:p14="{NS_P14}" xmlns:p159="{NS_P159}">'
            f'  <mc:Choice Requires="p159">'
            f'    <p:transition spd="med" p14:dur="{dur_ms}">'
            f'      <p159:morph option="byObject"/>'
            f'    </p:transition>'
            f'  </mc:Choice>'
            f'  <mc:Fallback>'
            f'    <p:transition spd="med" p14:dur="{dur_ms}">'
            f'      <p:fade/>'
            f'    </p:transition>'
            f'  </mc:Fallback>'
            f'</mc:AlternateContent>'
        )
    else:
        trans_el = etree.fromstring(
            f'<mc:AlternateContent xmlns:mc="{NS_MC}" xmlns:p="{NS_P}" xmlns:p14="{NS_P14}">'
            f'  <mc:Choice Requires="p14">'
            f'    <p:transition p14:dur="{dur_ms}">'
            f'      <p:fade/>'
            f'    </p:transition>'
            f'  </mc:Choice>'
            f'  <mc:Fallback>'
            f'    <p:transition>'
            f'      <p:fade/>'
            f'    </p:transition>'
            f'  </mc:Fallback>'
            f'</mc:AlternateContent>'
        )

    valid_ids = {
        int(el.get("id"))
        for el in sld_el.findall(f".//{{{NS_P}}}cNvPr")
        if el.get("id") is not None
    }
    ordered_ids: list[int] = []
    for spid in animate_shape_ids:
        if spid in valid_ids and spid not in ordered_ids:
            ordered_ids.append(spid)

    ext_lst = sld_el.find(qn("p:extLst"))
    if ext_lst is not None:
        ext_lst.addprevious(trans_el)
    else:
        sld_el.append(trans_el)

    if not ordered_ids:
        return

    next_id = 5
    par_nodes: list[str] = []
    bld_nodes: list[str] = []
    for idx, spid in enumerate(ordered_ids):
        delay = min(idx * step_ms, max_delay_ms)
        ctn_main = next_id
        ctn_set = next_id + 1
        ctn_anim = next_id + 2
        next_id += 3
        par_nodes.append(
            f'<p:par>'
            f'  <p:cTn id="{ctn_main}" presetID="10" presetClass="entr" presetSubtype="0" '
            f'         fill="hold" grpId="0" nodeType="withEffect">'
            f'    <p:stCondLst><p:cond delay="{delay}"/></p:stCondLst>'
            f'    <p:childTnLst>'
            f'      <p:set>'
            f'        <p:cBhvr>'
            f'          <p:cTn id="{ctn_set}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>'
            f'          <p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl>'
            f'          <p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>'
            f'        </p:cBhvr>'
            f'        <p:to><p:strVal val="visible"/></p:to>'
            f'      </p:set>'
            f'      <p:animEffect transition="in" filter="fade">'
            f'        <p:cBhvr>'
            f'          <p:cTn id="{ctn_anim}" dur="{effect_dur_ms}"/>'
            f'          <p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl>'
            f'        </p:cBhvr>'
            f'      </p:animEffect>'
            f'    </p:childTnLst>'
            f'  </p:cTn>'
            f'</p:par>'
        )
        bld_nodes.append(f'<p:bldP spid="{spid}" grpId="0" animBg="1"/>')

    timing_el = etree.fromstring(
        f'<p:timing xmlns:p="{NS_P}">'
        f'  <p:tnLst>'
        f'    <p:par>'
        f'      <p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">'
        f'        <p:childTnLst>'
        f'          <p:seq concurrent="1" nextAc="seek">'
        f'            <p:cTn id="2" dur="indefinite" nodeType="mainSeq">'
        f'              <p:childTnLst>'
        f'                <p:par>'
        f'                  <p:cTn id="3" fill="hold">'
        f'                    <p:stCondLst><p:cond delay="0"/></p:stCondLst>'
        f'                    <p:childTnLst>'
        f'                      <p:par>'
        f'                        <p:cTn id="4" fill="hold">'
        f'                          <p:stCondLst><p:cond delay="0"/></p:stCondLst>'
        f'                          <p:childTnLst>{"".join(par_nodes)}</p:childTnLst>'
        f'                        </p:cTn>'
        f'                      </p:par>'
        f'                    </p:childTnLst>'
        f'                  </p:cTn>'
        f'                </p:par>'
        f'              </p:childTnLst>'
        f'            </p:cTn>'
        f'            <p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
        f'            <p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>'
        f'          </p:seq>'
        f'        </p:childTnLst>'
        f'      </p:cTn>'
        f'    </p:par>'
        f'  </p:tnLst>'
        f'  <p:bldLst>{"".join(bld_nodes)}</p:bldLst>'
        f'</p:timing>'
    )

    if ext_lst is not None:
        ext_lst.addprevious(timing_el)
    else:
        sld_el.append(timing_el)


# ---------------------------------------------------------------------------
# Slide Builders (Slides 01 - 14)
# ---------------------------------------------------------------------------

def build_slide_01_cover(ctx: DeckContext) -> None:
    slide = ctx.prs.slides.add_slide(ctx.prs.slide_layouts[6])
    set_slide_background(slide, PAPER)

    add_image_fit(
        ctx, 1, slide, ASSETS_DIR / "cover_editorial_bg.png",
        0.0, 0.0, SLIDE_W_IN, SLIDE_H_IN,
        align_x="center", align_y="center", name="cover_bg",
    )

    # All cover copy strictly confined to x <= 6.70" so it never collides with arch
    left_w = 6.05
    g_head = start_group(slide, "s1_brand_headline")
    add_image_fit(
        ctx, 1, g_head, ASSETS_DIR / "theodic_logo_dark.png",
        0.65, 0.68, 3.10, 0.50, align_x="left", align_y="center", name="cover_logo",
    )
    add_textbox(
        g_head, 0.65, 1.58, left_w, 0.30,
        [ParagraphSpec([TextRunSpec("SEED & INNOVATION GRANT BRIEF  ·  AI / BIG DATA", 10.8, True, INK_MUTED, FONT_SANS)], space_after_pt=0)],
        INK_MUTED, anchor=MSO_ANCHOR.MIDDLE,
    )
    add_textbox(
        g_head, 0.65, 1.94, left_w, 2.06,
        [ParagraphSpec([TextRunSpec(
            "Governed AI Execution Control Plane for Hong Kong SMEs",
            34.0, True, INK_PRIMARY, FONT_SERIF,
        )], space_after_pt=0, line_spacing=1.10)],
        INK_PRIMARY, anchor=MSO_ANCHOR.TOP,
    )
    add_textbox(
        g_head, 0.65, 4.10, left_w - 0.05, 1.50,
        [
            ParagraphSpec([TextRunSpec(
                "Connecting intelligence with the way industries work.",
                14.5, True, COBALT, FONT_SERIF, italic=True,
            )], space_after_pt=8, line_spacing=1.20),
            ParagraphSpec([TextRunSpec(
                "Turning unstructured business documents and operational requests into audited, human-approved ERP drafts without migrating core systems.",
                14.0, False, INK_BODY, FONT_SANS,
            )], space_after_pt=0, line_spacing=1.26),
        ],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )

    # Clean 2-column metadata strip matching user edits (No 3rd SUBMISSION col, No folio)
    g_meta = start_group(slide, "s1_metadata")
    add_hairline(g_meta, 0.65, 5.82, 6.70, 5.82, color=HAIRLINE, width_pt=0.75)
    meta_cols = [
        (0.65, 1.55, "DOMAIN", "AI / Big Data"),
        (2.40, 4.30, "APPLICANT", "Theodic Limited (Proposed)\n4 HKUST Members · HK$100,000"),
    ]
    for mx, mw, mk, mv in meta_cols:
        add_textbox(
            g_meta, mx, 5.96, mw, 0.90,
            [
                ParagraphSpec([TextRunSpec(mk, 10.5, True, INK_MUTED, FONT_SANS)], space_after_pt=4),
                ParagraphSpec([TextRunSpec(mv, 12.4, False, INK_PRIMARY, FONT_SANS)], space_after_pt=0, line_spacing=1.22),
            ],
            INK_PRIMARY, anchor=MSO_ANCHOR.TOP,
        )

    apply_transition_and_timing(slide, mode="fade", dur_ms=400, animate_shape_ids=[g_head.shape_id, g_meta.shape_id])


def build_slide_02_exec_summary(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 2,
        "02  /  EXECUTIVE SUMMARY  ·  THEODIC BRIDGE ARCHITECTURE",
        "Theodic connects enterprise AI with Hong Kong SME operations through a verifiable, zero-migration governance layer",
        "02",
    )

    # Top Zone: 3-Column Frameless Architectural Bridge separated by vertical 0.5pt hairlines
    g_bridge = start_group(slide, "s2_bridge")
    col_w = 3.74
    col_gap = (CONTENT_W - 3 * col_w) / 2.0
    cols = [
        ("01", "Two Independent Worlds", "Traditional SME operations run on ERP, accounting software, Excel, and messaging apps disconnected from modern AI agents.", INK_MUTED, INK_PRIMARY),
        ("02", "The Governed Intersection", "Theodic bridges both worlds through deterministic catalog, pricing, and policy rules enforced by cell-level permissions.", COBALT, COBALT),
        ("03", "Continuous Transformation", "Teams upgrade daily execution inside their existing software stack with zero core migration and zero unapproved writes.", INK_MUTED, INK_PRIMARY),
    ]
    for i, (num, hdr, body, ncol, hcol) in enumerate(cols):
        cx = MARGIN_X + i * (col_w + col_gap)
        add_textbox(
            g_bridge, cx, BODY_TOP, col_w, 1.72,
            [
                ParagraphSpec([TextRunSpec(num, 25.0, True, ncol, FONT_SERIF)], space_after_pt=4, line_spacing=1.05),
                ParagraphSpec([TextRunSpec(hdr, 14.5, True, hcol, FONT_SANS)], space_after_pt=5, line_spacing=1.15),
                ParagraphSpec([TextRunSpec(body, 13.0, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.24),
            ],
            INK_BODY, anchor=MSO_ANCHOR.TOP,
        )
        if i < 2:
            vx = cx + col_w + col_gap / 2.0
            add_hairline(g_bridge, vx, BODY_TOP + 0.06, vx, BODY_TOP + 1.66, color=HAIRLINE, width_pt=0.5)

    add_hairline(slide, MARGIN_X, 3.44, MARGIN_X + CONTENT_W, 3.44, color=HAIRLINE, width_pt=0.5)

    # Bottom Asymmetric Split
    g_left = start_group(slide, "s2_thesis_team")
    lw = 4.92
    add_textbox(
        g_left, MARGIN_X, 3.62, lw, 1.72,
        [
            ParagraphSpec([TextRunSpec("VISION & WEDGE", 10.6, True, INK_MUTED, FONT_SANS)], space_after_pt=5),
            ParagraphSpec([TextRunSpec(
                "Make governed AI practical across Hong Kong's 357,965 SMEs. "
                "Clean routine orders run at zero vision-model cost, while exceptions route to human approvers.",
                13.0, False, INK_BODY, FONT_SANS,
            )], space_after_pt=0, line_spacing=1.26),
        ],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )
    add_hairline(g_left, MARGIN_X, 5.44, MARGIN_X + lw, 5.44, color=HAIRLINE, width_pt=0.5)
    add_textbox(
        g_left, MARGIN_X, 5.58, lw, 1.24,
        [
            ParagraphSpec([TextRunSpec("WHO WE ARE", 10.6, True, INK_MUTED, FONT_SANS)], space_after_pt=5),
            ParagraphSpec([TextRunSpec(
                "Four HKUST members who built and end-to-end tested a 36-module Python platform and trilingual workbench prior to applying.",
                13.0, False, INK_BODY, FONT_SANS,
            )], space_after_pt=0, line_spacing=1.26),
        ],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )

    add_hairline(slide, 5.76, 3.62, 5.76, 6.78, color=HAIRLINE, width_pt=0.5)

    # Right 2x2 Top-Ruled Georgia Metrics (zero arrows)
    g_metrics = start_group(slide, "s2_metrics")
    rx = 6.04
    mw = (MARGIN_X + CONTENT_W - rx - 0.36) / 2.0
    mh = 1.54
    metrics = [
        ("8 to 3 min", "Average handling time per case at a 12.5% exception rate (Modeled)", INK_PRIMARY, INK_PRIMARY),
        ("HK$40,390", "First-year net buyer savings at 1,800 cases/month; 10-month payback", INK_PRIMARY, INK_PRIMARY),
        ("Month 3", "Commercial launch commitment within 90 days of project kickoff", COBALT, COBALT),
        ("HK$100,000", "Seed grant budget: 64% product & security audit, 36% cloud & GTM", INK_PRIMARY, INK_PRIMARY),
    ]
    for idx, (val, desc, rcol, vcol) in enumerate(metrics):
        ci = idx % 2
        ri = idx // 2
        mx = rx + ci * (mw + 0.36)
        my = 3.62 + ri * (mh + 0.22)
        add_hairline(g_metrics, mx, my, mx + mw, my, color=rcol, width_pt=1.25)
        add_textbox(
            g_metrics, mx, my + 0.14, mw, mh - 0.14,
            [
                ParagraphSpec([TextRunSpec(val, 30.0, True, vcol, FONT_SERIF)], space_after_pt=6, line_spacing=1.05),
                ParagraphSpec([TextRunSpec(desc, 12.6, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.22),
            ],
            INK_BODY, anchor=MSO_ANCHOR.TOP,
        )

    apply_transition_and_timing(slide, mode="fade", dur_ms=450, animate_shape_ids=[g_bridge.shape_id, g_left.shape_id, g_metrics.shape_id])


def build_slide_03_pain_market(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 3,
        "03  /  PAIN POINTS & MARKET DEMAND  ·  HONG KONG SMES",
        "Hong Kong's 357,965 SMEs face manual clerical bottlenecks where low ERP adoption meets an expensive exception tail",
        "03",
    )

    lw = 4.42
    g_left = start_group(slide, "s3_pain_narrative")
    blocks = [
        (
            "01  ·  MANUAL CLERICAL BOTTLENECK (8 MIN / CASE)",
            "Clerks manually check PDFs, WhatsApp messages, and emails against SKU catalogs and pricing rules before re-keying into ERP. Hong Kong clerks earn a median HK$72.4/hr, and shipping clerks average HK$20,312/month.",
            1.78,
        ),
        (
            "02  ·  WHERE MANUAL & UNGOVERNED AI FAIL (12.5%–25% TAIL)",
            "Pack-unit mismatches, mid-thread order revisions, silent LLM hallucinations, and duplicate writes during network retries make unverified AI unsafe for live operations.",
            1.54,
        ),
        (
            "03  ·  ADDRESSABLE HONG KONG SME MARKET",
            "Of Hong Kong's 357,965 SMEs, 92,307 operate in trade, wholesale, and logistics, including 8,202 mid-sized B2B firms (10–49 staff). Only 6.0% run ERP, and while 55% plan to use AI, just 32% of AI users pay for tools.",
            1.76,
        ),
    ]
    cy = BODY_TOP
    for i, (kicker, body, bh) in enumerate(blocks):
        add_textbox(
            g_left, MARGIN_X, cy, lw, bh,
            [
                ParagraphSpec([TextRunSpec(kicker, 10.6, True, COBALT if i == 1 else INK_MUTED, FONT_SANS)], space_after_pt=4),
                ParagraphSpec([TextRunSpec(body, 12.6, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.22),
            ],
            INK_BODY, anchor=MSO_ANCHOR.TOP,
        )
        cy += bh
        if i < 2:
            add_hairline(g_left, MARGIN_X, cy + 0.02, MARGIN_X + lw, cy + 0.02, color=HAIRLINE, width_pt=0.5)
            cy += 0.11

    rx = 5.26
    rw = MARGIN_X + CONTENT_W - rx  # 7.473 in
    g_chart = start_group(slide, "s3_chart_gap")
    add_image_fit(
        ctx, 3, g_chart, ASSETS_DIR / "chart_hk_sme_gap.png",
        rx, BODY_TOP, rw, 4.82, align_x="center", align_y="top", name="s3_chart_img",
    )
    add_textbox(
        g_chart, rx, 6.48, rw, 0.44,
        [ParagraphSpec([TextRunSpec(
            "Official Hong Kong SME market structure (top), enterprise software gap (bottom left), and paid AI gap (bottom right).",
            10.8, False, INK_MUTED, FONT_SANS,
        )], space_after_pt=0, line_spacing=1.18)],
        INK_MUTED, anchor=MSO_ANCHOR.TOP,
    )

    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=[g_left.shape_id, g_chart.shape_id])


def build_slide_04_solution_mvp(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 4,
        "04  /  SOLUTION & LIVE MVP  ·  ZERO-CORE-MIGRATION WORKBENCH",
        "Theodic delivers a five-stage governed SME execution workbench verified across 36 backend modules and 26 E2E tests",
        "04",
    )

    # Top Zone: 5-Stage Frameless Pipeline Along 0.5pt Rule
    g_pipe = start_group(slide, "s4_pipeline")
    stages = [
        ("01  Intake Lock", "Records SHA-256 file hashes and exact pixel coordinates."),
        ("02  Confidence Route", "Runs local OCR and math first; sends crops on conflicts."),
        ("03  Policy Queue", "Enforces cell-level access and blocks self-approval."),
        ("04  Digest Lock", "Binds manager sign-off to an immutable payload hash."),
        ("05  Read-Back", "Stages the ERP draft and verifies the written receipt."),
    ]
    sw = 2.28
    sgap = (CONTENT_W - 5 * sw) / 4.0
    add_hairline(g_pipe, MARGIN_X, BODY_TOP + 0.04, MARGIN_X + CONTENT_W, BODY_TOP + 0.04, color=HAIRLINE, width_pt=0.5)
    for i, (st, sb) in enumerate(stages):
        sx = MARGIN_X + i * (sw + sgap)
        add_hairline(g_pipe, sx, BODY_TOP + 0.04, sx + 0.45, BODY_TOP + 0.04, color=COBALT if i in (1, 3) else INK_PRIMARY, width_pt=1.5)
        add_textbox(
            g_pipe, sx, BODY_TOP + 0.14, sw, 0.94,
            [
                ParagraphSpec([TextRunSpec(st, 12.2, True, INK_PRIMARY, FONT_SANS)], space_after_pt=3),
                ParagraphSpec([TextRunSpec(sb, 11.4, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.18),
            ],
            INK_BODY, anchor=MSO_ANCHOR.TOP,
        )

    # Middle Zone: Enlarged Tight UI Crops
    g_ui = start_group(slide, "s4_ui_crops")
    ui_y = 2.74
    ui_h = 2.82
    left_ui_w = 7.45
    right_ui_x = MARGIN_X + left_ui_w + 0.34
    right_ui_w = CONTENT_W - left_ui_w - 0.34  # 4.343 in

    add_image_fit(
        ctx, 4, g_ui, ASSETS_DIR / "ui_po_conflict_zoom.png",
        MARGIN_X, ui_y, left_ui_w, ui_h, align_x="left", align_y="center", name="s4_po_zoom",
    )
    add_image_fit(
        ctx, 4, g_ui, ASSETS_DIR / "ui_agent_lookup_zoom.png",
        right_ui_x, ui_y, right_ui_w, ui_h, align_x="center", align_y="center", name="s4_agent_zoom",
    )
    add_textbox(
        g_ui, MARGIN_X, 5.60, left_ui_w, 0.44,
        [ParagraphSpec([TextRunSpec(
            "Order PO-1043 showing a pixel-anchored quantity conflict (2 vs. 8) and deterministic catalog validation.",
            10.8, False, INK_MUTED, FONT_SANS,
        )], space_after_pt=0, line_spacing=1.15)],
        INK_MUTED, anchor=MSO_ANCHOR.TOP,
    )
    add_textbox(
        g_ui, right_ui_x, 5.60, right_ui_w, 0.44,
        [ParagraphSpec([TextRunSpec(
            "Trilingual inbox and grounded assistant across orders, invoices, and shipments.",
            10.8, False, INK_MUTED, FONT_SANS,
        )], space_after_pt=0, line_spacing=1.15)],
        INK_MUTED, anchor=MSO_ANCHOR.TOP,
    )

    # Bottom Frameless Strip under 0.5pt Rule
    g_bot = start_group(slide, "s4_bottom_strip")
    add_hairline(g_bot, MARGIN_X, 6.08, MARGIN_X + CONTENT_W, 6.08, color=HAIRLINE, width_pt=0.5)
    add_textbox(
        g_bot, MARGIN_X, 6.14, 5.82, 0.78,
        [
            ParagraphSpec([TextRunSpec("SAFETY BOUNDARY", 10.6, True, COBALT, FONT_SANS)], space_after_pt=2),
            ParagraphSpec([TextRunSpec(
                "Stages drafts only across sales orders, shipment updates, and quality or contract checks—never executing autonomous payments or dispatches.",
                11.6, False, INK_BODY, FONT_SANS,
            )], space_after_pt=0, line_spacing=1.16),
        ],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )
    add_hairline(g_bot, 6.58, 6.14, 6.58, 6.86, color=HAIRLINE, width_pt=0.5)
    add_textbox(
        g_bot, 6.76, 6.14, MARGIN_X + CONTENT_W - 6.76, 0.78,
        [
            ParagraphSpec([TextRunSpec("VERIFIED MVP FOOTPRINT", 10.6, True, INK_MUTED, FONT_SANS)], space_after_pt=2),
            ParagraphSpec([TextRunSpec(
                "36 Python backend modules (6,105 LOC), 23 row-secured tables, 119 TypeScript UI files, 67 unit tests, and 26/26 Playwright E2E tests.",
                11.6, False, INK_BODY, FONT_SANS,
            )], space_after_pt=0, line_spacing=1.16),
        ],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )

    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=[g_pipe.shape_id, g_ui.shape_id, g_bot.shape_id])


def build_slide_05_creativity_innovation(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 5,
        "05  /  CREATIVITY & INNOVATION",
        "Four proprietary governance primitives eliminate hallucinated writes and distinguish Theodic from no-code AI wrappers",
        "05",
    )

    # Clean 2x2 Swiss Crosshair Grid without small file-path lines
    mid_x = MARGIN_X + CONTENT_W / 2.0  # 6.6665 in
    mid_y = 4.24
    add_hairline(slide, mid_x, 1.76, mid_x, 6.68, color=HAIRLINE, width_pt=0.5, name="s5_cross_v")
    add_hairline(slide, MARGIN_X, mid_y, MARGIN_X + CONTENT_W, mid_y, color=HAIRLINE, width_pt=0.5, name="s5_cross_h")

    quads = [
        (
            "01",
            "Confidence-Routed Pixel Extraction",
            "Local OCR and deterministic row math clear clean documents with zero vision-model calls. Only low-confidence or mismatched fields send tight pixel crops, capped at four calls per document.",
            COBALT,
        ),
        (
            "02",
            "Cell-Level Policy & Typed Output Firewall",
            "Intersects user role, tenant row security, and model field permissions before prompt assembly. Blocks injection patterns, caps output at 16 KiB, and enforces strict schema enums.",
            INK_PRIMARY,
        ),
        (
            "03",
            "Separation of Duties & Signed Audit Ledger",
            "Prevents requesters from approving their own submissions, requires independent track sign-off, and rejects stale snapshots. Every record is AES-GCM encrypted, hash-chained, and Ed25519 signed.",
            INK_PRIMARY,
        ),
        (
            "04",
            "Epoch-Fenced Outbox & ERP Read-Back",
            "Separates API and worker database privileges across 23 protected tables. Row-locked queue claims, monotonic epochs, and mandatory ERP receipt verification prevent duplicate writes.",
            INK_PRIMARY,
        ),
    ]

    qw = CONTENT_W / 2.0 - 0.34
    qh = 2.26
    gids: list[int] = []
    for idx, (num, qtitle, qbody, ncol) in enumerate(quads):
        ci = idx % 2
        ri = idx // 2
        qx = MARGIN_X if ci == 0 else mid_x + 0.34
        qy = 1.84 if ri == 0 else mid_y + 0.24
        grp = start_group(slide, f"s5_quad_{idx+1}")
        add_textbox(
            grp, qx, qy, qw, qh,
            [
                ParagraphSpec([
                    TextRunSpec(num + "   ", 28.0, True, ncol, FONT_SERIF),
                    TextRunSpec(qtitle, 15.5, True, INK_PRIMARY, FONT_SANS),
                ], space_after_pt=10, line_spacing=1.10),
                ParagraphSpec([TextRunSpec(qbody, 13.4, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.32),
            ],
            INK_BODY, anchor=MSO_ANCHOR.TOP,
        )
        gids.append(grp.shape_id)

    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=gids)


def build_slide_06_business_model(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 6,
        "06  /  BUSINESS MODEL & TIME TO MARKET",
        "Commercial launch in Month 3 (≤ 90 days) pairs HK$15k–39k bounded pilots with 62.5%-margin SaaS",
        "06",
    )

    lw = 4.76
    g_left = start_group(slide, "s6_biz_narrative")
    sections = [
        (
            "01  ·  90-DAY COMMERCIAL LAUNCH & TARGETS",
            "Commercial launch is set for Month 3 (within 90 days), scaling to 3 live SMEs, 1,500+ processed cases, and zero unauthorized writes by Month 6. Modeled Month-36 ARR reaches HK$500k to HK$1.17M.",
            COBALT,
            1.66,
        ),
        (
            "02  ·  PHASED PRICING & GO-TO-MARKET",
            "Staged onboarding spans Diagnosis (HK$4k), Validation (HK$10k), Pilot (HK$25k), and Production Setup (HK$15k), followed by HK$4,000/month SaaS. Acquisition runs via member-led audits, HKTDC/HKPC clinics, and API/CSV integration with Xero, ABSS, Odoo, and Excel.",
            INK_MUTED,
            1.96,
        ),
        (
            "03  ·  BUYER ROI & UNIT ECONOMICS (MODELED)",
            "Cutting handling time from 8 to 3 minutes across 1,800 monthly cases delivers HK$40,390 in first-year net buyer savings with a 10-month payback (at HK$130/hr overtime cost) and a 62.5% recurring SaaS margin.",
            INK_MUTED,
            1.44,
        ),
    ]
    cy = BODY_TOP
    for i, (kicker, body, kcol, bh) in enumerate(sections):
        add_textbox(
            g_left, MARGIN_X, cy, lw, bh,
            [
                ParagraphSpec([TextRunSpec(kicker, 10.6, True, kcol, FONT_SANS)], space_after_pt=4),
                ParagraphSpec([TextRunSpec(body, 12.2, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.20),
            ],
            INK_BODY, anchor=MSO_ANCHOR.TOP,
        )
        cy += bh
        if i < 2:
            add_hairline(g_left, MARGIN_X, cy + 0.02, MARGIN_X + lw, cy + 0.02, color=HAIRLINE, width_pt=0.5)
            cy += 0.11

    rx = 5.62
    rw = MARGIN_X + CONTENT_W - rx  # 7.113 in
    g_chart = start_group(slide, "s6_chart_econ")
    add_image_fit(
        ctx, 6, g_chart, ASSETS_DIR / "chart_unit_economics_som.png",
        rx, BODY_TOP, rw, 4.74, align_x="center", align_y="top", name="s6_chart_img",
    )
    add_textbox(
        g_chart, rx, 6.44, rw, 0.46,
        [ParagraphSpec([TextRunSpec(
            "Modeled buyer time and cash bridge (left) and 36-month capacity-constrained recurring ARR scenarios (right, excluding setup fees).",
            10.8, False, INK_MUTED, FONT_SANS,
        )], space_after_pt=0, line_spacing=1.18)],
        INK_MUTED, anchor=MSO_ANCHOR.TOP,
    )

    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=[g_left.shape_id, g_chart.shape_id])


def build_slide_07_competitive(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 7,
        "07  /  COMPETITIVE ANALYSIS",
        "Incumbents force a trade-off between unstructured OCR, full ERP migration, and unverified custom scripts",
        "07",
    )

    lw = 6.12
    g_tbl = start_group(slide, "s7_comp_table")

    col_x = [MARGIN_X, MARGIN_X + 2.00, MARGIN_X + 3.52]
    col_w = [1.90, 1.42, lw - 3.52]

    add_hairline(g_tbl, MARGIN_X, BODY_TOP, MARGIN_X + lw, BODY_TOP, color=INK_PRIMARY, width_pt=1.5)
    for cx, cw, htxt in zip(col_x, col_w, ("ALTERNATIVE", "PUBLISHED TERMS", "VERIFIED STRUCTURAL GAP")):
        add_textbox(
            g_tbl, cx, BODY_TOP + 0.08, cw, 0.28,
            [ParagraphSpec([TextRunSpec(htxt, 10.5, True, INK_MUTED, FONT_SANS)], space_after_pt=0)],
            INK_MUTED, anchor=MSO_ANCHOR.MIDDLE,
        )
    add_hairline(g_tbl, MARGIN_X, BODY_TOP + 0.40, MARGIN_X + lw, BODY_TOP + 0.40, color=INK_PRIMARY, width_pt=0.75)

    comp_rows = [
        ("PrimeFlow / Zoo AI", "HK$5k/mo · HK$28k+", "No approval digest locks, cell-level security, or ERP read-back"),
        ("Ricoh / FarSight / iGears", "Custom enterprise quote", "Bespoke SI projects with no standardized governance layer"),
        ("Rossum / Conexiom / Esker", "Annual enterprise contract", "Priced for large enterprises; lacks Traditional Chinese presets"),
        ("Odoo 20 Native AI", "Per-seat + Custom API", "Requires full ERP migration; warnings still allow draft edits"),
        ("AirPurchase / HKPC Portals", "HK$241–318/mo · portal", "Limited to F&B buyer procurement; portals lack execution gates"),
    ]
    ry = BODY_TOP + 0.48
    rh = 0.72
    for idx, (alt, terms, gap_txt) in enumerate(comp_rows):
        add_textbox(
            g_tbl, col_x[0], ry + 0.04, col_w[0], rh - 0.08,
            [ParagraphSpec([TextRunSpec(alt, 11.8, True, INK_PRIMARY, FONT_SANS)], space_after_pt=0, line_spacing=1.14)],
            INK_PRIMARY, anchor=MSO_ANCHOR.MIDDLE,
        )
        add_textbox(
            g_tbl, col_x[1], ry + 0.04, col_w[1], rh - 0.08,
            [ParagraphSpec([TextRunSpec(terms, 11.0, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.14)],
            INK_BODY, anchor=MSO_ANCHOR.MIDDLE,
        )
        add_textbox(
            g_tbl, col_x[2], ry + 0.04, col_w[2], rh - 0.08,
            [ParagraphSpec([TextRunSpec(gap_txt, 11.4, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.14)],
            INK_BODY, anchor=MSO_ANCHOR.MIDDLE,
        )
        ry += rh
        if idx < len(comp_rows) - 1:
            add_hairline(g_tbl, MARGIN_X, ry - 0.02, MARGIN_X + lw, ry - 0.02, color=HAIRLINE, width_pt=0.5)

    add_hairline(g_tbl, MARGIN_X, ry, MARGIN_X + lw, ry, color=INK_PRIMARY, width_pt=1.5)

    add_textbox(
        g_tbl, MARGIN_X, ry + 0.14, lw, BODY_BOTTOM - (ry + 0.14),
        [
            ParagraphSpec([TextRunSpec("THEODIC ADVANTAGE", 10.6, True, COBALT, FONT_SANS)], space_after_pt=4),
            ParagraphSpec([TextRunSpec(
                "Theodic layers directly onto existing SME software with zero-LLM clean routing, separation-of-duties approval locks, and verified ERP read-back.",
                12.4, True, INK_PRIMARY, FONT_SANS,
            )], space_after_pt=0, line_spacing=1.22),
        ],
        INK_PRIMARY, anchor=MSO_ANCHOR.TOP,
    )

    rx = 6.96
    rw = MARGIN_X + CONTENT_W - rx  # 5.773 in
    g_chart = start_group(slide, "s7_chart_comp")
    add_image_fit(
        ctx, 7, g_chart, ASSETS_DIR / "chart_competitor_map.png",
        rx, BODY_TOP, rw, 4.74, align_x="center", align_y="top", name="s7_chart_img",
    )
    add_textbox(
        g_chart, rx, 6.44, rw, 0.46,
        [ParagraphSpec([TextRunSpec(
            "Positioning across SME deployment speed and affordability vs. execution governance and auditability.",
            10.8, False, INK_MUTED, FONT_SANS,
        )], space_after_pt=0, line_spacing=1.18)],
        INK_MUTED, anchor=MSO_ANCHOR.TOP,
    )

    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=[g_tbl.shape_id, g_chart.shape_id])


def build_slide_08_team(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 8,
        "08  /  PROJECT MANAGEMENT TEAM",
        "Four HKUST members have already built and end-to-end verified a 36-module governed MVP prior to funding",
        "08",
    )

    g_proof = start_group(slide, "s8_pre_m1_proof")
    add_textbox(
        g_proof, MARGIN_X, BODY_TOP - 0.04, CONTENT_W, 0.44,
        [ParagraphSpec([
            TextRunSpec("PRE-GRANT PROOF   ·   ", 10.6, True, COBALT, FONT_SANS),
            TextRunSpec(
                "36 Python modules (6,105 LOC) · 23 RLS tables · 119 TypeScript UI files · 67 unit tests · 26/26 Playwright E2E.",
                11.8, True, INK_PRIMARY, FONT_SANS,
            ),
        ], space_after_pt=0, line_spacing=1.20)],
        INK_PRIMARY, anchor=MSO_ANCHOR.MIDDLE,
    )
    add_hairline(g_proof, MARGIN_X, 2.06, MARGIN_X + CONTENT_W, 2.06, color=HAIRLINE, width_pt=0.5)

    members = [
        (
            "01",
            "Lau Hoi Yiu",
            "HKUST MGMT · Year 4",
            "Founder & CEO\nStrategy & Commercialization",
            [
                ("Goldman Sachs (PWM)", "Explored bridging trade-order and compliance workflow gaps with GS AI and Microsoft Copilot."),
                ("PwC", "Conducted audit verification, due diligence, and control documentation for governed AI."),
                ("Project Melo AI-5000", "Led AI outreach, stakeholder engagement, and cross-functional delivery; leads GTM."),
            ],
        ),
        (
            "02",
            "Zheng Botao (Rex)",
            "HKUST MAEC · Year 3",
            "Co-Founder, R&D\nSystem Architecture & AIOS Lead",
            [
                ("SDIC Securities (IBD)", "Automated Python and OCR extraction on 150+ IPO filings (–70% time); verified 300+ vouchers."),
                ("BDO Consulting", "Built RPA audit tools for China Southern Airlines (–60% time) and 500+-point risk matrices."),
                ("Theodic Lead Architect", "Built the 36-module Python control plane, trilingual Next.js BFF (26/26 E2E), and HK edge stack."),
            ],
        ),
        (
            "03",
            "Chen Haofeng Michael",
            "HKUST MATH (CS) · Year 3",
            "Co-Founder, R&D\nPolicy & Verification Lead",
            [
                ("Algorithmic Accountability", "Independently leads research on moral responsibility in automated decision-making."),
                ("Human–AI Control Design", "Investigates how authority and exception handoffs divide across automated workflows."),
                ("Theodic Policy & Eval", "Co-designs separation-of-duties rules, prompt-firewall constraints, and adversarial drills."),
            ],
        ),
        (
            "04",
            "Sun Yiping",
            "HKUST CSE · Year 1",
            "Software Engineer\nFull-Stack Workbench & UX",
            [
                ("RTSBuilding (Founder & Core Dev)", "Created an open-source Minecraft mod with custom UX (130K+ downloads, 90 GitHub stars)."),
                ("LexiLamp (Founder & Full-Stack)", "Built an AI English vocabulary platform and completed a paid tutoring pilot in summer 2026."),
                ("Theodic Engineering", "Develops operator review interfaces, visual field-diff views, and connector workflows."),
            ],
        ),
    ]

    col_w = 2.83
    col_gap = (CONTENT_W - 4 * col_w) / 3.0
    col_y = 2.20
    gids = [g_proof.shape_id]

    for i, (num, name_str, edu_str, role_str, bullets) in enumerate(members):
        fx = MARGIN_X + i * (col_w + col_gap)
        grp = start_group(slide, f"s8_member_{i+1}")
        add_textbox(
            grp, fx, col_y, col_w, 1.72,
            [
                ParagraphSpec([TextRunSpec(num, 30.0, True, COBALT if i == 0 else INK_PRIMARY, FONT_SERIF)], space_after_pt=5, line_spacing=1.0),
                ParagraphSpec([TextRunSpec(name_str, 13.0, True, INK_PRIMARY, FONT_SANS)], space_after_pt=2, line_spacing=1.15),
                ParagraphSpec([TextRunSpec(edu_str, 10.6, True, INK_MUTED, FONT_SANS)], space_after_pt=6, line_spacing=1.15),
                ParagraphSpec([TextRunSpec(role_str, 10.8, True, COBALT, FONT_SANS)], space_after_pt=0, line_spacing=1.18),
            ],
            INK_PRIMARY, anchor=MSO_ANCHOR.TOP, name=f"s8_top_{i+1}",
        )
        add_hairline(grp, fx, 3.98, fx + col_w, 3.98, color=HAIRLINE, width_pt=0.5)

        bullet_pars = [
            ParagraphSpec([TextRunSpec("TRACK RECORD & OWNERSHIP", 10.5, True, INK_MUTED, FONT_SANS)], space_after_pt=5, line_spacing=1.12),
        ]
        for b_idx, (lead, detail) in enumerate(bullets):
            bullet_pars.append(
                ParagraphSpec(
                    [
                        TextRunSpec(f"• {lead}: ", 10.6, True, INK_PRIMARY, FONT_SANS),
                        TextRunSpec(detail, 10.6, False, INK_BODY, FONT_SANS),
                    ],
                    space_after_pt=4.0 if b_idx < len(bullets) - 1 else 0.0,
                    line_spacing=1.16,
                )
            )
        add_textbox(
            grp, fx, 4.08, col_w, 2.80,
            bullet_pars,
            INK_BODY, anchor=MSO_ANCHOR.TOP, name=f"s8_bot_{i+1}",
        )
        if i < 3:
            vx = fx + col_w + col_gap / 2.0
            add_hairline(grp, vx, 2.28, vx, 6.76, color=HAIRLINE, width_pt=0.5)
        gids.append(grp.shape_id)

    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=gids)


def build_slide_09_milestones(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 9,
        "09  /  6-MONTH EXECUTION MILESTONES  ·  MONTH 1 – MONTH 6",
        "Staged monthly gates deliver commercial launch in Month 3 and three live SME deployments by Month 6",
        "09",
    )

    # Top Continuous Horizontal Timeline Axis (Fund-agnostic relative months)
    g_axis = start_group(slide, "s9_timeline_axis")
    ax_y = BODY_TOP + 0.36
    nodes = [
        ("M1 · Month 1", "Tranche 1 · 10%", False),
        ("M2 · Month 2", "Eval & Security", False),
        ("M3 · Month 3", "Launch ≤ 90d · 45%", True),
        ("M4 · Month 4", "2nd SME & Open Kit", False),
        ("M5 · Month 5", "Scale & Stress Test", False),
        ("M6 · Month 6", "3 SMEs · Final 45%", False),
    ]
    step_x = (CONTENT_W - 1.50) / 5.0
    x0 = MARGIN_X + 0.75
    add_hairline(g_axis, x0, ax_y, x0 + 5 * step_x, ax_y, color=HAIRLINE, width_pt=1.0)
    for i, (m_lbl, sub_lbl, is_focus) in enumerate(nodes):
        nx = x0 + i * step_x
        add_node_marker(g_axis, nx, ax_y, 0.14 if is_focus else 0.10, COBALT if is_focus else INK_PRIMARY)
        add_textbox(
            g_axis, nx - 0.92, BODY_TOP, 1.84, 0.26,
            [ParagraphSpec([TextRunSpec(m_lbl, 11.4, True, COBALT if is_focus else INK_PRIMARY, FONT_SANS)], space_after_pt=0, align=PP_ALIGN.CENTER)],
            INK_PRIMARY, anchor=MSO_ANCHOR.MIDDLE,
        )
        add_textbox(
            g_axis, nx - 1.00, ax_y + 0.12, 2.00, 0.26,
            [ParagraphSpec([TextRunSpec(sub_lbl, 10.5, is_focus, COBALT if is_focus else INK_MUTED, FONT_SANS)], space_after_pt=0, align=PP_ALIGN.CENTER)],
            INK_MUTED, anchor=MSO_ANCHOR.MIDDLE,
        )

    # Clean 6-Row Accounting Milestone Table
    g_tbl = start_group(slide, "s9_milestone_table")
    ty = 2.62
    col_x = [MARGIN_X + 0.12, MARGIN_X + 1.86, MARGIN_X + 3.86]
    col_w = [1.64, 1.86, CONTENT_W - 3.98]

    add_hairline(g_tbl, MARGIN_X, ty, MARGIN_X + CONTENT_W, ty, color=INK_PRIMARY, width_pt=1.5)
    for cx, cw, htxt in zip(col_x, col_w, ("MONTH", "MILESTONE GATE", "DELIVERABLES & ACCEPTANCE CRITERIA")):
        add_textbox(
            g_tbl, cx, ty + 0.08, cw, 0.26,
            [ParagraphSpec([TextRunSpec(htxt, 10.5, True, INK_MUTED, FONT_SANS)], space_after_pt=0)],
            INK_MUTED, anchor=MSO_ANCHOR.MIDDLE,
        )
    add_hairline(g_tbl, MARGIN_X, ty + 0.38, MARGIN_X + CONTENT_W, ty + 0.38, color=INK_PRIMARY, width_pt=0.75)

    rows = [
        ("M1 · Month 1", "Tranche 1 · HK$10k", "Incorporate Theodic Limited, finalize customer pilot agreements, deploy Odoo/ERPNext/Xero bridges, and benchmark 50 SME cases.", False),
        ("M2 · Month 2", "Pre-Launch Gate", "Validate 200 bilingual test cases, run 15 adversarial injection drills, and pass an external privacy and row-security review (<2% critical error).", False),
        ("M3 · Month 3", "Tranche 2 · HK$45k", "Launch commercial service within 90 days; bring the first paid pilot live in draft-only mode with signed execution logs.", True),
        ("M4 · Month 4", "Pilot Expansion", "Onboard the second SME using dual API/CSV export, tune exception review under 3 minutes average, and release the open audit verifier.", False),
        ("M5 · Month 5", "Scale & Stress Test", "Onboard the third SME, pass 1,000+ concurrent duplicate and timeout stress tests, and publish the open bilingual benchmark.", False),
        ("M6 · Month 6", "Tranche 3 · HK$45k", "Operate at least 3 live SME accounts across 1,500+ order events with zero unauthorized ERP writes, ready for follow-on incubation.", False),
    ]
    ry = ty + 0.44
    rh = 0.63
    for idx, (m_str, gate_str, deliv_str, is_m3) in enumerate(rows):
        if is_m3:
            add_flat_fill(g_tbl, MARGIN_X, ry - 0.02, CONTENT_W, rh, fill=LIMESTONE)
        add_textbox(
            g_tbl, col_x[0], ry + 0.02, col_w[0], rh - 0.06,
            [ParagraphSpec([TextRunSpec(m_str, 11.8, True, COBALT if is_m3 else INK_PRIMARY, FONT_SANS)], space_after_pt=0)],
            INK_PRIMARY, anchor=MSO_ANCHOR.MIDDLE,
        )
        add_textbox(
            g_tbl, col_x[1], ry + 0.02, col_w[1], rh - 0.06,
            [ParagraphSpec([TextRunSpec(gate_str, 11.6, True if is_m3 else False, COBALT if is_m3 else INK_BODY, FONT_SANS)], space_after_pt=0)],
            INK_BODY, anchor=MSO_ANCHOR.MIDDLE,
        )
        add_textbox(
            g_tbl, col_x[2], ry + 0.02, col_w[2], rh - 0.06,
            [ParagraphSpec([TextRunSpec(deliv_str, 11.6, is_m3, INK_PRIMARY if is_m3 else INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.15)],
            INK_BODY, anchor=MSO_ANCHOR.MIDDLE,
        )
        ry += rh
        if idx < len(rows) - 1:
            add_hairline(g_tbl, MARGIN_X, ry - 0.02, MARGIN_X + CONTENT_W, ry - 0.02, color=HAIRLINE, width_pt=0.5)

    add_hairline(g_tbl, MARGIN_X, ry, MARGIN_X + CONTENT_W, ry, color=INK_PRIMARY, width_pt=1.5)

    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=[g_axis.shape_id, g_tbl.shape_id])


def build_slide_10_budget(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 10,
        "10  /  COST BUDGET  ·  HK$100,000 GRANT ALLOCATION",
        "HK$100,000 allocates 64% to engineering and audits, bridged to post-grant viability via Month 3 pilots",
        "10",
    )

    lw = 5.75
    g_tbl = start_group(slide, "s10_budget_table")

    col_x = [MARGIN_X + 0.06, MARGIN_X + 3.66, MARGIN_X + 4.46]
    col_w = [3.54, 0.74, lw - 4.52]

    add_hairline(g_tbl, MARGIN_X, BODY_TOP, MARGIN_X + lw, BODY_TOP, color=INK_PRIMARY, width_pt=1.5)
    for cx, cw, htxt, aln in (
        (col_x[0], col_w[0], "COST CATEGORY / LINE ITEM", PP_ALIGN.LEFT),
        (col_x[1], col_w[1], "CLASS", PP_ALIGN.LEFT),
        (col_x[2], col_w[2], "AMOUNT", PP_ALIGN.RIGHT),
    ):
        add_textbox(
            g_tbl, cx, BODY_TOP + 0.08, cw, 0.26,
            [ParagraphSpec([TextRunSpec(htxt, 10.5, True, INK_MUTED, FONT_SANS)], space_after_pt=0, align=aln)],
            INK_MUTED, anchor=MSO_ANCHOR.MIDDLE,
        )
    add_hairline(g_tbl, MARGIN_X, BODY_TOP + 0.38, MARGIN_X + lw, BODY_TOP + 0.38, color=INK_PRIMARY, width_pt=0.75)

    budget_rows = [
        ("Product Development", "Subtotal", "HK$64,000", "sub"),
        ("  Connector & Evaluation Engineering (API/CSV + OCR)", "Dev", "HK$38,000", "item"),
        ("  Independent Security & Privacy Audit (RLS, keys)", "Dev", "HK$16,000", "item"),
        ("  Pilot Benchmark & Operator Training Guides", "Dev", "HK$10,000", "item"),
        ("Ongoing Operations & GTM", "Subtotal", "HK$36,000", "sub"),
        ("  Six-Month Cloud Hosting & AI Compute (HK$3k/mo)", "Ops", "HK$18,000", "item"),
        ("  Company Incorporation & Business Registration", "Ops", "HK$4,000", "item"),
        ("  SME Workflow Clinics & Early Pilot Outreach", "GTM", "HK$14,000", "item"),
        ("Total Seed Grant Budget", "100%", "HK$100,000", "total"),
    ]
    ry = BODY_TOP + 0.44
    for lbl, cls, amt, kind in budget_rows:
        rh = 0.56 if kind == "total" else (0.44 if kind == "sub" else 0.55)
        if kind == "total":
            add_hairline(g_tbl, MARGIN_X, ry, MARGIN_X + lw, ry, color=INK_PRIMARY, width_pt=0.75)
            add_flat_fill(g_tbl, MARGIN_X, ry + 0.02, lw, rh - 0.04, fill=LIMESTONE)
        is_b = kind in ("sub", "total")
        lcol = COBALT if kind == "total" else (INK_PRIMARY if is_b else INK_BODY)
        sz = 12.4 if kind == "total" else (12.0 if kind == "sub" else 11.2)

        add_textbox(
            g_tbl, col_x[0], ry + 0.03, col_w[0], rh - 0.06,
            [ParagraphSpec([TextRunSpec(lbl, sz, is_b, INK_PRIMARY if kind == "total" else lcol, FONT_SANS)], space_after_pt=0, line_spacing=1.12)],
            INK_BODY, anchor=MSO_ANCHOR.MIDDLE,
        )
        add_textbox(
            g_tbl, col_x[1], ry + 0.03, col_w[1], rh - 0.06,
            [ParagraphSpec([TextRunSpec(cls, 10.6, is_b, INK_MUTED if kind != "total" else INK_PRIMARY, FONT_SANS)], space_after_pt=0)],
            INK_MUTED, anchor=MSO_ANCHOR.MIDDLE,
        )
        add_textbox(
            g_tbl, col_x[2], ry + 0.03, col_w[2], rh - 0.06,
            [ParagraphSpec([TextRunSpec(amt, sz + 0.4 if kind == "total" else sz, True if is_b else False, lcol, FONT_SANS)], space_after_pt=0, align=PP_ALIGN.RIGHT)],
            INK_PRIMARY, anchor=MSO_ANCHOR.MIDDLE,
        )
        ry += rh
        if kind != "total":
            add_hairline(g_tbl, MARGIN_X, ry - 0.01, MARGIN_X + lw, ry - 0.01, color=HAIRLINE, width_pt=0.5)

    add_hairline(g_tbl, MARGIN_X, ry, MARGIN_X + lw, ry, color=INK_PRIMARY, width_pt=1.5)

    # Right Zone: Unboxed Monochrome Chart + In-Kind Viability Note
    rx = 6.62
    rw = MARGIN_X + CONTENT_W - rx  # 6.113 in
    g_right = start_group(slide, "s10_chart_viability")
    add_image_fit(
        ctx, 10, g_right, ASSETS_DIR / "chart_budget_tranches.png",
        rx, BODY_TOP, rw, 4.30, align_x="center", align_y="top", name="s10_chart_img",
    )
    add_hairline(g_right, rx, 5.96, rx + rw, 5.96, color=HAIRLINE, width_pt=0.5)
    add_textbox(
        g_right, rx, 6.04, rw, 0.86,
        [ParagraphSpec([
            TextRunSpec("IN-KIND & CASH VIABILITY: ", 10.6, True, COBALT, FONT_SANS),
            TextRunSpec(
                "Team members draw HK$0 in salary from the HK$100k grant, contributing 100% of labor in kind. Month-3 pilot fees (HK$15k–39k) and HK$4k/month subscriptions bridge working capital between tranches.",
                11.8, False, INK_BODY, FONT_SANS,
            ),
        ], space_after_pt=0, line_spacing=1.18)],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )

    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=[g_tbl.shape_id, g_right.shape_id])


def build_slide_11_social_responsibility(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 11,
        "11  /  SOCIAL RESPONSIBILITY",
        "Theodic elevates Hong Kong clerical roles, narrows the SME digital divide, and advances paperless operations",
        "11",
    )

    pillars = [
        (
            "–62.5%",
            "Upskilling Local Clerks",
            "Cuts repetitive document entry from 8 to 3 minutes while keeping final approval in human hands—freeing staff for customer service and exception review.",
            INK_PRIMARY,
        ),
        (
            "3 Languages",
            "Inclusive Trilingual AI",
            "Native Traditional Chinese, Simplified Chinese, and English interfaces let mid-career staff and family-run SMEs adopt safe AI without an internal IT team.",
            COBALT,
        ),
        (
            "Paperless",
            "Paperless & Private Workflows",
            "Replaces multi-copy printed orders, faxes, and physical filing cabinets with clean digital records—cutting office paper waste and protecting client data.",
            INK_PRIMARY,
        ),
    ]

    pw = 3.74
    pgap = (CONTENT_W - 3 * pw) / 2.0  # 0.4565 in -> v1 at 4.56825, v2 at 8.76475
    py = 1.72
    gids: list[int] = []

    for i, (stat, subhdr, body, scol) in enumerate(pillars):
        px = MARGIN_X + i * (pw + pgap)
        grp = start_group(slide, f"s11_col_{i+1}")
        add_hairline(grp, px, py, px + 0.85, py, color=scol, width_pt=1.5)
        add_textbox(
            grp, px, 1.84, pw, 0.64,
            [ParagraphSpec([TextRunSpec(stat, 34.0, True, scol, FONT_SERIF)], space_after_pt=0, line_spacing=1.0)],
            scol, anchor=MSO_ANCHOR.MIDDLE,
        )
        add_textbox(
            grp, px, 2.54, pw, 0.34,
            [ParagraphSpec([TextRunSpec(subhdr, 14.2, True, INK_PRIMARY, FONT_SANS)], space_after_pt=0, line_spacing=1.15)],
            INK_PRIMARY, anchor=MSO_ANCHOR.TOP,
        )
        add_hairline(grp, px, 2.94, px + pw, 2.94, color=HAIRLINE, width_pt=0.5)
        add_textbox(
            grp, px, 3.08, pw, 1.34,
            [ParagraphSpec([TextRunSpec(body, 13.0, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.28)],
            INK_BODY, anchor=MSO_ANCHOR.TOP,
        )
        if i < 2:
            vx = px + pw + pgap / 2.0
            add_hairline(grp, vx, 1.76, vx, 4.38, color=HAIRLINE, width_pt=0.5)
        gids.append(grp.shape_id)

    # Bottom Tier: Warm #F1ECE4 Limestone Ecosystem Commitments Band
    g_band = start_group(slide, "s11_commitments_band")
    add_flat_fill(g_band, MARGIN_X, 4.64, CONTENT_W, 2.14, fill=LIMESTONE, name="s11_limestone_band")

    add_textbox(
        g_band, 0.88, 4.86, 3.46, 1.78,
        [
            ParagraphSpec([TextRunSpec("ECOSYSTEM COMMITMENTS", 10.6, True, COBALT, FONT_SANS)], space_after_pt=6),
            ParagraphSpec([TextRunSpec("Concrete public value across Months 1–6", 15.6, True, INK_PRIMARY, FONT_SERIF)], space_after_pt=8, line_spacing=1.20),
            ParagraphSpec([TextRunSpec("Shared openly alongside Hong Kong SME pilots and university partners.", 11.8, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.24),
        ],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )

    grid_vx = MARGIN_X + pw + pgap / 2.0  # 4.56825 in (locked to top Col 1/2 divider)
    add_hairline(g_band, grid_vx, 4.86, grid_vx, 6.56, color=HAIRLINE, width_pt=0.5)

    commitments = [
        (4.84, "01  SME Clinics", INK_PRIMARY, "Free workflow clinics and trilingual operator guides for local SME clerical teams."),
        (5.44, "02  Open Toolkit", COBALT, "Free public AI audit checker and anonymized bilingual business document dataset."),
        (6.04, "03  Human Sign-Off", INK_PRIMARY, "100% human approval before any accounting or ERP draft—zero silent automation."),
    ]
    for idx, (ry, lbl, lcol, desc) in enumerate(commitments):
        add_textbox(
            g_band, 4.84, ry, 2.18, 0.54,
            [ParagraphSpec([TextRunSpec(lbl, 12.2, True, lcol, FONT_SANS)], space_after_pt=0)],
            lcol, anchor=MSO_ANCHOR.MIDDLE,
        )
        add_textbox(
            g_band, 7.12, ry, 5.34, 0.54,
            [ParagraphSpec([TextRunSpec(desc, 12.0, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.18)],
            INK_BODY, anchor=MSO_ANCHOR.MIDDLE,
        )
        if idx < 2:
            rule_y = ry + 0.57
            add_hairline(g_band, 4.84, rule_y, 12.46, rule_y, color=HAIRLINE, width_pt=0.5)

    gids.append(g_band.shape_id)
    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=gids)


def build_slide_12_fundraising(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 12,
        "12  /  FUNDRAISING & GRANT STATUS",
        "Theodic holds HK$0 in prior or overlapping public subsidies, ensuring clean No Double Subsidies compliance",
        "12",
    )

    g_tbl = start_group(slide, "s12_disclosure_table")
    ty = 2.00
    col_x = [MARGIN_X, MARGIN_X + 3.00, MARGIN_X + 5.95]
    col_w = [2.85, 2.75, CONTENT_W - 5.95]

    add_hairline(g_tbl, MARGIN_X, ty, MARGIN_X + CONTENT_W, ty, color=INK_PRIMARY, width_pt=1.5)
    for cx, cw, htxt in zip(col_x, col_w, ("DISCLOSURE WINDOW", "FUNDING / GRANT STATUS", "SCOPE & COMPLIANCE NOTES")):
        add_textbox(
            g_tbl, cx, ty + 0.10, cw, 0.30,
            [ParagraphSpec([TextRunSpec(htxt, 10.6, True, INK_MUTED, FONT_SANS)], space_after_pt=0)],
            INK_MUTED, anchor=MSO_ANCHOR.MIDDLE,
        )
    add_hairline(g_tbl, MARGIN_X, ty + 0.48, MARGIN_X + CONTENT_W, ty + 0.48, color=INK_PRIMARY, width_pt=0.75)

    rows = [
        ("Past 18 Months\nPre-Submission", "None / HK$0", "Zero equity, angel capital, or public grants received. The 36-module codebase and Hong Kong cloud demo were funded entirely by the four HKUST members.", False),
        ("Current Application\nActive Track", "Seed Grant · HK$100,000", "Sole active grant application for Theodic, complying fully with No Double Subsidies rules with zero concurrent public seed applications.", True),
        ("Next 18 Months\nPost-Grant Window", "None During Grant Window", "HK$0 concurrent grants or equity committed during Months 1–6. Planned follow-on growth relies on organic customer revenue and sequential incubation.", False),
    ]
    ry = ty + 0.56
    rh = 1.28
    for idx, (win, stat, notes, focus) in enumerate(rows):
        add_textbox(
            g_tbl, col_x[0], ry + 0.10, col_w[0], rh - 0.20,
            [ParagraphSpec([TextRunSpec(win, 13.2, True, INK_PRIMARY, FONT_SANS)], space_after_pt=0, line_spacing=1.22)],
            INK_PRIMARY, anchor=MSO_ANCHOR.MIDDLE,
        )
        add_textbox(
            g_tbl, col_x[1], ry + 0.10, col_w[1], rh - 0.20,
            [ParagraphSpec([TextRunSpec(stat, 13.8, True, COBALT if focus else INK_PRIMARY, FONT_SANS)], space_after_pt=0, line_spacing=1.20)],
            INK_PRIMARY, anchor=MSO_ANCHOR.MIDDLE,
        )
        add_textbox(
            g_tbl, col_x[2], ry + 0.10, col_w[2], rh - 0.20,
            [ParagraphSpec([TextRunSpec(notes, 13.0, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.28)],
            INK_BODY, anchor=MSO_ANCHOR.MIDDLE,
        )
        ry += rh
        if idx < len(rows) - 1:
            add_hairline(g_tbl, MARGIN_X, ry - 0.02, MARGIN_X + CONTENT_W, ry - 0.02, color=HAIRLINE, width_pt=0.5)

    add_hairline(g_tbl, MARGIN_X, ry, MARGIN_X + CONTENT_W, ry, color=INK_PRIMARY, width_pt=1.5)

    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=[g_tbl.shape_id])


def build_slide_13_appendix_a(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 13,
        "APPENDIX A  /  LIVE MVP REVIEWER SANDBOX  ·  CRYPTOGRAPHIC ACCESS GATE",
        "Reviewers can test the live trilingual MVP in 90 seconds behind a four-layer Cloudflare Edge Reviewer Gate",
        "Appendix A  ·  13",
    )

    frag_url = ctx.reviewer_pass["reviewer_fragment_url"]
    passcode = ctx.reviewer_pass["reviewer_passcode"]
    expires_at = ctx.reviewer_pass.get("expires_at", "2027-03-31T23:59:59Z")[:10]

    # Widened left column (5.55") so single-line Menlo URL sits >= 9.0pt cleanly
    lw = 5.55
    g_left = start_group(slide, "s13_left_access")

    add_image_fit(
        ctx, 13, g_left, ASSETS_DIR / "qr_mvp_reviewer_pass.png",
        MARGIN_X, BODY_TOP, 1.54, 1.54, align_x="left", align_y="top", name="s13_qr",
    )
    add_textbox(
        g_left, MARGIN_X + 1.72, BODY_TOP + 0.02, lw - 1.72, 1.52,
        [
            ParagraphSpec([TextRunSpec("LIVE REVIEWER PASS", 10.6, True, INK_MUTED, FONT_SANS)], space_after_pt=4),
            ParagraphSpec([TextRunSpec("Passcode", 10.6, False, INK_MUTED, FONT_SANS)], space_after_pt=2),
            ParagraphSpec([TextRunSpec(passcode, 11.8, True, COBALT, FONT_MONO)], space_after_pt=6),
            ParagraphSpec([TextRunSpec(f"Valid through {expires_at} · Auto-set to English", 11.0, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.20),
        ],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )

    url_pt = 9.4
    while url_pt > 9.0 and _measure_text_pt(frag_url, FONT_MONO, True, url_pt) > (lw * 72.0 - 4.0):
        url_pt = round(url_pt - 0.1, 1)
    add_textbox(
        g_left, MARGIN_X, 3.20, lw, 0.34,
        [ParagraphSpec([TextRunSpec(frag_url, url_pt, True, COBALT, FONT_MONO, hyperlink=frag_url)], space_after_pt=0)],
        COBALT, anchor=MSO_ANCHOR.MIDDLE, name="s13_clickable_url",
    )

    add_hairline(g_left, MARGIN_X, 3.58, MARGIN_X + lw, 3.58, color=HAIRLINE, width_pt=0.5)
    add_textbox(
        g_left, MARGIN_X, 3.66, lw, 1.66,
        [
            ParagraphSpec([TextRunSpec("90-SECOND REVIEWER WALKTHROUGH", 10.6, True, INK_MUTED, FONT_SANS)], space_after_pt=4),
            ParagraphSpec([TextRunSpec("1. Scan the QR code or open the link to pass the Edge Gate and load the English login screen.", 10.8, False, INK_BODY, FONT_SANS)], space_after_pt=2.5, line_spacing=1.16),
            ParagraphSpec([TextRunSpec("2. Sign in as Operator (Mingzhe Lin), open the Quantity Conflict case, and inspect the OCR discrepancy.", 10.8, False, INK_BODY, FONT_SANS)], space_after_pt=2.5, line_spacing=1.16),
            ParagraphSpec([TextRunSpec("3. Switch to Manager (Zhiyuan Chen) to approve the locked payload hash and verify the ERP receipt.", 10.8, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.16),
        ],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )

    add_hairline(g_left, MARGIN_X, 5.36, MARGIN_X + lw, 5.36, color=HAIRLINE, width_pt=0.5)
    add_textbox(
        g_left, MARGIN_X, 5.42, lw, 1.54,
        [
            ParagraphSpec([TextRunSpec("4-LAYER EDGE REVIEWER GATE SECURITY", 10.6, True, INK_MUTED, FONT_SANS)], space_after_pt=4),
            ParagraphSpec([TextRunSpec("L1  WebCrypto check blocks unauthenticated origin traffic with noindex headers.", 10.6, False, INK_BODY, FONT_SANS)], space_after_pt=2.0, line_spacing=1.14),
            ParagraphSpec([TextRunSpec("L2  Brute-force lock blocks 5 fails per 10 minutes (429) and caps payloads at 8 MiB.", 10.6, False, INK_BODY, FONT_SANS)], space_after_pt=2.0, line_spacing=1.14),
            ParagraphSpec([TextRunSpec("L3  Rate quotas cap live model turns at 8 per minute and 40 per hour per IP.", 10.6, False, INK_BODY, FONT_SANS)], space_after_pt=2.0, line_spacing=1.14),
            ParagraphSpec([TextRunSpec("L4  Reviewer scope blocks administrative reset, pause, and suspend routes (403).", 10.6, False, INK_BODY, FONT_SANS)], space_after_pt=0, line_spacing=1.14),
        ],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )

    # Right Zone: Enlarged Tight Receipt Stepper Zoom
    rx = MARGIN_X + lw + 0.34
    rw = MARGIN_X + CONTENT_W - rx  # ~6.243 in
    g_right = start_group(slide, "s13_receipt_zoom")
    add_image_fit(
        ctx, 13, g_right, ASSETS_DIR / "ui_receipt_stepper_zoom.png",
        rx, BODY_TOP, rw, 4.18, align_x="center", align_y="top", name="s13_ui_img",
    )
    add_textbox(
        g_right, rx, 5.74, rw, 0.72,
        [ParagraphSpec([TextRunSpec(
            "Live five-step verified proposal stepper, field diff, and reconciled ERP receipt running on Hong Kong cloud behind Cloudflare Workers VPC.",
            11.0, False, INK_MUTED, FONT_SANS,
        )], space_after_pt=0, line_spacing=1.20)],
        INK_MUTED, anchor=MSO_ANCHOR.TOP,
    )

    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=[g_left.shape_id, g_right.shape_id])


def build_slide_14_appendix_b(ctx: DeckContext) -> None:
    slide = init_editorial_slide(
        ctx, 14,
        "APPENDIX B  /  DATA SOURCES, VERIFICATION INDEX & COMPLIANCE",
        "Primary Hong Kong government statistics, vendor filings, modeled assumptions, and repository verification",
        "Appendix B  ·  14",
    )

    left_items = [
        ("[1] ", "HK TID SUCCESS (Jun 2026): ", "357,965 HK SMEs (>98% of firms); 92,307 trade & logistics (83,759 import/export & wholesale + 8,548 transport); services are 93.6% of GDP."),
        ("[2] ", "C&SD 2024 ASEA (Dec 2025): ", "8,202 mid-sized 10–49 staff B2B units (6,680 import/export, 946 wholesale, 576 transport support); 12,295 HSIC 46 units (HK$275.2B receipts)."),
        ("[3] ", "C&SD 2025 IT Survey (Feb 2026, n=320,710): ", "45.5% Accounting vs. 26.7% Supply Chain vs. 6.0% ERP (94.0% operate without full ERP; 4.2% cloud ERP)."),
        ("[4] ", "C&SD Jun 2026 Pay & 2025 AEHS: ", "Cross-sector clerical median HK$72.4/hr; monthly pay HK$18,782 Office, HK$18,433 Warehouse, HK$20,312 Shipping, HK$21,226 Accounting."),
        ("[5] ", "HKPC Q1 2026 SME Index (n=819): ", "55% use or plan AI within 12 months; 32% of existing AI users pay for AI tools (distinct denominator)."),
        ("[6] ", "HK Field Evidence (Oct 2026): ", "Multi-channel intake documented at A.S. Stationery, Young Vision, Wah Chit, and Li Tung; ERP clerical job ads."),
        ("[7] ", "HK & Regional Vendors (Oct 2026): ", "PrimeFlow (HK$5k/mo, 12-mo), Zoo AI (HK$28k+), AirPurchase (HK$241–318/mo F&B AP), Ricoh InnoAI, FarSight, iGears."),
    ]
    right_items = [
        ("[8] ", "Odoo 20 Public Docs (Sep 2026): ", "Native PDF/EDI AI actions; external JSON-2 API requires Custom plan; three-way mismatch warnings allow draft edits."),
        ("[9] ", "Enterprise OCR Docs (Oct 2026): ", "Rossum Aurora 1.5 lacks Traditional Chinese pre-trained & handwriting models; Conexiom and Esker target large enterprises."),
        ("[10] ", "Public Grant & Statutory Compliance: ", "Hong Kong e-incorporation (HK$1,545) + 1-yr BR (HK$2,350) = HK$3,895 (budgeted HK$4,000); 10%/45%/45% tranches; zero overlapping subsidies."),
        ("[11] ", "Modeled Financial Scenarios: ", "Assumes 1,800 cases/mo at HK$130/hr overtime: 8 to 3 min blended saves 5 min/case (+HK$40,390 Yr-1 cash, 10-mo payback); 62.5% margin; 36-mo ARR HK$149k–1,166k."),
        ("[12] ", "Verified Repository Footprint: ", "36 Python modules (6,105 LOC), 23 forced-RLS tables, 119 TypeScript UI files (52,983 LOC), 67 unit tests, 26/26 E2E, 18/18 Edge Gate tests."),
        ("[13] ", "Privacy & Cryptographic Standards: ", "HK PCPD AI Model Data Protection Framework, OWASP LLM01:2025 defenses, RFC 8032 Ed25519 signatures, and AES-256-GCM ledgers."),
    ]

    lw = 5.85
    rx = MARGIN_X + lw + 0.433
    rw = MARGIN_X + CONTENT_W - rx
    refs_top = 1.54
    refs_h = 4.32
    add_hairline(slide, MARGIN_X + lw + 0.216, refs_top + 0.04, MARGIN_X + lw + 0.216, refs_top + refs_h - 0.04, color=HAIRLINE, width_pt=0.5, name="s14_mid_rule")

    g_left = start_group(slide, "s14_left_refs")
    add_textbox(
        g_left, MARGIN_X, refs_top, lw, refs_h,
        [
            ParagraphSpec([
                TextRunSpec(num, 10.5, True, COBALT, FONT_SANS),
                TextRunSpec(bold_lbl, 10.5, True, INK_PRIMARY, FONT_SANS),
                TextRunSpec(desc, 10.5, False, INK_BODY, FONT_SANS),
            ], space_after_pt=3.2, line_spacing=1.15)
            for num, bold_lbl, desc in left_items
        ],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )

    g_right = start_group(slide, "s14_right_refs")
    add_textbox(
        g_right, rx, refs_top, rw, refs_h,
        [
            ParagraphSpec([
                TextRunSpec(num, 10.5, True, COBALT, FONT_SANS),
                TextRunSpec(bold_lbl, 10.5, True, INK_PRIMARY, FONT_SANS),
                TextRunSpec(desc, 10.5, False, INK_BODY, FONT_SANS),
            ], space_after_pt=3.6, line_spacing=1.15)
            for num, bold_lbl, desc in right_items
        ],
        INK_BODY, anchor=MSO_ANCHOR.TOP,
    )

    # Bottom Flat #F1ECE4 Limestone Declaration Strip
    g_decl = start_group(slide, "s14_compliance_declaration")
    add_flat_fill(g_decl, MARGIN_X, 5.96, CONTENT_W, 0.90, fill=LIMESTONE, name="s14_limestone_fill")
    add_textbox(
        g_decl, MARGIN_X + 0.24, 6.02, CONTENT_W - 0.48, 0.78,
        [
            ParagraphSpec([TextRunSpec("PROJECT MEMBERS' COMPLIANCE DECLARATION", 10.6, True, COBALT, FONT_SANS)], space_after_pt=3),
            ParagraphSpec([TextRunSpec(
                "All four HKUST project members warrant full originality, sole project IP ownership, and zero concurrent public subsidy overlap across the 18-month disclosure window.",
                12.2, False, INK_PRIMARY, FONT_SANS,
            )], space_after_pt=0, line_spacing=1.20),
        ],
        INK_PRIMARY, anchor=MSO_ANCHOR.MIDDLE,
    )

    apply_transition_and_timing(slide, mode="morph", dur_ms=550, animate_shape_ids=[g_left.shape_id, g_right.shape_id, g_decl.shape_id])


def build_all_slides(ctx: DeckContext) -> None:
    builders = (
        build_slide_01_cover,
        build_slide_02_exec_summary,
        build_slide_03_pain_market,
        build_slide_04_solution_mvp,
        build_slide_05_creativity_innovation,
        build_slide_06_business_model,
        build_slide_07_competitive,
        build_slide_08_team,
        build_slide_09_milestones,
        build_slide_10_budget,
        build_slide_11_social_responsibility,
        build_slide_12_fundraising,
        build_slide_13_appendix_a,
        build_slide_14_appendix_b,
    )
    for fn in builders:
        fn(ctx)


# ---------------------------------------------------------------------------
# Programmatic QA & OpenXML Validation (Strict V3 Gates)
# ---------------------------------------------------------------------------

def _iter_leaf_shapes(shapes) -> Iterable:
    for shp in shapes:
        yield shp
        if hasattr(shp, "shapes"):
            yield from _iter_leaf_shapes(shp.shapes)


def _estimate_text_height_pt(tf, inner_w_pt: float) -> tuple[float, list[str]]:
    """Estimate wrapped paragraph height in points using Pillow TTF metrics."""
    total_h = 0.0
    warnings: list[str] = []
    if inner_w_pt <= 1.0:
        return 0.0, [f"Degenerate text frame width: {inner_w_pt:.1f}pt"]

    for p in tf.paragraphs:
        runs = list(p.runs)
        if not runs:
            sz = float(p.font.size.pt) if p.font.size else 10.0
            total_h += sz * (p.line_spacing or 1.2)
            continue

        max_sz = max(float(r.font.size.pt) if r.font.size else 10.0 for r in runs)
        line_mult = float(p.line_spacing) if isinstance(p.line_spacing, (int, float)) else 1.26
        sp_before = float(p.space_before.pt) if p.space_before else 0.0
        sp_after = float(p.space_after.pt) if p.space_after else 0.0

        lines = 1
        cur_w = 0.0
        for r in runs:
            r_sz = float(r.font.size.pt) if r.font.size else max_sz
            r_bold = bool(r.font.bold)
            r_font = r.font.name or FONT_SANS
            parts = r.text.split("\n")
            for p_idx, part in enumerate(parts):
                if p_idx > 0:
                    lines += 1
                    cur_w = 0.0
                tokens = re.findall(r"\S+\s*|\s+", part)
                for tok in tokens:
                    tok_w = _measure_text_pt(tok, r_font, r_bold, r_sz)
                    if tok.strip() and tok_w > inner_w_pt * 1.04 and len(tok.strip()) > 12:
                        extra_lines = max(1, math.ceil(tok_w / inner_w_pt) - 1)
                        if cur_w > 0:
                            lines += 1
                        lines += extra_lines
                        cur_w = tok_w % inner_w_pt
                        continue
                    if cur_w > 0 and cur_w + tok_w > inner_w_pt:
                        lines += 1
                        cur_w = _measure_text_pt(tok.lstrip(), r_font, r_bold, r_sz)
                    else:
                        cur_w += tok_w

        total_h += sp_before + lines * max_sz * line_mult + sp_after

    return total_h, warnings


def run_qa_checks(
    ctx: DeckContext,
    pptx_path: Path,
    budget_line_items: Sequence[int],
    reviewer_pass: dict[str, str],
) -> None:
    errors: list[str] = []
    prs = ctx.prs

    if len(prs.slides) != 14:
        errors.append(f"Expected 14 slides (12 Core + Appendix A + Appendix B), got {len(prs.slides)}")

    all_texts: list[str] = []
    for s_idx, slide in enumerate(prs.slides, start=1):
        for shp in _iter_leaf_shapes(slide.shapes):
            x_in = shp.left / 914400.0
            y_in = shp.top / 914400.0
            w_in = shp.width / 914400.0
            h_in = shp.height / 914400.0
            if x_in < -1e-4 or y_in < -1e-4 or (x_in + w_in) > MAX_SHAPE_X_IN or (y_in + h_in) > MAX_SHAPE_Y_IN:
                errors.append(
                    f"Slide {s_idx} shape '{shp.name}' out of bounds: "
                    f"[{x_in:.3f}, {y_in:.3f}, {x_in+w_in:.3f}, {y_in+h_in:.3f}]"
                )

            try:
                if shp.auto_shape_type == MSO_SHAPE.ROUNDED_RECTANGLE:
                    errors.append(f"Slide {s_idx} forbidden ROUNDED_RECTANGLE shape '{shp.name}'")
            except (AttributeError, ValueError, TypeError):
                pass

            if shp.has_text_frame:
                tf = shp.text_frame
                text = tf.text.strip()
                if text:
                    all_texts.append(text)
                    low = text.lower()
                    for tok in FORBIDDEN_V3_SUBSTRINGS:
                        if tok in low:
                            errors.append(f"Slide {s_idx} forbidden token {tok!r} in '{shp.name}': {text[:80]}")
                    if "founder" in low and not (
                        s_idx == 8 and (shp.name or "").startswith(("s8_top_", "s8_bot_"))
                    ):
                        errors.append(f"Slide {s_idx} forbidden singular 'founder' outside Slide 8 bio cards in '{shp.name}': {text[:80]}")
                    if re.search(r"\bcip\b", low):
                        errors.append(f"Slide {s_idx} forbidden grant acronym 'cip' in '{shp.name}': {text[:80]}")
                    for op in FORBIDDEN_ASCII_OPS:
                        if op in text:
                            errors.append(f"Slide {s_idx} forbidden operator {op!r} in '{shp.name}': {text[:80]}")
                    if s_idx <= 12:
                        if "sources:" in low or "code refs:" in low:
                            errors.append(f"Slide {s_idx} forbidden source/code footer text on core slide: {text[:80]}")
                        # Prevent footnote bracket clutter [1]..[14] on Core Slides 01-12
                        if re.search(r"\[\d{1,2}(?:\s*[–,-]\s*\d{1,2})*\]", text):
                            errors.append(f"Slide {s_idx} inline citation bracket clutter on core slide: {text[:80]}")
                    for word in BANNED_AI_SLOP:
                        if re.search(rf"\b{re.escape(word)}\b", low):
                            errors.append(f"Slide {s_idx} banned AI-slop word '{word}' in '{shp.name}': {text[:80]}")

                    min_req_pt = 9.0 if shp.name == "s13_clickable_url" else 10.5
                    for p in tf.paragraphs:
                        for r in p.runs:
                            fname = r.font.name or ""
                            if s_idx != 13 and fname in (FONT_MONO, "Courier New", "Courier"):
                                errors.append(f"Slide {s_idx} forbidden monospace font {fname!r} in '{shp.name}': {r.text[:40]}")
                            if r.text.strip() and r.font.size is not None:
                                r_pt = float(r.font.size.pt)
                                if r_pt < min_req_pt - 1e-6:
                                    errors.append(
                                        f"Slide {s_idx} font size {r_pt:.1f}pt < {min_req_pt:.1f}pt min in '{shp.name}': {r.text[:40]!r}"
                                    )

                    if tf.word_wrap:
                        ml = (tf.margin_left / 914400.0 * 72.0) if tf.margin_left is not None else 0.0
                        mr = (tf.margin_right / 914400.0 * 72.0) if tf.margin_right is not None else 0.0
                        mt = (tf.margin_top / 914400.0 * 72.0) if tf.margin_top is not None else 0.0
                        mb = (tf.margin_bottom / 914400.0 * 72.0) if tf.margin_bottom is not None else 0.0
                        inner_w_pt = w_in * 72.0 - ml - mr
                        inner_h_pt = h_in * 72.0 - mt - mb
                        est_h_pt, wrap_warns = _estimate_text_height_pt(tf, inner_w_pt)
                        for wmsg in wrap_warns:
                            errors.append(f"Slide {s_idx} '{shp.name}': {wmsg}")
                        if est_h_pt > inner_h_pt * 0.98:
                            errors.append(
                                f"Slide {s_idx} '{shp.name}' text overflow: "
                                f"est={est_h_pt:.1f}pt > 98% avail={inner_h_pt * 0.98:.1f}pt ({text[:60]!r})"
                            )
                        if re.fullmatch(r"HK\$[\d,]+", text) and len(tf.paragraphs) == 1:
                            run0 = tf.paragraphs[0].runs[0]
                            r_sz = float(run0.font.size.pt) if run0.font.size else 11.0
                            tok_w = _measure_text_pt(text, run0.font.name or FONT_SANS, bool(run0.font.bold), r_sz)
                            if tok_w > inner_w_pt * 0.96:
                                errors.append(
                                    f"Slide {s_idx} currency cell '{text}' too tight ({tok_w:.1f}pt vs {inner_w_pt:.1f}pt)"
                                )

    full_deck_text = "\n".join(all_texts)
    low_all = full_deck_text.lower()
    for tok in FORBIDDEN_V3_SUBSTRINGS:
        if tok in low_all:
            errors.append(f"Forbidden token {tok!r} found in full_deck_text")
    if re.search(r"\bcip\b", low_all):
        errors.append("Forbidden 'cip' reference found in full_deck_text")
    if "theodic" not in low_all:
        errors.append("Missing 'Theodic' brand name in deck text")

    # Slide 12 must NOT hold Declaration (moved to Slide 14 Appendix B)
    s12_text = "\n".join(shp.text_frame.text for shp in _iter_leaf_shapes(prs.slides[11].shapes) if shp.has_text_frame)
    if "declaration" in s12_text.lower():
        errors.append("Slide 12 must not contain Compliance Declaration (belongs on Slide 14)")
    s14_text = "\n".join(shp.text_frame.text for shp in _iter_leaf_shapes(prs.slides[13].shapes) if shp.has_text_frame)
    if "PROJECT MEMBERS' COMPLIANCE DECLARATION" not in s14_text:
        errors.append("Slide 14 missing PROJECT MEMBERS' COMPLIANCE DECLARATION band")

    for rec in ctx.placed_images:
        src_ar = rec.src_w / rec.src_h
        dst_ar = rec.placed_w_in / rec.placed_h_in
        if abs(src_ar - dst_ar) / src_ar > 0.005:
            errors.append(
                f"Slide {rec.slide_num} image {rec.path.name} aspect ratio mismatch: "
                f"src={src_ar:.4f} vs dst={dst_ar:.4f}"
            )

    if sum(budget_line_items) != 100000:
        errors.append(f"Slide 10 budget sum is {sum(budget_line_items)}, expected 100000")

    s13 = prs.slides[12]
    s13_text = "\n".join(shp.text_frame.text for shp in _iter_leaf_shapes(s13.shapes) if shp.has_text_frame)
    exp_url = reviewer_pass.get("reviewer_fragment_url", "")
    exp_code = reviewer_pass.get("reviewer_passcode", "")
    if not exp_code.startswith("THEODIC-DEMO-"):
        errors.append(f"Reviewer passcode does not carry THEODIC-DEMO- prefix: {exp_code}")
    if not exp_url or exp_url not in s13_text:
        errors.append("Slide 13 missing exact reviewer_fragment_url")
    if not exp_code or exp_code not in s13_text:
        errors.append("Slide 13 missing exact reviewer_passcode")
    found_link = False
    for shp in _iter_leaf_shapes(s13.shapes):
        if shp.name == "s13_clickable_url":
            w_pt = shp.width / 914400.0 * 72.0
            run0 = shp.text_frame.paragraphs[0].runs[0]
            r_pt = float(run0.font.size.pt)
            if _measure_text_pt(run0.text, FONT_MONO, bool(run0.font.bold), r_pt) > w_pt:
                errors.append(f"Slide 13 URL width exceeds single line box ({w_pt:.1f}pt at {r_pt:.1f}pt)")
        if shp.has_text_frame:
            for p in shp.text_frame.paragraphs:
                for r in p.runs:
                    if r.hyperlink and r.hyperlink.address == exp_url:
                        found_link = True
    if not found_link:
        errors.append("Slide 13 missing clickable hyperlink matching reviewer_fragment_url")

    size_bytes = pptx_path.stat().st_size
    if size_bytes >= 10 * 1024 * 1024:
        errors.append(f"PPTX size {size_bytes} bytes exceeds 10 MB limit")

    with zipfile.ZipFile(pptx_path, "r") as zf:
        comment_parts = [n for n in zf.namelist() if "comment" in n.lower()]
        if comment_parts:
            errors.append(f"PPTX contains forbidden comment parts: {comment_parts}")
        for i in range(1, 15):
            sname = f"ppt/slides/slide{i}.xml"
            raw_xml = zf.read(sname)
            xml_low = raw_xml.decode("utf-8", errors="ignore").lower()
            for tok in FORBIDDEN_V3_SUBSTRINGS:
                if tok in xml_low:
                    errors.append(f"{sname} contains forbidden token {tok!r}")
            if i != 8 and "founder" in xml_low:
                errors.append(f"{sname} contains forbidden singular 'founder' outside Slide 8")
            if re.search(r"\bcip\b", xml_low):
                errors.append(f"{sname} contains forbidden 'cip' reference")
            if "→" in raw_xml.decode("utf-8", errors="ignore"):
                errors.append(f"{sname} contains forbidden arrow '→'")
            if b'prst="roundRect"' in raw_xml:
                errors.append(f"{sname} contains forbidden roundRect geometry")
            root = etree.fromstring(raw_xml)
            children = [etree.QName(c).localname for c in root]
            expected_order = ["cSld", "clrMapOvr", "AlternateContent", "transition", "timing", "extLst"]
            order_idx = [expected_order.index(tag) for tag in children if tag in expected_order]
            if order_idx != sorted(order_idx):
                errors.append(f"{sname} invalid <p:sld> child order: {children}")
            if "AlternateContent" not in children and "transition" not in children:
                errors.append(f"{sname} missing slide transition element")
            if "timing" not in children:
                errors.append(f"{sname} missing <p:timing> entrance cascade")

            ctn_ids = root.xpath(".//p:timing//p:cTn/@id", namespaces={"p": NS_P})
            if len(ctn_ids) != len(set(ctn_ids)):
                errors.append(f"{sname} duplicate <p:cTn id> values: {ctn_ids}")

            shape_ids = set(root.xpath(".//p:cSld//p:cNvPr/@id", namespaces={"p": NS_P}))
            tgt_ids = set(root.xpath(".//p:timing//p:spTgt/@spid", namespaces={"p": NS_P}))
            missing_tgts = tgt_ids - shape_ids
            if missing_tgts:
                errors.append(f"{sname} <p:timing> references missing spids: {missing_tgts}")

    if errors:
        raise RuntimeError("Deck QA checks failed:\n  - " + "\n  - ".join(errors))


def export_pdf_via_powerpoint(pptx_path: Path, pdf_path: Path, timeout_sec: int = 60) -> bool:
    app_path = Path("/Applications/Microsoft PowerPoint.app")
    if not app_path.exists():
        print("Microsoft PowerPoint.app not found; skipping PDF export.", file=sys.stderr)
        return False

    applescript = f'''
with timeout of {timeout_sec} seconds
    set inFile to POSIX file "{pptx_path}"
    set outPdf to "{pdf_path}"
    tell application "Microsoft PowerPoint"
        try
            repeat while (count of presentations) > 0
                close presentation 1 saving no
            end repeat
        end try
        open inFile
        delay 1.5
        set pres to active presentation
        save pres in (POSIX file outPdf) as save as PDF
        close pres saving no
    end tell
end timeout
'''
    proc = subprocess.run(
        ["osascript", "-e", applescript],
        capture_output=True,
        text=True,
        timeout=timeout_sec + 15,
        check=False,
    )
    if proc.returncode != 0:
        print(f"PowerPoint PDF export failed ({proc.returncode}): {proc.stderr.strip()}", file=sys.stderr)
        return False
    return pdf_path.exists() and pdf_path.stat().st_size > 0


def load_reviewer_pass() -> dict[str, str]:
    if not REVIEWER_PASS_PATH.exists():
        raise FileNotFoundError(f"Reviewer pass file not found: {REVIEWER_PASS_PATH}")
    data = json.loads(REVIEWER_PASS_PATH.read_text(encoding="utf-8"))
    for key in ("reviewer_fragment_url", "reviewer_passcode"):
        if not data.get(key):
            raise ValueError(f"Missing required field {key!r} in {REVIEWER_PASS_PATH}")
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description="Build Theodic V3 Swiss Editorial 14-slide pitch deck.")
    parser.add_argument("--out", type=Path, default=DEFAULT_PPTX_PATH, help="Output .pptx path")
    parser.add_argument("--pdf", type=Path, default=DEFAULT_PDF_PATH, help="Output .pdf path")
    parser.add_argument("--skip-pdf", action="store_true", help="Skip PowerPoint AppleScript PDF export")
    args = parser.parse_args()

    reviewer_pass = load_reviewer_pass()
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W_EMU)
    prs.slide_height = Emu(SLIDE_H_EMU)
    set_theme_hyperlink_color(prs, "1B4F9C")

    ctx = DeckContext(prs=prs, reviewer_pass=reviewer_pass)
    build_all_slides(ctx)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(args.out))

    budget_items = [38000, 16000, 10000, 18000, 4000, 14000]
    run_qa_checks(ctx, args.out, budget_items, reviewer_pass)
    print(f"PPTX verified: {args.out} ({args.out.stat().st_size / 1024:.1f} KB, 14 slides)")

    if not args.skip_pdf:
        if export_pdf_via_powerpoint(args.out, args.pdf):
            print(f"PDF exported: {args.pdf} ({args.pdf.stat().st_size / 1024:.1f} KB)")
        else:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
