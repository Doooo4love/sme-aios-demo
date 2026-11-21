"use client";

import React, { useEffect, useRef, useState } from "react";

interface StratumMeta {
  index: number;
  id: "floor" | "gate" | "workbench" | "ledger";
  code: string;
  tabLabel: string;
  titleZh: string;
  titleEn: string;
  caption: string;
  detail: string;
}

const STRATA_META: readonly StratumMeta[] = [
  {
    index: 0,
    id: "floor",
    code: "01",
    tabLabel: "租户隔离",
    titleZh: "租户与站点隔离层",
    titleEn: "Tenant Isolation",
    caption: "aios_tenant · RLS · warehouses",
    detail: "租户级行级隔离与仓库站点边界在每一次鉴权和查询中强制生效，跨租户与跨仓记录统一不可见。",
  },
  {
    index: 1,
    id: "gate",
    code: "02",
    tabLabel: "策略闸门",
    titleZh: "策略与模块准入闸门",
    titleEn: "Policy & Module Gate",
    caption: "ACL ∩ OPA · Digest Lock",
    detail: "身份授权、模块动态配置与摘要锁三重交集校验，所有写入前均需独立复核确认。",
  },
  {
    index: 2,
    id: "workbench",
    code: "03",
    tabLabel: "Agent 工作台",
    titleZh: "个人 Agent 工作台",
    titleEn: "Personal Agent Workbench",
    caption: "Typed Tools · Zero CoT Leak",
    detail: "受类型化工具边界约束的个人工作台，仅暴露可核验业务结果与提案，绝不泄露模型内部链路。",
  },
  {
    index: 3,
    id: "ledger",
    code: "04",
    tabLabel: "ERP 回执核验",
    titleZh: "已核验 ERP 账本",
    titleEn: "Verified ERP Ledger",
    caption: "Outbox · Read-Back Receipt",
    detail: "幂等 Outbox 队列派发与 ERP 只读回查核验，每条已核验单据均绑定不可伪造的摘要回执。",
  },
] as const;

interface SlabDef {
  stratumIdx: number;
  slabKey: "gate-left" | "gate-right" | "workbench" | "ledger";
  x: number;
  y: number;
  z: number;
  bw: number;
  bd: number;
  bh: number;
  accentRgb: string;
  title: string;
  shortTitle: string;
  sub: string;
  core?: boolean;
  canopy?: boolean;
}

const SLABS: readonly SlabDef[] = [
  {
    stratumIdx: 1,
    slabKey: "gate-left",
    x: -1.35,
    y: -0.58,
    z: 0.05,
    bw: 1.65,
    bd: 0.85,
    bh: 0.24,
    accentRgb: "28,168,201",
    title: "ACL 权限边界",
    shortTitle: "ACL 边界",
    sub: "role · grant · site",
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
    accentRgb: "28,168,201",
    title: "策略与摘要锁",
    shortTitle: "策略闸门",
    sub: "OPA · Digest Lock",
  },
  {
    stratumIdx: 2,
    slabKey: "workbench",
    x: 0.0,
    y: 0.56,
    z: 0.0,
    bw: 2.05,
    bd: 0.96,
    bh: 0.44,
    accentRgb: "56,152,226",
    title: "个人 Agent 工作台",
    shortTitle: "Agent 工作台",
    sub: "Typed Tools · Zero CoT Leak",
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
    accentRgb: "52,208,88",
    title: "已核验 ERP 账本",
    shortTitle: "ERP 核验账本",
    sub: "Outbox · Read-Back Receipt",
    canopy: true,
  },
];

interface ConduitDef {
  from: [number, number, number];
  to: [number, number, number];
  strata: [number, number];
  lbl: string;
  side: "l" | "r";
  col: string;
  ph: number;
}

const CONDUITS: readonly ConduitDef[] = [
  {
    from: [-1.35, -1.82, 0.06],
    to: [-1.35, -0.64, 0.05],
    strata: [0, 1],
    lbl: "Identity Claim",
    side: "l",
    col: "56,152,226",
    ph: 0.08,
  },
  {
    from: [1.35, -1.82, 0.06],
    to: [1.35, -0.64, 0.05],
    strata: [0, 1],
    lbl: "Site Boundary",
    side: "r",
    col: "28,168,201",
    ph: 0.34,
  },
  {
    from: [-1.02, -0.26, 0.04],
    to: [-0.52, 0.52, 0.0],
    strata: [1, 2],
    lbl: "Authorized Scope",
    side: "l",
    col: "28,168,201",
    ph: 0.22,
  },
  {
    from: [1.02, -0.26, 0.04],
    to: [0.52, 0.52, 0.0],
    strata: [1, 2],
    lbl: "Digest Preview",
    side: "r",
    col: "56,152,226",
    ph: 0.56,
  },
  {
    from: [-0.46, 1.04, 0.0],
    to: [-0.46, 1.8, -0.04],
    strata: [2, 3],
    lbl: "Idempotent Outbox",
    side: "l",
    col: "56,152,226",
    ph: 0.14,
  },
  {
    from: [0.46, 1.8, -0.04],
    to: [0.46, 1.04, 0.0],
    strata: [3, 2],
    lbl: "ERP Read-Back",
    side: "r",
    col: "52,208,88",
    ph: 0.68,
  },
];

const FONT_SANS =
  '"SF Pro Display","Plus Jakarta Sans",-apple-system,"PingFang SC","Hiragino Sans GB",sans-serif';
const FONT_MONO = '"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace';

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
  ctx.lineWidth = 1.35;
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
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selectedStratum, setSelectedStratum] = useState<number>(2);
  const [hoveredStratum, setHoveredStratum] = useState<number | null>(null);

  const selectedRef = useRef<number>(selectedStratum);
  const hoveredRef = useRef<number | null>(hoveredStratum);
  selectedRef.current = selectedStratum;
  hoveredRef.current = hoveredStratum;

  const activeStratumIdx = hoveredStratum ?? selectedStratum;
  const activeMeta = STRATA_META[activeStratumIdx] ?? STRATA_META[2]!;

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
    const hitBoxes = SLABS.map(() => ({ x1: 0, y1: 0, x2: 0, y2: 0 }));
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
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const isCompact = compact || w < 520;
      const portrait = w < 480;
      const xComp = portrait ? 0.74 : 1;
      const scale = portrait
        ? Math.min(w / 5.4, h / 5.1)
        : Math.min(w / 6.2, h / 5.2);
      const cx0 = w * 0.5;
      const cy0 = h * (isCompact ? 0.52 : 0.51);

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

      // -----------------------------------------------------------------------
      // STRATUM 0: Receding 3D Perspective Tenant & Warehouse Grid (y = -1.85)
      // -----------------------------------------------------------------------
      const floorY = -1.85;
      const floorHot = focusIdx === 0;
      const floorAlpha = floorHot ? 0.95 : 0.62;

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
        const edgeFade = Math.max(0.15, 1 - Math.abs(gx) / 4.2);
        ctx.strokeStyle = `rgba(56,152,226,${(0.22 * edgeFade * floorAlpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (let gz = -1.0; gz <= 1.01; gz += 0.4) {
        const a = proj(-3.6, floorY, gz);
        const b = proj(3.6, floorY, gz);
        const edgeFade = Math.max(0.2, 1 - Math.abs(gz) / 1.4);
        ctx.strokeStyle = `rgba(28,168,201,${(0.18 * edgeFade * floorAlpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // Subtle architectural boundary crosshair ticks & site markers on floor
      const siteMarks: Array<{ x: number; label: string }> = [
        { x: -2.2, label: "HK01" },
        { x: 0, label: "RLS" },
        { x: 2.2, label: "HK02" },
      ];
      ctx.font = `500 ${isCompact ? 9.5 : 10.5}px ${FONT_MONO}`;
      ctx.textAlign = "center";
      siteMarks.forEach((mark) => {
        const p = proj(mark.x, floorY, 0.96);
        ctx.strokeStyle = `rgba(56,152,226,${(0.45 * floorAlpha).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - 5, p.y);
        ctx.lineTo(p.x + 5, p.y);
        ctx.moveTo(p.x, p.y - 4);
        ctx.lineTo(p.x, p.y + 4);
        ctx.stroke();

        ctx.fillStyle = floorHot
          ? "rgba(238,241,245,0.92)"
          : "rgba(186,204,224,0.68)";
        ctx.fillText(mark.label, p.x, p.y + 15);
      });

      // Subtle touch-down rings under Gate anchors
      [-1.35, 1.35].forEach((fx, fi) => {
        const fp = proj(fx, floorY, 0.06);
        const col = fi === 0 ? "56,152,226" : "28,168,201";
        for (let r = 0; r < 2; r++) {
          const ph = (time * 0.34 + fi * 0.45 + r * 0.5) % 1;
          ctx.strokeStyle = `rgba(${col},${((1 - ph) * 0.36 * floorAlpha).toFixed(3)})`;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.ellipse(
            fp.x,
            fp.y,
            (8 + ph * 34) * (scale / 110),
            (3 + ph * 12) * (scale / 110),
            0,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        }
      });
      ctx.restore();

      // -----------------------------------------------------------------------
      // Helper: Draw 3D Architectural Slab Prism (QZT glass-slate bevels)
      // -----------------------------------------------------------------------
      const drawSlab = (slab: SlabDef, slabIndex: number) => {
        const isPrimary = focusIdx === slab.stratumIdx;
        const isConnected =
          isPrimary ||
          CONDUITS.some(
            (c) =>
              c.strata.includes(focusIdx) && c.strata.includes(slab.stratumIdx),
          );
        const lift = elev[slab.stratumIdx] ?? 0;
        const yB = slab.y + lift;
        const yT = yB + slab.bh;
        const hw = slab.bw * 0.5;
        const hd = slab.bd * 0.5;

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
        ctx.globalAlpha = isPrimary ? 1 : isConnected ? 0.82 : 0.45;

        // Visible side thickness based on camera yaw
        if (yaw >= 0) {
          ctx.beginPath();
          ctx.moveTo(tl.x, tl.y);
          ctx.lineTo(fl.x, fl.y);
          ctx.lineTo(bfl.x, bfl.y);
          ctx.lineTo(btl.x, btl.y);
          ctx.closePath();
          ctx.fillStyle = slab.core
            ? "rgba(18,52,96,0.62)"
            : "rgba(13,22,36,0.72)";
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(tr.x, tr.y);
          ctx.lineTo(fr.x, fr.y);
          ctx.lineTo(bfr.x, bfr.y);
          ctx.lineTo(btr.x, btr.y);
          ctx.closePath();
          ctx.fillStyle = slab.core
            ? "rgba(18,52,96,0.62)"
            : "rgba(13,22,36,0.72)";
          ctx.fill();
        }

        // Front vertical thickness bezel (metallic carbon-sapphire depth)
        const gFront = ctx.createLinearGradient(fl.x, fl.y, bfl.x, bfl.y);
        gFront.addColorStop(
          0,
          slab.core
            ? "rgba(56,152,226,0.42)"
            : slab.canopy
              ? "rgba(28,168,201,0.38)"
              : "rgba(38,68,104,0.48)",
        );
        gFront.addColorStop(1, "rgba(7,11,18,0.95)");
        ctx.fillStyle = gFront;
        ctx.beginPath();
        ctx.moveTo(fl.x, fl.y);
        ctx.lineTo(fr.x, fr.y);
        ctx.lineTo(bfr.x, bfr.y);
        ctx.lineTo(bfl.x, bfl.y);
        ctx.closePath();
        ctx.fill();

        // Top translucent architectural deck
        const gTop = ctx.createLinearGradient(tl.x, tl.y, fr.x, fr.y);
        if (slab.core) {
          gTop.addColorStop(0, "rgba(56,152,226,0.28)");
          gTop.addColorStop(0.55, "rgba(19,49,90,0.40)");
          gTop.addColorStop(1, "rgba(10,20,36,0.58)");
        } else if (slab.canopy) {
          gTop.addColorStop(0, "rgba(28,168,201,0.16)");
          gTop.addColorStop(0.55, "rgba(18,40,68,0.28)");
          gTop.addColorStop(1, "rgba(52,208,88,0.14)");
        } else {
          gTop.addColorStop(0, "rgba(130,185,228,0.14)");
          gTop.addColorStop(1, "rgba(12,22,38,0.48)");
        }
        ctx.fillStyle = gTop;
        ctx.beginPath();
        ctx.moveTo(tl.x, tl.y);
        ctx.lineTo(tr.x, tr.y);
        ctx.lineTo(fr.x, fr.y);
        ctx.lineTo(fl.x, fl.y);
        ctx.closePath();
        ctx.fill();

        // Crisp illuminated top bevel rim (1px-1.6px, zero fuzzy bloom)
        ctx.strokeStyle = `rgba(${slab.accentRgb},${isPrimary ? 0.92 : slab.core ? 0.68 : 0.36})`;
        ctx.lineWidth = isPrimary ? 1.55 : slab.core ? 1.25 : 1.0;
        ctx.beginPath();
        ctx.moveTo(tl.x, tl.y);
        ctx.lineTo(tr.x, tr.y);
        ctx.lineTo(fr.x, fr.y);
        ctx.lineTo(fl.x, fl.y);
        ctx.closePath();
        ctx.stroke();

        // Precision front bottom hairline
        ctx.strokeStyle = "rgba(238,241,245,0.10)";
        ctx.lineWidth = 0.85;
        ctx.beginPath();
        ctx.moveTo(bfl.x, bfl.y);
        ctx.lineTo(bfr.x, bfr.y);
        ctx.stroke();

        // Physical sculptural micro-artifacts resting on each top deck
        if (slab.slabKey === "gate-left") {
          // 3 horizontal ACL layer bars (role, grant, site)
          const shift = Math.sin(time * 0.9) * 0.05;
          const bars: Array<[number, number, number, string]> = [
            [-0.58, 0.24, -0.22, "56,152,226"],
            [-0.46 + shift, 0.42 + shift, 0.0, "28,168,201"],
            [-0.52, 0.34, 0.22, "52,208,88"],
          ];
          bars.forEach(([x0, x1, zb, col]) => {
            const a = proj(slab.x + x0, yT + 0.04, zb);
            const b = proj(slab.x + x1, yT + 0.04, zb);
            ctx.strokeStyle = `rgba(${col},0.88)`;
            ctx.lineWidth = isCompact ? 2.6 : 3.2;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          });
        } else if (slab.slabKey === "gate-right") {
          // Active policy gate scan bar sweeping cleanly across deck
          const scanU = (Math.sin(time * 1.15) + 1) * 0.5;
          const sz = lerp(-hd * 0.72, hd * 0.72, scanU);
          const sa = proj(slab.x - hw * 0.78, yT + 0.03, sz);
          const sb = proj(slab.x + hw * 0.78, yT + 0.03, sz);
          ctx.strokeStyle = "rgba(28,168,201,0.92)";
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(sa.x, sa.y);
          ctx.lineTo(sb.x, sb.y);
          ctx.stroke();

          // Subtle static digest lock reference notches
          for (let k = -1; k <= 1; k++) {
            const np = proj(slab.x + k * 0.42, yT + 0.03, 0);
            ctx.fillStyle = "rgba(238,241,245,0.55)";
            ctx.fillRect(np.x - 1.5, np.y - 1.5, 3, 3);
          }
        } else if (slab.slabKey === "workbench") {
          // Core monolith: 2 crisp vertical optical ribs + center pulse node (zero glow blob)
          for (const ribX of [-0.52, 0.52]) {
            const r1 = proj(ribX, yT + 0.02, -hd * 0.76);
            const r2 = proj(ribX, yT + 0.02, hd * 0.76);
            ctx.strokeStyle = "rgba(180,224,255,0.34)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(r1.x, r1.y);
            ctx.lineTo(r2.x, r2.y);
            ctx.stroke();
          }
          const h1 = proj(-hw * 0.72, yT + 0.02, 0);
          const h2 = proj(hw * 0.72, yT + 0.02, 0);
          ctx.strokeStyle = "rgba(56,152,226,0.34)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(h1.x, h1.y);
          ctx.lineTo(h2.x, h2.y);
          ctx.stroke();

          const centerP = proj(0, yT + 0.03, 0);
          const pulse = 0.6 + 0.4 * Math.sin(time * 2.1);
          ctx.strokeStyle = `rgba(56,152,226,${pulse.toFixed(2)})`;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.arc(centerP.x, centerP.y, 5.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = "#EEF1F5";
          ctx.fillRect(centerP.x - 1.8, centerP.y - 1.8, 3.6, 3.6);
        } else if (slab.slabKey === "ledger") {
          // Top canopy: dual-phase telemetry wave (sin + cos) + 4 receipt step nodes
          ctx.beginPath();
          for (let k = 0; k <= 34; k++) {
            const u = k / 34;
            const wx = lerp(-hw * 0.84, hw * 0.84, u);
            const wz = -0.1 + Math.sin(u * 5.0 + time * 1.0) * 0.14;
            const wy = yT + 0.07 + Math.sin(u * 6.0 - time * 1.25) * 0.07;
            const wp = proj(wx, wy, wz);
            if (k === 0) ctx.moveTo(wp.x, wp.y);
            else ctx.lineTo(wp.x, wp.y);
          }
          ctx.strokeStyle = "rgba(56,152,226,0.9)";
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.beginPath();
          for (let k = 0; k <= 34; k++) {
            const u = k / 34;
            const wx = lerp(-hw * 0.84, hw * 0.84, u);
            const wz = 0.1 + Math.cos(u * 4.2 - time * 0.85) * 0.11;
            const wy = yT + 0.05 + Math.cos(u * 4.8 - time * 1.1) * 0.05;
            const wp = proj(wx, wy, wz);
            if (k === 0) ctx.moveTo(wp.x, wp.y);
            else ctx.lineTo(wp.x, wp.y);
          }
          ctx.strokeStyle = "rgba(52,208,88,0.86)";
          ctx.lineWidth = 1.3;
          ctx.stroke();

          const activeStep = Math.floor(time * 1.15) % 4;
          for (let k = 0; k < 4; k++) {
            const sp = proj(lerp(-1.12, 1.12, k / 3), yT + 0.03, hd * 0.56);
            ctx.fillStyle =
              k === activeStep ? "#34D058" : "rgba(238,241,245,0.45)";
            ctx.fillRect(sp.x - 2, sp.y - 2, 4, 4);
          }
        }

        // World-space crisp typography anchored cleanly without colliding with conduits
        const label = isCompact ? slab.shortTitle : slab.title;
        ctx.textAlign = "center";
        if (slab.canopy) {
          const p = proj(0, yT + 0.28, 0);
          ctx.font = `600 ${isCompact ? 11.5 : 13.5}px ${FONT_SANS}`;
          ctx.fillStyle = isPrimary ? "#34D058" : "#EEF1F5";
          ctx.fillText(label, p.x, p.y - 12);
          if (!isCompact) {
            ctx.font = `400 10.5px ${FONT_MONO}`;
            ctx.fillStyle = "rgba(186,204,224,0.78)";
            ctx.fillText(slab.sub, p.x, p.y + 4);
          }
        } else if (slab.core) {
          const pf = proj(0, yB + slab.bh * 0.54, hd);
          ctx.font = `600 ${isCompact ? 11.5 : 13.5}px ${FONT_SANS}`;
          ctx.fillStyle = isPrimary ? "#EEF1F5" : "rgba(238,241,245,0.92)";
          ctx.fillText(label, pf.x, pf.y + (isCompact ? 3 : -1));
          if (!isCompact) {
            ctx.font = `400 10px ${FONT_MONO}`;
            ctx.fillStyle = "rgba(164,212,252,0.88)";
            ctx.fillText(slab.sub, pf.x, pf.y + 13);
          }
        } else {
          const pf = proj(slab.x, yB + slab.bh * 0.5, hd);
          ctx.font = `500 ${isCompact ? 10 : 11.5}px ${FONT_SANS}`;
          ctx.fillStyle = isPrimary ? "#EEF1F5" : "rgba(238,241,245,0.86)";
          ctx.fillText(label, pf.x, pf.y + 3.5);
        }

        ctx.restore();
      };

      // -----------------------------------------------------------------------
      // Helper: Draw Directed Optical Conduits + Traveling Photon Streaks
      // -----------------------------------------------------------------------
      const drawConduits = (subset: readonly ConduitDef[]) => {
        subset.forEach((c) => {
          const hot = c.strata.includes(focusIdx);
          const liftA = c.strata[0] === 0 ? 0 : (elev[c.strata[0]] ?? 0);
          const liftB = c.strata[1] === 0 ? 0 : (elev[c.strata[1]] ?? 0);
          const a = proj(c.from[0], c.from[1] + liftA, c.from[2]);
          const b = proj(c.to[0], c.to[1] + liftB, c.to[2]);

          ctx.save();
          ctx.globalAlpha = hot ? 1 : 0.32;

          const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
          grad.addColorStop(0, `rgba(${c.col},0.22)`);
          grad.addColorStop(0.5, `rgba(${c.col},0.68)`);
          grad.addColorStop(1, `rgba(${c.col},0.36)`);
          ctx.strokeStyle = grad;
          ctx.lineWidth = hot ? 1.35 : 1.0;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();

          // Directional chevron at u = 0.86
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          drawChevron(
            ctx,
            lerp(a.x, b.x, 0.86),
            lerp(a.y, b.y, 0.86),
            ang,
            4.2,
            `rgba(${c.col},0.94)`,
          );

          // Crisp traveling photon streak (tail 0.15, zero radial glow blob)
          if (hot) {
            const u = (time * 0.36 + c.ph) % 1;
            const px = lerp(a.x, b.x, u);
            const py = lerp(a.y, b.y, u);
            const tx = lerp(a.x, b.x, Math.max(0, u - 0.15));
            const ty = lerp(a.y, b.y, Math.max(0, u - 0.15));
            const tg = ctx.createLinearGradient(tx, ty, px, py);
            tg.addColorStop(0, `rgba(${c.col},0)`);
            tg.addColorStop(1, "#EEF1F5");
            ctx.strokeStyle = tg;
            ctx.lineWidth = 2.0;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(px, py);
            ctx.stroke();
          }

          // Sparse monospace conduit label on wider viewports
          if (!isCompact && hot) {
            const mx = (a.x + b.x) * 0.5;
            const my = (a.y + b.y) * 0.5;
            ctx.font = `400 10px ${FONT_MONO}`;
            ctx.fillStyle = "rgba(186,204,224,0.82)";
            ctx.textAlign = c.side === "l" ? "right" : "left";
            ctx.fillText(c.lbl, c.side === "l" ? mx - 10 : mx + 10, my + 3);
          }

          ctx.restore();
        });
      };

      // Painter's order: floor conduits -> gate slabs -> gate-to-workbench -> workbench monolith -> top conduits -> ledger canopy
      drawConduits(CONDUITS.slice(0, 2));
      drawSlab(SLABS[0]!, 0);
      drawSlab(SLABS[1]!, 1);
      drawConduits(CONDUITS.slice(2, 4));
      drawSlab(SLABS[2]!, 2);
      drawConduits(CONDUITS.slice(4, 6));
      drawSlab(SLABS[3]!, 3);

      ctx.restore();
    };

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
        // Static high-DPI reference frame under prefers-reduced-motion
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
      for (let i = SLABS.length - 1; i >= 0; i--) {
        const b = hitBoxes[i];
        if (b && px >= b.x1 && px <= b.x2 && py >= b.y1 && py <= b.y2) {
          return SLABS[i]!.stratumIdx;
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
      camTarget.yaw = (px / Math.max(1, r.width) - 0.5) * 0.32; // ±0.16 rad
      camTarget.pitch = (py / Math.max(1, r.height) - 0.5) * 0.14; // ±0.07 rad
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

  // Trigger immediate static repaint when keyboard tab selection changes under reduced motion
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.dispatchEvent(new Event("resize"));
  }, [selectedStratum]);

  return (
    <div
      ref={stageRef}
      data-surface="obsidian-stage"
      className={[
        "relative flex h-full w-full flex-col justify-between overflow-hidden select-none",
        "bg-[linear-gradient(160deg,#070B12_0%,#0D1420_100%)] text-[#EEF1F5]",
        className,
      ].join(" ")}
    >
      {/* Top architectural coordinate header */}
      <div className="flex items-center justify-between border-b border-[rgba(238,241,245,0.09)] px-6 py-3.5 text-[11px] font-mono-code text-[rgba(238,241,245,0.56)]">
        <span>SME AIOS · ARCHITECTURAL RELAY</span>
        <span>4-STRATUM BOUNDARY · BFF ZERO-LEAK</span>
      </div>

      {/* 3D Perspective Canvas */}
      <div
        className={[
          "relative w-full flex-1",
          compact ? "min-h-[180px]" : "min-h-[360px]",
        ].join(" ")}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="block h-full w-full"
        />
      </div>

      {/* Accessible Stratum Index Tabs + Live Architectural Caption */}
      {!compact && (
        <div className="border-t border-[rgba(238,241,245,0.09)] bg-[rgba(7,11,18,0.65)] px-6 py-4">
          <div
            role="tablist"
            aria-label="AIOS 安全与执行架构层级"
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {STRATA_META.map((item) => {
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
                    "group flex flex-col items-start gap-0.5 pb-2 pt-1 text-left transition-colors duration-[120ms] cursor-pointer",
                    "border-b-[1.5px]",
                    active
                      ? "border-[#1CA8C9] text-[#EEF1F5]"
                      : "border-[rgba(238,241,245,0.12)] text-[rgba(238,241,245,0.56)] hover:text-[rgba(238,241,245,0.85)]",
                  ].join(" ")}
                >
                  <span className="font-mono-code text-[10.5px] tracking-[0.04em] text-[#3898E2]">
                    {item.code}
                  </span>
                  <span className="text-[12.5px] font-medium">
                    {item.tabLabel}
                  </span>
                </button>
              );
            })}
          </div>

          <div
            aria-live="polite"
            className="mt-3 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between"
          >
            <p className="text-[12.5px] text-[rgba(238,241,245,0.82)] leading-relaxed">
              <span className="font-medium text-[#EEF1F5]">
                {activeMeta.titleZh}
              </span>
              <span className="mx-2 text-[rgba(238,241,245,0.3)]">/</span>
              {activeMeta.detail}
            </p>
            <span className="shrink-0 font-mono-code text-[11px] text-[rgba(238,241,245,0.52)]">
              {activeMeta.caption}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
