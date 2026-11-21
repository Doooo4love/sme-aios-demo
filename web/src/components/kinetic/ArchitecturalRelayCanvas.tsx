"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { useTheme, type Theme } from "@/lib/theme-context";

interface StratumMeta {
  index: number;
  id: "floor" | "gate" | "workbench" | "ledger";
  code: string;
  tabLabel: string;
  title: string;
  caption: string;
  detail: string;
}

interface SlabDef {
  stratumIdx: number;
  slabKey: "gate-left" | "gate-right" | "workbench" | "ledger";
  x: number;
  y: number;
  z: number;
  bw: number;
  bd: number;
  bh: number;
  accentKind: "cobalt" | "emerald";
  title: string;
  shortTitle: string;
  sub: string;
  core?: boolean;
  canopy?: boolean;
}

interface ConduitDef {
  from: [number, number, number];
  to: [number, number, number];
  strata: [number, number];
  lbl: string;
  side: "l" | "r";
  accentKind: "cobalt" | "emerald";
  ph: number;
}

interface CanvasPalette {
  cobaltRgb: string;
  emeraldRgb: string;
  slateRgb: string;
  cobaltHex: string;
  emeraldHex: string;
  auraCore: string;
  auraMid: string;
  auraOuter: string;
  siteMarkHot: string;
  siteMarkRest: string;
  dropShadowHot: string;
  dropShadowRest: string;
  sideCore: string;
  sideStd: string;
  frontCoreTop: string;
  frontCoreBot: string;
  frontCanopyTop: string;
  frontCanopyBot: string;
  frontStdTop: string;
  frontStdBot: string;
  topCore0: string;
  topCore1: string;
  topCore2: string;
  topCanopy0: string;
  topCanopy1: string;
  topCanopy2: string;
  topStd0: string;
  topStd1: string;
  rimRest: string;
  bottomHairline: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textSubtleAccent: string;
  conduitLabel: string;
  ledgerRowRest: string;
  ledgerColRest: string;
  ledgerDotRest: string;
  lockDot: string;
}

const LIGHT_PALETTE: CanvasPalette = {
  cobaltRgb: "22,104,227",
  emeraldRgb: "18,122,70",
  slateRgb: "82,91,108",
  cobaltHex: "#1668E3",
  emeraldHex: "#127A46",
  auraCore: "rgba(22, 104, 227, 0.07)",
  auraMid: "rgba(18, 122, 70, 0.025)",
  auraOuter: "rgba(245, 246, 248, 0)",
  siteMarkHot: "rgba(17,19,24,0.94)",
  siteMarkRest: "rgba(60,66,80,0.82)",
  dropShadowHot: "rgba(17, 19, 24, 0.08)",
  dropShadowRest: "rgba(17, 19, 24, 0.045)",
  sideCore: "rgba(219, 232, 252, 0.90)",
  sideStd: "rgba(226, 232, 240, 0.85)",
  frontCoreTop: "rgba(232, 241, 255, 0.96)",
  frontCoreBot: "rgba(205, 223, 250, 0.96)",
  frontCanopyTop: "rgba(235, 249, 242, 0.96)",
  frontCanopyBot: "rgba(211, 238, 224, 0.96)",
  frontStdTop: "rgba(244, 246, 250, 0.96)",
  frontStdBot: "rgba(226, 231, 239, 0.96)",
  topCore0: "rgba(255, 255, 255, 0.98)",
  topCore1: "rgba(244, 248, 255, 0.95)",
  topCore2: "rgba(234, 242, 254, 0.94)",
  topCanopy0: "rgba(255, 255, 255, 0.98)",
  topCanopy1: "rgba(244, 251, 247, 0.95)",
  topCanopy2: "rgba(232, 247, 239, 0.94)",
  topStd0: "rgba(255, 255, 255, 0.96)",
  topStd1: "rgba(245, 247, 251, 0.94)",
  rimRest: "rgba(17, 19, 24, 0.12)",
  bottomHairline: "rgba(17, 19, 24, 0.10)",
  textPrimary: "#111318",
  textSecondary: "#3C4250",
  textMuted: "rgba(60, 66, 80, 0.85)",
  textSubtleAccent: "rgba(22, 104, 227, 0.88)",
  conduitLabel: "rgba(60, 66, 80, 0.92)",
  ledgerRowRest: "rgba(82, 91, 108, 0.34)",
  ledgerColRest: "rgba(82, 91, 108, 0.24)",
  ledgerDotRest: "rgba(82, 91, 108, 0.45)",
  lockDot: "rgba(60, 66, 80, 0.74)",
};

// Matte Obsidian Glass Slabs (#121620 / #192030) + Refined Cobalt #409CFF & Emerald #34D399 (zero neon)
const DARK_PALETTE: CanvasPalette = {
  cobaltRgb: "64,156,255",
  emeraldRgb: "52,211,153",
  slateRgb: "148,163,184",
  cobaltHex: "#409CFF",
  emeraldHex: "#34D399",
  auraCore: "rgba(64, 156, 255, 0.11)",
  auraMid: "rgba(52, 211, 153, 0.04)",
  auraOuter: "rgba(12, 14, 19, 0)",
  siteMarkHot: "rgba(242, 244, 248, 0.95)",
  siteMarkRest: "rgba(180, 188, 203, 0.82)",
  dropShadowHot: "rgba(0, 0, 0, 0.56)",
  dropShadowRest: "rgba(0, 0, 0, 0.38)",
  sideCore: "rgba(24, 34, 54, 0.96)",
  sideStd: "rgba(20, 25, 36, 0.95)",
  frontCoreTop: "rgba(26, 38, 60, 0.98)",
  frontCoreBot: "rgba(18, 26, 42, 0.98)",
  frontCanopyTop: "rgba(20, 42, 36, 0.98)",
  frontCanopyBot: "rgba(14, 30, 26, 0.98)",
  frontStdTop: "rgba(25, 31, 44, 0.98)",
  frontStdBot: "rgba(17, 21, 31, 0.98)",
  topCore0: "rgba(33, 45, 70, 0.98)",
  topCore1: "rgba(25, 34, 54, 0.97)",
  topCore2: "rgba(20, 28, 45, 0.96)",
  topCanopy0: "rgba(24, 48, 41, 0.98)",
  topCanopy1: "rgba(19, 39, 34, 0.97)",
  topCanopy2: "rgba(16, 32, 28, 0.96)",
  topStd0: "rgba(30, 36, 51, 0.97)",
  topStd1: "rgba(21, 26, 38, 0.96)",
  rimRest: "rgba(255, 255, 255, 0.14)",
  bottomHairline: "rgba(255, 255, 255, 0.08)",
  textPrimary: "#F2F4F8",
  textSecondary: "#CFD6E3",
  textMuted: "rgba(180, 188, 203, 0.88)",
  textSubtleAccent: "rgba(118, 184, 255, 0.92)",
  conduitLabel: "rgba(214, 222, 235, 0.92)",
  ledgerRowRest: "rgba(148, 163, 184, 0.34)",
  ledgerColRest: "rgba(148, 163, 184, 0.24)",
  ledgerDotRest: "rgba(148, 163, 184, 0.55)",
  lockDot: "rgba(180, 188, 203, 0.82)",
};

const FONT_SANS_ZH_CN =
  '"SF Pro Text","SF Pro Display",-apple-system,"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif';
const FONT_SANS_ZH_HK =
  '"SF Pro Text","SF Pro Display",-apple-system,"PingFang HK","PingFang TC","Noto Sans HK","Noto Sans TC","Microsoft JhengHei",sans-serif';
const FONT_SANS_EN =
  '"SF Pro Text","SF Pro Display",-apple-system,BlinkMacSystemFont,"Inter","PingFang HK","PingFang SC",sans-serif';
const FONT_MONO = '"SF Mono","JetBrains Mono",ui-monospace,Menlo,monospace';

function getCanvasSansFont(locale: string): string {
  if (locale === "zh-HK") return FONT_SANS_ZH_HK;
  if (locale === "en") return FONT_SANS_EN;
  return FONT_SANS_ZH_CN;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function drawChevron(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ang: number,
  size: number,
  color: string,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.45;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(-size, -size * 0.68);
  ctx.lineTo(0, 0);
  ctx.lineTo(-size, size * 0.68);
  ctx.stroke();
  ctx.restore();
}

export interface ArchitecturalRelayCanvasProps {
  compact?: boolean;
  className?: string;
}

export function ArchitecturalRelayCanvas({
  compact = false,
  className = "",
}: ArchitecturalRelayCanvasProps) {
  const { theme } = useTheme();
  const { locale, t } = useLocale();

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderNowRef = useRef<(() => void) | null>(null);

  const [selectedStratum, setSelectedStratum] = useState<number>(2);
  const [hoveredStratum, setHoveredStratum] = useState<number | null>(null);

  const strataMeta = useMemo<readonly StratumMeta[]>(
    () => [
      {
        index: 0,
        id: "floor",
        code: "01",
        tabLabel: t("login.canvas.stratum0.tab"),
        title: t("login.canvas.stratum0.title"),
        caption: t("login.canvas.stratum0.caption"),
        detail: t("login.canvas.stratum0.detail"),
      },
      {
        index: 1,
        id: "gate",
        code: "02",
        tabLabel: t("login.canvas.stratum1.tab"),
        title: t("login.canvas.stratum1.title"),
        caption: t("login.canvas.stratum1.caption"),
        detail: t("login.canvas.stratum1.detail"),
      },
      {
        index: 2,
        id: "workbench",
        code: "03",
        tabLabel: t("login.canvas.stratum2.tab"),
        title: t("login.canvas.stratum2.title"),
        caption: t("login.canvas.stratum2.caption"),
        detail: t("login.canvas.stratum2.detail"),
      },
      {
        index: 3,
        id: "ledger",
        code: "04",
        tabLabel: t("login.canvas.stratum3.tab"),
        title: t("login.canvas.stratum3.title"),
        caption: t("login.canvas.stratum3.caption"),
        detail: t("login.canvas.stratum3.detail"),
      },
    ],
    [t],
  );

  const slabs = useMemo<readonly SlabDef[]>(
    () => [
      {
        stratumIdx: 1,
        slabKey: "gate-left",
        x: -1.35,
        y: -0.58,
        z: 0.05,
        bw: 1.65,
        bd: 0.85,
        bh: 0.24,
        accentKind: "cobalt",
        title: t("login.canvas.slab.gateLeft.title"),
        shortTitle: t("login.canvas.slab.gateLeft.short"),
        sub: t("login.canvas.slab.gateLeft.sub"),
      },
      {
        stratumIdx: 1,
        slabKey: "gate-right",
        x: 1.35,
        y: -0.58,
        z: 0.05,
        bw: 1.65,
        bd: 0.85,
        bh: 0.24,
        accentKind: "cobalt",
        title: t("login.canvas.slab.gateRight.title"),
        shortTitle: t("login.canvas.slab.gateRight.short"),
        sub: t("login.canvas.slab.gateRight.sub"),
      },
      {
        stratumIdx: 2,
        slabKey: "workbench",
        x: 0.0,
        y: 0.56,
        z: 0.0,
        bw: 2.1,
        bd: 0.96,
        bh: 0.44,
        accentKind: "cobalt",
        title: t("login.canvas.slab.workbench.title"),
        shortTitle: t("login.canvas.slab.workbench.short"),
        sub: t("login.canvas.slab.workbench.sub"),
        core: true,
      },
      {
        stratumIdx: 3,
        slabKey: "ledger",
        x: 0.0,
        y: 1.82,
        z: -0.04,
        bw: 3.2,
        bd: 0.82,
        bh: 0.16,
        accentKind: "emerald",
        title: t("login.canvas.slab.ledger.title"),
        shortTitle: t("login.canvas.slab.ledger.short"),
        sub: t("login.canvas.slab.ledger.sub"),
        canopy: true,
      },
    ],
    [t],
  );

  const conduits = useMemo<readonly ConduitDef[]>(
    () => [
      {
        from: [-1.35, -1.82, 0.06],
        to: [-1.35, -0.64, 0.05],
        strata: [0, 1],
        lbl: t("login.canvas.conduit.identity"),
        side: "l",
        accentKind: "cobalt",
        ph: 0.08,
      },
      {
        from: [1.35, -1.82, 0.06],
        to: [1.35, -0.64, 0.05],
        strata: [0, 1],
        lbl: t("login.canvas.conduit.siteBoundary"),
        side: "r",
        accentKind: "cobalt",
        ph: 0.34,
      },
      {
        from: [-1.02, -0.26, 0.04],
        to: [-0.52, 0.52, 0.0],
        strata: [1, 2],
        lbl: t("login.canvas.conduit.grantIntersection"),
        side: "l",
        accentKind: "cobalt",
        ph: 0.22,
      },
      {
        from: [1.02, -0.26, 0.04],
        to: [0.52, 0.52, 0.0],
        strata: [1, 2],
        lbl: t("login.canvas.conduit.digestPreview"),
        side: "r",
        accentKind: "cobalt",
        ph: 0.56,
      },
      {
        from: [-0.46, 1.04, 0.0],
        to: [-0.46, 1.8, -0.04],
        strata: [2, 3],
        lbl: t("login.canvas.conduit.idempotentQueue"),
        side: "l",
        accentKind: "cobalt",
        ph: 0.14,
      },
      {
        from: [0.46, 1.8, -0.04],
        to: [0.46, 1.04, 0.0],
        strata: [3, 2],
        lbl: t("login.canvas.conduit.receiptReadback"),
        side: "r",
        accentKind: "emerald",
        ph: 0.68,
      },
    ],
    [t],
  );

  const selectedRef = useRef<number>(selectedStratum);
  const hoveredRef = useRef<number | null>(hoveredStratum);
  const themeRef = useRef<Theme>(theme);
  const localeRef = useRef<string>(locale);
  const slabsRef = useRef<readonly SlabDef[]>(slabs);
  const conduitsRef = useRef<readonly ConduitDef[]>(conduits);

  selectedRef.current = selectedStratum;
  hoveredRef.current = hoveredStratum;
  themeRef.current = theme;
  localeRef.current = locale;
  slabsRef.current = slabs;
  conduitsRef.current = conduits;

  const activeStratumIdx = hoveredStratum ?? selectedStratum;
  const activeMeta = strataMeta[activeStratumIdx] ?? strataMeta[2]!;

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reducedMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fineMq = window.matchMedia("(pointer: fine)");

    const cam = { yaw: 0, pitch: 0 };
    const camTarget = { yaw: 0, pitch: 0 };
    const elev = [0, 0, 0, 0];
    const hitBoxes = [0, 1, 2, 3].map(() => ({ x1: 0, y1: 0, x2: 0, y2: 0 }));
    let floorHitBox = { x1: 0, y1: 0, x2: 0, y2: 0 };

    let inView = true;
    let raf = 0;
    let lastTs = 0;
    let time = 2.6;

    const fitCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const targetW = Math.round(w * dpr);
      const targetH = Math.round(h * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      return { w, h, dpr };
    };

    const getFocusIdx = () =>
      hoveredRef.current !== null ? hoveredRef.current : selectedRef.current;

    const render = () => {
      const { w, h, dpr } = fitCanvas();
      const palette =
        themeRef.current === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
      const fontSans = getCanvasSansFont(localeRef.current);
      const curSlabs = slabsRef.current;
      const curConduits = conduitsRef.current;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const isCompact = compact || w < 500;
      const portrait = w < 460;
      const xComp = portrait ? 0.76 : 1;
      const scale = portrait
        ? Math.min(w / 5.4, h / 5.35)
        : Math.min(w / 6.1, h / 5.35);
      const cx0 = w * 0.5;
      const cy0 = h * (isCompact ? 0.525 : 0.53);

      const basePitch = isCompact ? 0.36 : 0.34;
      const yaw = reducedMq.matches ? 0 : cam.yaw;
      const pitch = basePitch + (reducedMq.matches ? 0 : cam.pitch);
      const cyaw = Math.cos(yaw);
      const syaw = Math.sin(yaw);
      const cpitch = Math.cos(pitch);
      const spitch = Math.sin(pitch);

      const proj = (x: number, y: number, z: number) => {
        const sx = x * xComp;
        const x1 = sx * cyaw - z * syaw;
        const z1 = sx * syaw + z * cyaw;
        const y2 = y * cpitch - z1 * spitch;
        const z2 = y * spitch + z1 * cpitch;
        const persp = 11.5 / (11.5 - z2);
        return {
          x: cx0 + x1 * scale * persp,
          y: cy0 - y2 * scale * persp,
          s: persp,
        };
      };

      const focusIdx = getFocusIdx();

      // Subtle cool ambient aura behind core workbench stratum (no neon blur)
      const auraCenter = proj(0, 0.55, 0);
      const auraGrad = ctx.createRadialGradient(
        auraCenter.x,
        auraCenter.y,
        12,
        auraCenter.x,
        auraCenter.y,
        Math.max(w, h) * 0.44,
      );
      auraGrad.addColorStop(0, palette.auraCore);
      auraGrad.addColorStop(0.55, palette.auraMid);
      auraGrad.addColorStop(1, palette.auraOuter);
      ctx.fillStyle = auraGrad;
      ctx.fillRect(0, 0, w, h);

      // -----------------------------------------------------------------------
      // STRATUM 0: Blueprint Tenant & Warehouse Grid (y = -1.85)
      // -----------------------------------------------------------------------
      const floorY = -1.85;
      const floorHot = focusIdx === 0;
      const floorAlpha = floorHot ? 1 : 0.78;

      const fTL = proj(-3.6, floorY, -1.0);
      const fBR = proj(3.6, floorY, 1.0);
      floorHitBox = {
        x1: Math.min(fTL.x, fBR.x),
        x2: Math.max(fTL.x, fBR.x),
        y1: Math.min(fTL.y, fBR.y) - 16,
        y2: Math.max(fTL.y, fBR.y) + 22,
      };

      ctx.save();
      ctx.lineWidth = 1;
      for (let gx = -3.6; gx <= 3.61; gx += 0.6) {
        const a = proj(gx, floorY, -1.0);
        const b = proj(gx, floorY, 1.0);
        const edgeFade = Math.max(0.22, 1 - Math.abs(gx) / 4.2);
        const gridOpacity = themeRef.current === "dark" ? 0.22 : 0.16;
        ctx.strokeStyle = `rgba(${palette.cobaltRgb},${(gridOpacity * edgeFade * floorAlpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (let gz = -1.0; gz <= 1.01; gz += 0.4) {
        const a = proj(-3.6, floorY, gz);
        const b = proj(3.6, floorY, gz);
        const edgeFade = Math.max(0.25, 1 - Math.abs(gz) / 1.4);
        ctx.strokeStyle = `rgba(${palette.slateRgb},${(0.16 * edgeFade * floorAlpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      const siteMarks: Array<{ x: number; label: string }> = [
        { x: -2.2, label: "HK01" },
        { x: 0, label: "RLS" },
        { x: 2.2, label: "HK02" },
      ];
      ctx.font = `500 11px ${FONT_MONO}`;
      ctx.textAlign = "center";
      siteMarks.forEach((mark) => {
        const p = proj(mark.x, floorY, 0.96);
        ctx.strokeStyle = `rgba(${palette.cobaltRgb},${(0.52 * floorAlpha).toFixed(3)})`;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(p.x - 4.5, p.y);
        ctx.lineTo(p.x + 4.5, p.y);
        ctx.moveTo(p.x, p.y - 3.5);
        ctx.lineTo(p.x, p.y + 3.5);
        ctx.stroke();

        ctx.fillStyle = floorHot ? palette.siteMarkHot : palette.siteMarkRest;
        ctx.fillText(mark.label, p.x, p.y + 16);
      });

      // Soft concentric ripples under Gate anchors
      [-1.35, 1.35].forEach((fx, fi) => {
        const fp = proj(fx, floorY, 0.06);
        const col = fi === 0 ? palette.cobaltRgb : palette.emeraldRgb;
        for (let r = 0; r < 2; r++) {
          const ph = (time * 0.3 + fi * 0.45 + r * 0.5) % 1;
          ctx.strokeStyle = `rgba(${col},${((1 - ph) * 0.25 * floorAlpha).toFixed(3)})`;
          ctx.lineWidth = 1.05;
          ctx.beginPath();
          ctx.ellipse(
            fp.x,
            fp.y,
            (8 + ph * 30) * (scale / 110),
            (3 + ph * 10) * (scale / 110),
            0,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        }
      });
      ctx.restore();

      // -----------------------------------------------------------------------
      // Helper: Draw Luminous Porcelain (Light) / Matte Obsidian (Dark) 3D Slab
      // -----------------------------------------------------------------------
      const drawSlab = (slab: SlabDef, slabIndex: number) => {
        const isPrimary = focusIdx === slab.stratumIdx;
        const isConnected =
          isPrimary ||
          curConduits.some(
            (c) =>
              c.strata.includes(focusIdx) && c.strata.includes(slab.stratumIdx),
          );
        const lift = elev[slab.stratumIdx] ?? 0;
        const yB = slab.y + lift;
        const yT = yB + slab.bh;
        const hw = slab.bw * 0.5;
        const hd = slab.bd * 0.5;
        const accentRgb =
          slab.accentKind === "emerald"
            ? palette.emeraldRgb
            : palette.cobaltRgb;

        const tl = proj(slab.x - hw, yT, -hd);
        const tr = proj(slab.x + hw, yT, -hd);
        const fl = proj(slab.x - hw, yT, hd);
        const fr = proj(slab.x + hw, yT, hd);
        const bfl = proj(slab.x - hw, yB, hd);
        const bfr = proj(slab.x + hw, yB, hd);
        const btl = proj(slab.x - hw, yB, -hd);
        const btr = proj(slab.x + hw, yB, -hd);

        hitBoxes[slabIndex] = {
          x1: Math.min(tl.x, fl.x, bfl.x) - 8,
          x2: Math.max(tr.x, fr.x, bfr.x) + 8,
          y1: Math.min(tl.y, tr.y) - 18,
          y2: Math.max(bfl.y, bfr.y) + 12,
        };

        ctx.save();
        ctx.globalAlpha = isPrimary ? 1 : isConnected ? 0.92 : 0.76;

        // Ambient drop shadow beneath floating slab
        const shadowOff = isPrimary ? 12 : 7;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(bfl.x, bfl.y + shadowOff);
        ctx.lineTo(bfr.x, bfr.y + shadowOff);
        ctx.lineTo(btr.x, btr.y + shadowOff);
        ctx.lineTo(btl.x, btl.y + shadowOff);
        ctx.closePath();
        ctx.fillStyle = isPrimary
          ? palette.dropShadowHot
          : palette.dropShadowRest;
        ctx.fill();
        ctx.restore();

        // Visible side thickness bevel
        if (yaw >= 0) {
          ctx.beginPath();
          ctx.moveTo(tl.x, tl.y);
          ctx.lineTo(fl.x, fl.y);
          ctx.lineTo(bfl.x, bfl.y);
          ctx.lineTo(btl.x, btl.y);
          ctx.closePath();
          ctx.fillStyle = slab.core ? palette.sideCore : palette.sideStd;
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(tr.x, tr.y);
          ctx.lineTo(fr.x, fr.y);
          ctx.lineTo(bfr.x, bfr.y);
          ctx.lineTo(btr.x, btr.y);
          ctx.closePath();
          ctx.fillStyle = slab.core ? palette.sideCore : palette.sideStd;
          ctx.fill();
        }

        // Front vertical thickness bezel
        const gFront = ctx.createLinearGradient(fl.x, fl.y, bfl.x, bfl.y);
        if (slab.core) {
          gFront.addColorStop(0, palette.frontCoreTop);
          gFront.addColorStop(1, palette.frontCoreBot);
        } else if (slab.canopy) {
          gFront.addColorStop(0, palette.frontCanopyTop);
          gFront.addColorStop(1, palette.frontCanopyBot);
        } else {
          gFront.addColorStop(0, palette.frontStdTop);
          gFront.addColorStop(1, palette.frontStdBot);
        }
        ctx.fillStyle = gFront;
        ctx.beginPath();
        ctx.moveTo(fl.x, fl.y);
        ctx.lineTo(fr.x, fr.y);
        ctx.lineTo(bfr.x, bfr.y);
        ctx.lineTo(bfl.x, bfl.y);
        ctx.closePath();
        ctx.fill();

        // Top deck material
        const gTop = ctx.createLinearGradient(tl.x, tl.y, fr.x, fr.y);
        if (slab.core) {
          gTop.addColorStop(0, palette.topCore0);
          gTop.addColorStop(0.55, palette.topCore1);
          gTop.addColorStop(1, palette.topCore2);
        } else if (slab.canopy) {
          gTop.addColorStop(0, palette.topCanopy0);
          gTop.addColorStop(0.6, palette.topCanopy1);
          gTop.addColorStop(1, palette.topCanopy2);
        } else {
          gTop.addColorStop(0, palette.topStd0);
          gTop.addColorStop(1, palette.topStd1);
        }
        ctx.fillStyle = gTop;
        ctx.beginPath();
        ctx.moveTo(tl.x, tl.y);
        ctx.lineTo(tr.x, tr.y);
        ctx.lineTo(fr.x, fr.y);
        ctx.lineTo(fl.x, fl.y);
        ctx.closePath();
        ctx.fill();

        // Precision rim highlight
        ctx.strokeStyle = isPrimary
          ? `rgba(${accentRgb}, 0.82)`
          : slab.core
            ? `rgba(${accentRgb}, 0.38)`
            : palette.rimRest;
        ctx.lineWidth = isPrimary ? 1.45 : 1.05;
        ctx.beginPath();
        ctx.moveTo(tl.x, tl.y);
        ctx.lineTo(tr.x, tr.y);
        ctx.lineTo(fr.x, fr.y);
        ctx.lineTo(fl.x, fl.y);
        ctx.closePath();
        ctx.stroke();

        // Front bottom hairline
        ctx.strokeStyle = palette.bottomHairline;
        ctx.lineWidth = 0.85;
        ctx.beginPath();
        ctx.moveTo(bfl.x, bfl.y);
        ctx.lineTo(bfr.x, bfr.y);
        ctx.stroke();

        // Sculptural micro-artifacts on each top deck
        if (slab.slabKey === "gate-left") {
          const shift = Math.sin(time * 0.9) * 0.045;
          const bars: Array<[number, number, number, string]> = [
            [-0.56, 0.24, -0.22, palette.cobaltRgb],
            [-0.44 + shift, 0.42 + shift, 0.0, palette.slateRgb],
            [-0.5, 0.34, 0.22, palette.emeraldRgb],
          ];
          bars.forEach(([x0, x1, zb, col]) => {
            const a = proj(slab.x + x0, yT + 0.04, zb);
            const b = proj(slab.x + x1, yT + 0.04, zb);
            ctx.strokeStyle = `rgba(${col}, 0.78)`;
            ctx.lineWidth = isCompact ? 2.4 : 2.8;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          });
        } else if (slab.slabKey === "gate-right") {
          const scanU = (Math.sin(time * 1.1) + 1) * 0.5;
          const sz = lerp(-hd * 0.72, hd * 0.72, scanU);
          const sa = proj(slab.x - hw * 0.78, yT + 0.03, sz);
          const sb = proj(slab.x + hw * 0.78, yT + 0.03, sz);
          ctx.strokeStyle = `rgba(${palette.cobaltRgb}, 0.82)`;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(sa.x, sa.y);
          ctx.lineTo(sb.x, sb.y);
          ctx.stroke();

          for (let k = -1; k <= 1; k++) {
            const np = proj(slab.x + k * 0.42, yT + 0.03, 0);
            ctx.fillStyle = palette.lockDot;
            ctx.beginPath();
            ctx.arc(np.x, np.y, 2.0, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (slab.slabKey === "workbench") {
          for (const ribX of [-0.52, 0.52]) {
            const r1 = proj(ribX, yT + 0.02, -hd * 0.76);
            const r2 = proj(ribX, yT + 0.02, hd * 0.76);
            ctx.strokeStyle = `rgba(${palette.cobaltRgb}, 0.22)`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(r1.x, r1.y);
            ctx.lineTo(r2.x, r2.y);
            ctx.stroke();
          }
          const h1 = proj(-hw * 0.72, yT + 0.02, 0);
          const h2 = proj(hw * 0.72, yT + 0.02, 0);
          ctx.strokeStyle = `rgba(${palette.cobaltRgb}, 0.28)`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(h1.x, h1.y);
          ctx.lineTo(h2.x, h2.y);
          ctx.stroke();

          const centerP = proj(0, yT + 0.03, 0);
          const pulse = 0.45 + 0.4 * Math.sin(time * 2.0);
          ctx.strokeStyle = `rgba(${palette.cobaltRgb}, ${pulse.toFixed(2)})`;
          ctx.lineWidth = 1.35;
          ctx.beginPath();
          ctx.arc(centerP.x, centerP.y, 5.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = palette.cobaltHex;
          ctx.beginPath();
          ctx.arc(centerP.x, centerP.y, 2.2, 0, Math.PI * 2);
          ctx.fill();
        } else if (slab.slabKey === "ledger") {
          const activeRow = Math.floor(time * 0.85) % 3;
          const rowZs = [-0.2, 0.0, 0.2] as const;
          rowZs.forEach((rz, rIdx) => {
            const isRowActive = rIdx === activeRow;
            const leftP = proj(-hw * 0.82, yT + 0.03, rz);
            const midP = proj(hw * 0.36, yT + 0.03, rz);
            const rightP = proj(hw * 0.82, yT + 0.03, rz);

            ctx.strokeStyle = isRowActive
              ? `rgba(${palette.emeraldRgb}, 0.86)`
              : palette.ledgerRowRest;
            ctx.lineWidth = isRowActive ? 1.8 : 1.15;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(leftP.x, leftP.y);
            ctx.lineTo(midP.x, midP.y);
            ctx.stroke();

            ctx.strokeStyle = isRowActive
              ? `rgba(${palette.cobaltRgb}, 0.82)`
              : palette.ledgerColRest;
            ctx.lineWidth = isRowActive ? 1.8 : 1.15;
            ctx.beginPath();
            ctx.moveTo(
              lerp(midP.x, rightP.x, 0.28),
              lerp(midP.y, rightP.y, 0.28),
            );
            ctx.lineTo(rightP.x, rightP.y);
            ctx.stroke();

            ctx.fillStyle = isRowActive
              ? palette.emeraldHex
              : palette.ledgerDotRest;
            ctx.beginPath();
            ctx.arc(
              leftP.x - 6,
              leftP.y,
              isRowActive ? 2.4 : 1.8,
              0,
              Math.PI * 2,
            );
            ctx.fill();
          });
        }

        // Crisp world-space typography (>= 11px everywhere, AA contrast in both themes)
        const label = isCompact ? slab.shortTitle : slab.title;
        ctx.textAlign = "center";
        if (slab.canopy) {
          const p = proj(0, yT + 0.28, 0);
          ctx.font = `600 ${isCompact ? 12 : 13.5}px ${fontSans}`;
          ctx.fillStyle = isPrimary ? palette.emeraldHex : palette.textPrimary;
          ctx.fillText(label, p.x, p.y - 12);
          if (!isCompact) {
            ctx.font = `500 11px ${fontSans}`;
            ctx.fillStyle = palette.textMuted;
            ctx.fillText(slab.sub, p.x, p.y + 4);
          }
        } else if (slab.core) {
          const pf = proj(0, yB + slab.bh * 0.54, hd);
          ctx.font = `600 ${isCompact ? 12 : 13.5}px ${fontSans}`;
          ctx.fillStyle = isPrimary ? palette.cobaltHex : palette.textPrimary;
          ctx.fillText(label, pf.x, pf.y + (isCompact ? 3 : -1));
          if (!isCompact) {
            ctx.font = `500 11px ${fontSans}`;
            ctx.fillStyle = palette.textSubtleAccent;
            ctx.fillText(slab.sub, pf.x, pf.y + 14);
          }
        } else {
          const pf = proj(slab.x, yB + slab.bh * 0.5, hd);
          ctx.font = `600 ${isCompact ? 11 : 12}px ${fontSans}`;
          ctx.fillStyle = isPrimary
            ? palette.textPrimary
            : palette.textSecondary;
          ctx.fillText(label, pf.x, pf.y + 4);
        }

        ctx.restore();
      };

      // -----------------------------------------------------------------------
      // Helper: Draw Precision Optical Conduits (Cobalt & Emerald)
      // -----------------------------------------------------------------------
      const drawConduits = (subset: readonly ConduitDef[]) => {
        subset.forEach((c) => {
          const hot = c.strata.includes(focusIdx);
          const liftA = c.strata[0] === 0 ? 0 : (elev[c.strata[0]] ?? 0);
          const liftB = c.strata[1] === 0 ? 0 : (elev[c.strata[1]] ?? 0);
          const a = proj(c.from[0], c.from[1] + liftA, c.from[2]);
          const b = proj(c.to[0], c.to[1] + liftB, c.to[2]);
          const col =
            c.accentKind === "emerald"
              ? palette.emeraldRgb
              : palette.cobaltRgb;

          ctx.save();
          ctx.globalAlpha = hot ? 1 : 0.44;

          const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
          grad.addColorStop(0, `rgba(${col}, 0.24)`);
          grad.addColorStop(0.5, `rgba(${col}, 0.72)`);
          grad.addColorStop(1, `rgba(${col}, 0.38)`);
          ctx.strokeStyle = grad;
          ctx.lineWidth = hot ? 1.5 : 1.1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();

          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          drawChevron(
            ctx,
            lerp(a.x, b.x, 0.86),
            lerp(a.y, b.y, 0.86),
            ang,
            4.2,
            `rgba(${col}, 0.92)`,
          );

          if (hot) {
            const u = (time * 0.34 + c.ph) % 1;
            const px = lerp(a.x, b.x, u);
            const py = lerp(a.y, b.y, u);
            const tx = lerp(a.x, b.x, Math.max(0, u - 0.16));
            const ty = lerp(a.y, b.y, Math.max(0, u - 0.16));
            const tg = ctx.createLinearGradient(tx, ty, px, py);
            tg.addColorStop(0, `rgba(${col}, 0)`);
            tg.addColorStop(1, `rgba(${col}, 0.96)`);
            ctx.strokeStyle = tg;
            ctx.lineWidth = 2.2;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(px, py);
            ctx.stroke();
          }

          if (!isCompact && hot) {
            const mx = (a.x + b.x) * 0.5;
            const my = (a.y + b.y) * 0.5;
            ctx.font = `500 11px ${fontSans}`;
            ctx.fillStyle = palette.conduitLabel;
            ctx.textAlign = c.side === "l" ? "right" : "left";
            ctx.fillText(c.lbl, c.side === "l" ? mx - 10 : mx + 10, my + 3.5);
          }

          ctx.restore();
        });
      };

      drawConduits(curConduits.slice(0, 2));
      drawSlab(curSlabs[0]!, 0);
      drawSlab(curSlabs[1]!, 1);
      drawConduits(curConduits.slice(2, 4));
      drawSlab(curSlabs[2]!, 2);
      drawConduits(curConduits.slice(4, 6));
      drawSlab(curSlabs[3]!, 3);

      ctx.restore();
    };

    renderNowRef.current = render;

    const tick = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, lastTs ? (now - lastTs) / 1000 : 0.016);
      lastTs = now;
      time += dt;

      const k = 1 - Math.exp(-dt * 7.5);
      cam.yaw += (camTarget.yaw - cam.yaw) * k;
      cam.pitch += (camTarget.pitch - cam.pitch) * k;

      const focusIdx = getFocusIdx();
      for (let i = 0; i < elev.length; i++) {
        const targetLift = i === focusIdx ? 0.18 : 0;
        elev[i] = (elev[i] ?? 0) + (targetLift - (elev[i] ?? 0)) * k;
      }

      render();
      if (inView && !document.hidden && !reducedMq.matches) {
        raf = requestAnimationFrame(tick);
      }
    };

    const refresh = () => {
      const shouldRun = inView && !document.hidden && !reducedMq.matches;
      if (shouldRun && !raf) {
        lastTs = 0;
        raf = requestAnimationFrame(tick);
      } else if (!shouldRun) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        if (reducedMq.matches) {
          time = 2.6;
          cam.yaw = 0;
          cam.pitch = 0;
          const focusIdx = getFocusIdx();
          for (let i = 0; i < elev.length; i++) {
            elev[i] = i === focusIdx ? 0.14 : 0;
          }
        }
        render();
      }
    };

    const hitTest = (px: number, py: number): number | null => {
      const curSlabs = slabsRef.current;
      for (let i = curSlabs.length - 1; i >= 0; i--) {
        const b = hitBoxes[i];
        if (b && px >= b.x1 && px <= b.x2 && py >= b.y1 && py <= b.y2) {
          return curSlabs[i]!.stratumIdx;
        }
      }
      if (
        px >= floorHitBox.x1 &&
        px <= floorHitBox.x2 &&
        py >= floorHitBox.y1 &&
        py <= floorHitBox.y2
      ) {
        return 0;
      }
      return null;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!fineMq.matches || reducedMq.matches) return;
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      camTarget.yaw = (px / Math.max(1, r.width) - 0.5) * 0.28;
      camTarget.pitch = (py / Math.max(1, r.height) - 0.5) * 0.12;
      const hit = hitTest(px, py);
      if (hit !== hoveredRef.current) {
        hoveredRef.current = hit;
        setHoveredStratum(hit);
        canvas.style.cursor = hit !== null ? "pointer" : "default";
        if (!raf) render();
      }
    };

    const onPointerLeave = () => {
      camTarget.yaw = 0;
      camTarget.pitch = 0;
      if (hoveredRef.current !== null) {
        hoveredRef.current = null;
        setHoveredStratum(null);
        canvas.style.cursor = "default";
        if (!raf) render();
      }
    };

    const onClick = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const hit = hitTest(e.clientX - r.left, e.clientY - r.top);
      if (hit !== null) {
        selectedRef.current = hit;
        setSelectedStratum(hit);
        if (!raf) render();
      }
    };

    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("click", onClick);

    const resizeObs = new ResizeObserver(() => render());
    resizeObs.observe(canvas);

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          const last = entries[entries.length - 1];
          inView = last ? last.isIntersecting : true;
          refresh();
        },
        { threshold: 0.04 },
      );
      io.observe(stage);
    }

    document.addEventListener("visibilitychange", refresh);
    reducedMq.addEventListener("change", refresh);

    refresh();

    return () => {
      renderNowRef.current = null;
      if (raf) cancelAnimationFrame(raf);
      resizeObs.disconnect();
      io?.disconnect();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", refresh);
      reducedMq.removeEventListener("change", refresh);
    };
  }, [compact]);

  // Immediate redraw on theme, locale, or selected stratum change
  useEffect(() => {
    renderNowRef.current?.();
  }, [theme, locale, selectedStratum, hoveredStratum]);

  return (
    <div
      ref={stageRef}
      data-testid="architectural-relay-canvas"
      className={[
        "relative flex h-full w-full flex-col justify-between overflow-hidden select-none",
        "bg-[image:var(--canvas-stage-bg)] text-[var(--ink-primary)]",
        className,
      ].join(" ")}
    >
      {/* Top quiet header */}
      {!compact && (
        <div className="flex items-center justify-between border-b border-[var(--hairline)] px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
            <span className="text-[13px] font-semibold text-[var(--ink-primary)]">
              {t("login.canvas.headerTitle")}
            </span>
          </div>
          <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--ink-secondary)]">
            {t("login.canvas.headerBadge")}
          </span>
        </div>
      )}

      {/* 3D Perspective Porcelain / Obsidian Canvas */}
      <div
        className={[
          "relative w-full flex-1",
          compact ? "min-h-[170px]" : "min-h-[340px]",
        ].join(" ")}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="block h-full w-full"
        />
      </div>

      {/* Accessible Stratum Pills + Live Architectural Caption */}
      {!compact && (
        <div className="border-t border-[var(--hairline)] bg-[var(--canvas-footer-bg)] backdrop-blur-md px-6 py-4">
          <div
            role="tablist"
            aria-label={t("login.canvas.tablistAria")}
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {strataMeta.map((item) => {
              const active = activeStratumIdx === item.index;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelectedStratum(item.index)}
                  onFocus={() => setSelectedStratum(item.index)}
                  onMouseEnter={() => setHoveredStratum(item.index)}
                  onMouseLeave={() => setHoveredStratum(null)}
                    className={[
                      "flex items-center gap-2 rounded-sm px-3 py-2 text-left transition-all duration-[160ms] cursor-pointer",
                      active
                        ? "bg-[var(--bg-surface)] text-[var(--accent-ink)] shadow-[var(--shadow-subtle)] ring-1 ring-[var(--accent-border)]"
                        : "bg-[var(--bg-surface-tint)] text-[var(--ink-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "font-mono-code text-[11px] font-semibold",
                        active ? "text-[var(--accent-ink)]" : "text-[var(--ink-muted)]",
                      ].join(" ")}
                    >
                      {item.code}
                    </span>
                    <span className="truncate text-[12.5px] font-medium">
                      {item.tabLabel}
                    </span>
                  </button>
                );
              })}
            </div>

            <div
              aria-live="polite"
              className="mt-3 flex min-h-[2.75rem] flex-col justify-start gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
            >
              <p className="text-[12.5px] text-[var(--ink-secondary)] leading-relaxed">
                <span className="font-semibold text-[var(--ink-primary)]">
                  {activeMeta.title}
                </span>
                <span className="mx-2 text-[var(--ink-faint)]">·</span>
                {activeMeta.detail}
              </p>
              <span className="shrink-0 text-[11.5px] leading-relaxed text-[var(--ink-muted)]">
                {activeMeta.caption}
              </span>
            </div>
        </div>
      )}
    </div>
  );
}
