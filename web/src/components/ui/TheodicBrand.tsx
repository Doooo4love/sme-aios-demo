import React from "react";

const LOGO_ASPECT = 719 / 115;
const MARK_ASPECT = 225 / 115;
const DISPLAY_CLASS_RE =
  /\b(hidden|block|inline-block|inline|flex|inline-flex|grid|inline-grid|table)\b/;

export interface TheodicLogoProps {
  height?: number;
  className?: string;
  priority?: boolean;
}

export interface TheodicMarkProps {
  height?: number;
  className?: string;
}

export function TheodicLogo({
  height = 24,
  className = "",
  priority = false,
}: TheodicLogoProps) {
  const width = Math.round(height * LOGO_ASPECT);
  const displayClass = DISPLAY_CLASS_RE.test(className) ? "" : "inline-flex";
  const imgProps = {
    width,
    height,
    alt: "Theodic",
    draggable: false as const,
    loading: "eager" as const,
    decoding: (priority ? "sync" : "async") as "sync" | "async",
    fetchPriority: (priority ? "high" : undefined) as "high" | undefined,
    style: { height: `${height}px`, width: "auto" },
  };

  return (
    <span
      className={[
        displayClass,
        "shrink-0 items-center select-none",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/theodic-logo-dark.png"
        className="theodic-on-light shrink-0 object-contain select-none"
        {...imgProps}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/theodic-logo-light.png"
        className="theodic-on-dark shrink-0 object-contain select-none"
        {...imgProps}
      />
    </span>
  );
}

export function TheodicMark({
  height = 20,
  className = "",
}: TheodicMarkProps) {
  const width = Math.round(height * MARK_ASPECT);
  const displayClass = DISPLAY_CLASS_RE.test(className) ? "" : "inline-flex";
  const imgProps = {
    width,
    height,
    alt: "",
    "aria-hidden": true as const,
    draggable: false as const,
    loading: "eager" as const,
    decoding: "async" as const,
    style: { height: `${height}px`, width: "auto" },
  };

  return (
    <span
      className={[
        displayClass,
        "shrink-0 items-center select-none",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/theodic-mark-dark.png"
        className="theodic-on-light shrink-0 object-contain select-none"
        {...imgProps}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/theodic-mark-light.png"
        className="theodic-on-dark shrink-0 object-contain select-none"
        {...imgProps}
      />
    </span>
  );
}
