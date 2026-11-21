"use client";

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Crosshair, FileText } from "lucide-react";
import { formatShortDigest } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import type { OcrEvidence, OcrFieldEvidence } from "@/lib/types";

export interface OcrEvidenceViewerProps {
  intakeId: string;
  warehouse: string;
  evidence: OcrEvidence;
  /** Transient local object URL from createObjectUrlRegistry(); null when viewing historical saved intake */
  imageUrl: string | null;
  filename?: string | null;
  onPrepareDraft?: (overrides?: Record<string, string>) => Promise<void>;
  preparing?: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  po: "采购单号 (PO)",
  buyer: "买方编码 (Buyer)",
  delivery: "交付日期 (Delivery)",
  currency: "币种 (Currency)",
  total: "订单总额 (Total)",
  "line.1.sku": "第 1 行 · SKU",
  "line.1.quantity": "第 1 行 · 数量",
  "line.1.unit": "第 1 行 · 单位",
  "line.1.unit_price": "第 1 行 · 单价",
  "line.1.amount": "第 1 行 · 行金额",
  "line.2.sku": "第 2 行 · SKU",
  "line.2.quantity": "第 2 行 · 数量",
  "line.2.unit": "第 2 行 · 单位",
  "line.2.unit_price": "第 2 行 · 单价",
  "line.2.amount": "第 2 行 · 行金额",
};

const FOCUS_ORDER = [
  "po",
  "buyer",
  "delivery",
  "currency",
  "total",
  "line.1.sku",
  "line.1.quantity",
  "line.1.unit",
  "line.1.unit_price",
  "line.1.amount",
  "line.2.sku",
  "line.2.quantity",
  "line.2.unit",
  "line.2.unit_price",
  "line.2.amount",
];

function labelForField(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key]!;
  const lineMatch = /^line\.(\d+)\.(.+)$/.exec(key);
  if (lineMatch) {
    const [, idx, sub] = lineMatch;
    const subMap: Record<string, string> = {
      sku: "SKU",
      quantity: "数量",
      unit: "单位",
      unit_price: "单价",
      amount: "行金额",
    };
    return `第 ${idx} 行 · ${subMap[sub!] ?? sub}`;
  }
  return key;
}

function getBbox(
  field: OcrFieldEvidence | undefined,
): [number, number, number, number] | null {
  const bbox = field?.ocr?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [l, t, r, b] = bbox;
  if (
    typeof l !== "number" ||
    typeof t !== "number" ||
    typeof r !== "number" ||
    typeof b !== "number"
  ) {
    return null;
  }
  if (r <= l || b <= t) return null;
  return [l, t, r, b];
}

export function OcrEvidenceViewer({
  intakeId,
  warehouse,
  evidence,
  imageUrl,
  filename,
  onPrepareDraft,
  preparing = false,
}: OcrEvidenceViewerProps) {
  const orderedKeys = useMemo(() => {
    const keys = Object.keys(evidence.fields || {});
    const prioritized = FOCUS_ORDER.filter((k) => keys.includes(k));
    const remaining = keys
      .filter((k) => !prioritized.includes(k))
      .sort((a, b) => a.localeCompare(b));
    return [...prioritized, ...remaining];
  }, [evidence.fields]);

  const initialActive = useMemo(() => {
    if (evidence.review_fields.length > 0) return evidence.review_fields[0]!;
    return (
      orderedKeys.find((k) => getBbox(evidence.fields[k]) !== null) ??
      orderedKeys[0] ??
      ""
    );
  }, [evidence.review_fields, evidence.fields, orderedKeys]);

  const [selectedKey, setSelectedKey] = useState<string>(initialActive);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    setSelectedKey(initialActive);
    setHoveredKey(null);
    const seed: Record<string, string> = {};
    for (const k of evidence.review_fields) {
      seed[k] = evidence.fields[k]?.ocr?.value ?? "";
    }
    setOverrides(seed);
  }, [intakeId, initialActive, evidence.review_fields, evidence.fields]);

  const activeKey = hoveredKey ?? selectedKey;
  const activeField = activeKey ? evidence.fields[activeKey] : undefined;
  const activeBbox = getBbox(activeField);

  const bboxEntries = useMemo(() => {
    return orderedKeys
      .map((key) => ({
        key,
        field: evidence.fields[key]!,
        bbox: getBbox(evidence.fields[key]),
      }))
      .filter(
        (
          item,
        ): item is {
          key: string;
          field: OcrFieldEvidence;
          bbox: [number, number, number, number];
        } => item.bbox !== null,
      );
  }, [orderedKeys, evidence.fields]);

  const needsManualReview = evidence.review_fields.length > 0;

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === "ArrowDown" && idx < orderedKeys.length - 1) {
      e.preventDefault();
      setSelectedKey(orderedKeys[idx + 1]!);
    } else if (e.key === "ArrowUp" && idx > 0) {
      e.preventDefault();
      setSelectedKey(orderedKeys[idx - 1]!);
    }
  };

  const handleSubmitDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onPrepareDraft) return;
    if (needsManualReview) {
      await onPrepareDraft(overrides);
    } else {
      await onPrepareDraft(undefined);
    }
  };

  const imgW = Math.max(1, evidence.image_width || 1200);
  const imgH = Math.max(1, evidence.image_height || 940);

  return (
    <div
      className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]"
      data-testid="ocr-evidence-viewer"
    >
      {/* Left: Document Preview + Razor-Sharp SVG Bounding Box Overlay */}
      <div className="flex flex-col rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] px-4.5 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent)]">
              <FileText className="h-3.5 w-3.5" strokeWidth={1.85} />
            </span>
            <span className="truncate text-[13px] font-semibold text-[var(--ink-primary)]">
              {filename || `单据进件 ${intakeId}`}
            </span>
            <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 font-mono-code text-[10.5px] font-medium text-[var(--ink-secondary)]">
              {warehouse}
            </span>
          </div>
          <div className="flex items-center gap-2.5 font-mono-code tabular-nums text-[11px] text-[var(--ink-muted)]">
            <span>
              {imgW}×{imgH}px
            </span>
            <span>
              SHA-256 {formatShortDigest(evidence.artifact_sha256, 8, 4)}
            </span>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center bg-[var(--bg-surface-tint)] p-4">
          <div
            className="relative w-full overflow-hidden rounded-sm bg-[var(--bg-surface)] shadow-[var(--shadow-subtle)]"
            style={{ aspectRatio: imageUrl ? undefined : `${imgW} / ${imgH}` }}
          >
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt={filename || "单据原图预览"}
                data-testid="ocr-source-image"
                className="block h-auto w-full select-none"
              />
            ) : (
              <div
                data-testid="ocr-wireframe-fallback"
                className="flex h-full w-full flex-col items-center justify-center bg-[var(--bg-surface-tint)] p-6 text-center text-[12.5px] text-[var(--ink-muted)]"
              >
                <span className="font-semibold text-[var(--ink-secondary)]">
                  历史单据坐标视图
                </span>
                <span className="mt-1.5 max-w-[420px] leading-relaxed">
                  服务端仅持久化结构化证据与坐标（不留存原始图片字节），下方叠加层仍精确展示所有识别边界框。
                </span>
              </div>
            )}

            {/* Vector SVG Overlay drawing crisp 1.5px rectangles for every OCR field */}
            <svg
              viewBox={`0 0 ${imgW} ${imgH}`}
              preserveAspectRatio="none"
              aria-label="OCR 识别字段定位图层"
              data-testid="ocr-bbox-svg"
              className="absolute inset-0 h-full w-full"
            >
              {bboxEntries.map(({ key, field, bbox }) => {
                const [left, top, right, bottom] = bbox;
                const width = right - left;
                const height = bottom - top;
                const isActive = activeKey === key;
                const isSelected = selectedKey === key;
                const isDisputed = !field.confirmed;

                const stroke = isActive
                  ? isDisputed
                    ? "#B26200"
                    : "#1668E3"
                  : isDisputed
                    ? "rgba(178, 98, 0, 0.55)"
                    : "rgba(22, 104, 227, 0.34)";

                const fill = isActive
                  ? isDisputed
                    ? "rgba(178, 98, 0, 0.16)"
                    : "rgba(22, 104, 227, 0.14)"
                  : isSelected
                    ? "rgba(22, 104, 227, 0.08)"
                    : "rgba(22, 104, 227, 0.02)";

                return (
                  <rect
                    key={key}
                    x={left}
                    y={top}
                    width={width}
                    height={height}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isActive ? 2 : 1.5}
                    vectorEffect="non-scaling-stroke"
                    data-testid="ocr-bbox-rect"
                    data-field-key={key}
                    data-active={isActive ? "true" : "false"}
                    className="cursor-pointer transition-colors duration-[150ms]"
                    onMouseEnter={() => setHoveredKey(key)}
                    onMouseLeave={() => setHoveredKey(null)}
                    onClick={() => setSelectedKey(key)}
                  >
                    <title>
                      {labelForField(key)}:{" "}
                      {field.confirmed ?? field.ocr?.value ?? "—"}
                    </title>
                  </rect>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Active BBox Readout Footer */}
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline-subtle)] bg-[var(--bg-surface)] px-4.5 py-2.5 text-[12px]"
          data-testid="ocr-active-field-readout"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Crosshair
              className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
              strokeWidth={1.85}
            />
            <span className="text-[var(--ink-muted)] shrink-0">当前定位：</span>
            <span className="font-medium text-[var(--ink-primary)] truncate">
              {activeKey ? labelForField(activeKey) : "未选择字段"}
            </span>
            {activeField && (
              <span className="rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-mono-code font-semibold text-[var(--accent)] truncate">
                {activeField.confirmed ?? activeField.ocr?.value ?? "—"}
              </span>
            )}
          </div>
          <span className="font-mono-code tabular-nums text-[11px] text-[var(--ink-muted)]">
            {activeBbox ? `bbox [${activeBbox.join(", ")}]` : "无坐标区域"}
            {activeField?.ocr?.score != null
              ? ` · 置信 ${activeField.ocr.score.toFixed(1)}%`
              : ""}
          </span>
        </div>
      </div>

      {/* Right: Extracted Field Evidence Table + Draft Generation */}
      <div className="flex flex-col rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--hairline)] px-4.5 py-3">
          <span className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
            字段提取明细
          </span>
          <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 font-mono-code tabular-nums text-[11px] text-[var(--ink-muted)]">
            {evidence.reader_mode} · {orderedKeys.length} 字段
          </span>
        </div>

        <div className="flex-1 overflow-auto max-h-[460px]">
          <table className="w-full border-collapse text-left text-[12.5px]">
            <thead>
              <tr className="sticky top-0 border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[11.5px] text-[var(--ink-muted)]">
                <th className="px-4 py-2.5 font-medium">字段</th>
                <th className="px-3.5 py-2.5 font-medium">OCR 识别值</th>
                <th className="px-4 py-2.5 font-medium text-right">核验状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--hairline-subtle)]">
              {orderedKeys.map((key, idx) => {
                const field = evidence.fields[key]!;
                const isActive = activeKey === key;
                const isDisputed = !field.confirmed;
                return (
                  <tr
                    key={key}
                    data-testid="ocr-field-row"
                    data-field-key={key}
                    data-active={isActive ? "true" : "false"}
                    onMouseEnter={() => setHoveredKey(key)}
                    onMouseLeave={() => setHoveredKey(null)}
                    onClick={() => setSelectedKey(key)}
                    className={[
                      "transition-colors duration-[150ms] cursor-pointer",
                      isActive
                        ? "bg-[var(--accent-wash)]"
                        : isDisputed
                          ? "bg-[var(--status-amber-wash)]/55 hover:bg-[var(--status-amber-wash)]"
                          : "hover:bg-[var(--bg-surface-tint)]",
                    ].join(" ")}
                  >
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        onFocus={() => setSelectedKey(key)}
                        onKeyDown={(e) => handleKeyDown(e, idx)}
                        className="text-left font-medium text-[var(--ink-primary)] focus:outline-none cursor-pointer"
                      >
                        {labelForField(key)}
                      </button>
                      {field.ocr?.bbox && (
                        <div className="font-mono-code tabular-nums text-[10.5px] text-[var(--ink-muted)]">
                          [{field.ocr.bbox.join(", ")}]
                        </div>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 font-mono-code text-[var(--ink-primary)]">
                      <div>{field.ocr?.value ?? "—"}</div>
                      {field.vision.length > 0 && field.vision[0]?.value && (
                        <div className="text-[11px] text-[var(--ink-muted)]">
                          复核: {field.vision[0].value}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {field.confirmed ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-emerald-wash)] px-2 py-0.5 text-[11px] font-medium text-[var(--status-emerald)]">
                          <CheckCircle2 className="h-3 w-3" strokeWidth={1.85} />
                          <span>已确认</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-amber-wash)] px-2 py-0.5 text-[11px] font-medium text-[var(--status-amber-ink)]">
                          <AlertTriangle className="h-3 w-3" strokeWidth={1.85} />
                          <span>待人工复核</span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Review Overrides (if disputed) + Generate Proposal CTA */}
        {onPrepareDraft && (
          <form
            onSubmit={handleSubmitDraft}
            className="border-t border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-4 space-y-3"
          >
            {needsManualReview && (
              <div className="space-y-2.5 rounded-tile bg-[var(--status-amber-wash)] p-3.5">
                <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--status-amber-ink)]">
                  <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.85} />
                  <span>存在 OCR 争议字段，请对照左侧原图确认值：</span>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {evidence.review_fields.map((fieldKey) => (
                    <label
                      key={fieldKey}
                      className="block space-y-1 text-[11.5px]"
                    >
                      <span className="font-medium text-[var(--ink-primary)]">
                        {labelForField(fieldKey)}
                      </span>
                      <input
                        type="text"
                        required
                        maxLength={40}
                        value={overrides[fieldKey] ?? ""}
                        onFocus={() => setSelectedKey(fieldKey)}
                        onChange={(e) =>
                          setOverrides((prev) => ({
                            ...prev,
                            [fieldKey]: e.target.value,
                          }))
                        }
                        className="h-8.5 w-full rounded-sm border border-[var(--status-amber-border)] bg-[var(--bg-surface)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-mono-code text-[11.5px] text-[var(--ink-muted)]">
                进件号：{intakeId}
              </div>
              <Button
                type="submit"
                variant="primary"
                pill
                loading={preparing}
                disabled={!evidence.complete && !needsManualReview}
                data-testid="ocr-prepare-proposal-btn"
              >
                {needsManualReview
                  ? "提交复核值并生成提案"
                  : "基于核验结果生成销售草稿提案"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
