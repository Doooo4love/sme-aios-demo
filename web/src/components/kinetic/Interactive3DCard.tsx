"use client";

import React, { useEffect, useRef } from "react";

export type SheenIntensity = "none" | "subtle" | "medium";

export interface Interactive3DCardProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** Maximum tilt angle in degrees on each axis (size-damped on wide cards). Default: 3 */
  maxTilt?: number;
  /** Subtle upward hover lift in px (0 to disable). Default: -1.5 */
  hoverLiftPx?: number;
  /** Light-mode porcelain specular sheen intensity. Default: "subtle" */
  sheenIntensity?: SheenIntensity;
  /** When false, renders sheen-only hover with zero tilt and zero lift (ideal for static KPI tiles / canvas frames). Default: true */
  interactive?: boolean;
  /** Disable 3D tracking and sheen completely */
  disabled?: boolean;
}

const SHEEN_ALPHA: Record<SheenIntensity, number> = {
  none: 0,
  subtle: 0.44,
  medium: 0.6,
};

const SHEEN_ALPHA_DARK: Record<SheenIntensity, number> = {
  none: 0,
  subtle: 0.08,
  medium: 0.11,
};

const SETTLE_DURATION_MS = 260;

/** Approximates cubic-bezier(0.22, 1, 0.36, 1) cleanly for mid-settle re-entry continuity */
function easeOutQuintApprox(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3.2);
}

export const Interactive3DCard = React.forwardRef<
  HTMLDivElement,
  Interactive3DCardProps
>(function Interactive3DCard(
  {
    maxTilt = 3,
    hoverLiftPx = -1.5,
    sheenIntensity = "subtle",
    interactive = true,
    disabled = false,
    className = "",
    children,
    onPointerEnter,
    onPointerMove,
    onPointerLeave,
    style,
    ...rest
  },
  forwardedRef,
) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({
    active: false,
    raf: 0,
    lastTs: 0,
    curRx: 0,
    curRy: 0,
    curTy: 0,
    targetRx: 0,
    targetRy: 0,
    targetTy: 0,
    settling: false,
    settleStartMs: 0,
    settleFromRx: 0,
    settleFromRy: 0,
    settleFromTy: 0,
    canAnimate: false,
  });

  const setMergedRef = (node: HTMLDivElement | null) => {
    innerRef.current = node;
    if (typeof forwardedRef === "function") {
      forwardedRef(node);
    } else if (forwardedRef) {
      forwardedRef.current = node;
    }
  };

  useEffect(() => {
    const state = stateRef.current;
    if (typeof window === "undefined") return;

    const reducedMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fineMq = window.matchMedia("(pointer: fine)");

    const updateCapability = () => {
      state.canAnimate = !disabled && !reducedMq.matches && fineMq.matches;
      if (!state.canAnimate && innerRef.current) {
        if (state.raf) {
          cancelAnimationFrame(state.raf);
          state.raf = 0;
        }
        state.curRx = 0;
        state.curRy = 0;
        state.curTy = 0;
        state.targetRx = 0;
        state.targetRy = 0;
        state.targetTy = 0;
        state.settling = false;
        const el = innerRef.current;
        el.removeAttribute("data-settling");
        el.style.setProperty("--rx", "0deg");
        el.style.setProperty("--ry", "0deg");
        el.style.setProperty("--ty", "0px");
        el.style.setProperty("--sheen-opacity", "0");
      }
    };

    updateCapability();
    reducedMq.addEventListener("change", updateCapability);
    fineMq.addEventListener("change", updateCapability);

    return () => {
      if (state.raf) {
        cancelAnimationFrame(state.raf);
        state.raf = 0;
      }
      reducedMq.removeEventListener("change", updateCapability);
      fineMq.removeEventListener("change", updateCapability);
    };
  }, [disabled]);

  const clampedMaxTilt = interactive ? Math.max(0, Math.min(5, maxTilt)) : 0;
  const effectiveLiftPx = interactive && clampedMaxTilt > 0 ? hoverLiftPx : 0;

  const startLoop = () => {
    const state = stateRef.current;
    if (state.raf || !state.canAnimate || clampedMaxTilt === 0) return;
    state.lastTs = 0;

    const step = (now: number) => {
      state.raf = 0;
      const el = innerRef.current;
      if (!el || !state.active || !state.canAnimate) return;

      const dt = Math.min(0.05, state.lastTs ? (now - state.lastTs) / 1000 : 0.016);
      state.lastTs = now;
      const k = 1 - Math.exp(-dt * 14);

      state.curRx += (state.targetRx - state.curRx) * k;
      state.curRy += (state.targetRy - state.curRy) * k;
      state.curTy += (state.targetTy - state.curTy) * k;

      el.style.setProperty("--rx", `${state.curRx.toFixed(3)}deg`);
      el.style.setProperty("--ry", `${state.curRy.toFixed(3)}deg`);
      el.style.setProperty("--ty", `${state.curTy.toFixed(2)}px`);

      const settled =
        Math.abs(state.targetRx - state.curRx) < 0.01 &&
        Math.abs(state.targetRy - state.curRy) < 0.01 &&
        Math.abs(state.targetTy - state.curTy) < 0.02;

      if (!settled) {
        state.raf = requestAnimationFrame(step);
      }
    };

    state.raf = requestAnimationFrame(step);
  };

  const updatePointerTarget = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = innerRef.current;
    const state = stateRef.current;
    if (!el || !state.canAnimate || e.pointerType === "touch") return;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;

    if (clampedMaxTilt > 0) {
      const nx = Math.max(-1, Math.min(1, (relX - 0.5) * 2));
      const ny = Math.max(-1, Math.min(1, (relY - 0.5) * 2));
      // Size-aware damping so wide surfaces tilt subtly without feeling wobbly
      const sizeDamp = Math.min(1, 360 / Math.max(1, rect.width));
      const effectiveTilt = clampedMaxTilt * sizeDamp;

      state.targetRx = -ny * effectiveTilt;
      state.targetRy = nx * effectiveTilt;
      state.targetTy = effectiveLiftPx;
      startLoop();
    } else {
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
      el.style.setProperty("--ty", "0px");
    }

    if (sheenIntensity !== "none") {
      el.style.setProperty("--sheen-x", `${(relX * 100).toFixed(1)}%`);
      el.style.setProperty("--sheen-y", `${(relY * 100).toFixed(1)}%`);
      el.style.setProperty("--sheen-alpha", String(SHEEN_ALPHA[sheenIntensity]));
      el.style.setProperty(
        "--sheen-alpha-dark",
        String(SHEEN_ALPHA_DARK[sheenIntensity]),
      );
      el.style.setProperty("--sheen-opacity", "1");
    }
  };

  const handlePointerEnter = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = innerRef.current;
    const state = stateRef.current;
    if (el && state.canAnimate && e.pointerType !== "touch") {
      // Continuity guard: if re-entering mid-settle, capture exact current position before clearing CSS transition
      if (state.settling) {
        const elapsed = performance.now() - state.settleStartMs;
        if (elapsed < SETTLE_DURATION_MS) {
          const remaining = 1 - easeOutQuintApprox(elapsed / SETTLE_DURATION_MS);
          state.curRx = state.settleFromRx * remaining;
          state.curRy = state.settleFromRy * remaining;
          state.curTy = state.settleFromTy * remaining;
          el.style.setProperty("--rx", `${state.curRx.toFixed(3)}deg`);
          el.style.setProperty("--ry", `${state.curRy.toFixed(3)}deg`);
          el.style.setProperty("--ty", `${state.curTy.toFixed(2)}px`);
        } else {
          state.curRx = 0;
          state.curRy = 0;
          state.curTy = 0;
        }
        state.settling = false;
      }

      state.active = true;
      el.removeAttribute("data-settling");
      updatePointerTarget(e);
    }
    onPointerEnter?.(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (stateRef.current.active) {
      updatePointerTarget(e);
    }
    onPointerMove?.(e);
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = innerRef.current;
    const state = stateRef.current;
    state.active = false;
    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }

    state.settleFromRx = state.curRx;
    state.settleFromRy = state.curRy;
    state.settleFromTy = state.curTy;
    state.settleStartMs = performance.now();
    state.settling =
      Math.abs(state.curRx) > 0.01 ||
      Math.abs(state.curRy) > 0.01 ||
      Math.abs(state.curTy) > 0.02;

    state.curRx = 0;
    state.curRy = 0;
    state.curTy = 0;
    state.targetRx = 0;
    state.targetRy = 0;
    state.targetTy = 0;

    if (el) {
      el.setAttribute("data-settling", "true");
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
      el.style.setProperty("--ty", "0px");
      el.style.setProperty("--sheen-opacity", "0");
    }
    onPointerLeave?.(e);
  };

  return (
    <div
      ref={setMergedRef}
      onPointerEnter={handlePointerEnter}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={style}
      className={["aios-3d-card", className].join(" ")}
      {...rest}
    >
      {sheenIntensity !== "none" && !disabled && (
        <span aria-hidden="true" className="aios-3d-sheen" />
      )}
      {children}
    </div>
  );
});
