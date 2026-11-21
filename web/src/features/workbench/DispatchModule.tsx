"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  PanelRight,
  Search,
  Truck,
} from "lucide-react";
import {
  callWorkbenchTool,
  generateIdempotencyKey,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { formatShortDigest } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { Proposal, ShipmentView } from "@/lib/types";
import { SYNTHETIC_DOCK_MILESTONES } from "@/features/workbench/types";

function defaultNextDeliveryDate(currentDate?: string): string {
  const base = currentDate ? new Date(`${currentDate}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) return "2026-12-20";
  base.setDate(base.getDate() + 3);
  return base.toISOString().slice(0, 10);
}

export function DispatchModule() {
  const { actor, capabilities, authGeneration, handleAccessChanged } =
    useSession();
  const { openDrawer } = useWorkbench();

  const readTool = useMemo(
    () => capabilities?.tools.find((t) => t.id === "shipment.read"),
    [capabilities],
  );
  const rescheduleTool = useMemo(
    () => capabilities?.tools.find((t) => t.id === "shipment.reschedule"),
    [capabilities],
  );

  const readWarehouses = useMemo(
    () => readTool?.warehouses ?? [],
    [readTool],
  );
  const rescheduleWarehouses = useMemo(
    () => rescheduleTool?.warehouses ?? [],
    [rescheduleTool],
  );

  const [warehouse, setWarehouse] = useState<string>("");
  const [shipmentId, setShipmentId] = useState<string>("SHP-1001");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<ApiError | null>(null);
  const [shipmentResult, setShipmentResult] = useState<{
    data: ShipmentView;
    source: string;
  } | null>(null);

  // Reschedule state
  const [newDeliveryDate, setNewDeliveryDate] = useState<string>("");
  const [rescheduleFingerprint, setRescheduleFingerprint] = useState<string>("");
  const [rescheduleIdemKey, setRescheduleIdemKey] = useState<string>("");
  const [rescheduleLoading, setRescheduleLoading] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<ApiError | null>(null);
  const [createdProposal, setCreatedProposal] = useState<Proposal | null>(null);

  useEffect(() => {
    if (readWarehouses.length === 0) {
      setWarehouse("");
      return;
    }
    setWarehouse((prev) =>
      prev && readWarehouses.includes(prev) ? prev : readWarehouses[0]!,
    );
  }, [readWarehouses]);

  useEffect(() => {
    if (warehouse === "HK02" && shipmentId === "SHP-1001") {
      setShipmentId("SHP-2001");
    } else if (warehouse === "HK01" && shipmentId === "SHP-2001") {
      setShipmentId("SHP-1001");
    }
  }, [warehouse, shipmentId]);

  useEffect(() => {
    setShipmentResult(null);
    setLookupError(null);
    setCreatedProposal(null);
    setRescheduleError(null);
    setRescheduleFingerprint("");
    setRescheduleIdemKey("");
  }, [authGeneration]);

  const handleLookupShipment = async (override?: {
    wh?: string;
    id?: string;
  }) => {
    const wh = override?.wh ?? warehouse;
    const id = (override?.id ?? shipmentId).trim();
    if (!wh || !id) return;
    setLookupLoading(true);
    setLookupError(null);
    setCreatedProposal(null);
    setRescheduleError(null);
    try {
      const res = await callWorkbenchTool({
        tool: "shipment.read",
        warehouse: wh,
        shipment_id: id,
      });
      if (res.kind === "result") {
        const view = res.data as ShipmentView;
        setShipmentResult({ data: view, source: res.source });
        setNewDeliveryDate(defaultNextDeliveryDate(view.delivery_date));
      }
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setShipmentResult(null);
          void handleAccessChanged();
        }
        setLookupError(err);
      }
    } finally {
      setLookupLoading(false);
    }
  };

  const handleSubmitReschedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shipmentResult || !newDeliveryDate) return;
    const targetWh = shipmentResult.data.warehouse;
    const targetId = shipmentResult.data.shipment_id;
    const fp = `${targetWh}:${targetId}:${newDeliveryDate}`;
    const idemKey =
      rescheduleFingerprint === fp && rescheduleIdemKey
        ? rescheduleIdemKey
        : generateIdempotencyKey("shp");
    setRescheduleFingerprint(fp);
    setRescheduleIdemKey(idemKey);

    setRescheduleLoading(true);
    setRescheduleError(null);
    setCreatedProposal(null);
    try {
      const res = await callWorkbenchTool(
        {
          tool: "shipment.reschedule",
          warehouse: targetWh,
          shipment_id: targetId,
          delivery_date: newDeliveryDate,
        },
        { idempotencyKey: idemKey },
      );
      if (res.kind === "proposal") {
        setCreatedProposal(res.proposal);
      }
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setCreatedProposal(null);
          void handleAccessChanged();
        }
        setRescheduleError(err);
      }
    } finally {
      setRescheduleLoading(false);
    }
  };

  const canRescheduleCurrent =
    shipmentResult !== null &&
    Boolean(rescheduleTool?.available) &&
    rescheduleWarehouses.includes(shipmentResult.data.warehouse);

  const visibleDockRows = useMemo(() => {
    const allowed = new Set(actor?.warehouses ?? readWarehouses);
    const filtered = SYNTHETIC_DOCK_MILESTONES.filter((m) =>
      allowed.has(m.warehouse),
    );
    return filtered.length > 0 ? filtered : SYNTHETIC_DOCK_MILESTONES;
  }, [actor?.warehouses, readWarehouses]);

  return (
    <div className="space-y-4" data-testid="workbench-dispatch-module">
      {/* Live Shipment Lookup & Reschedule Porcelain Sheet */}
      <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
              实时运单查询与改期提案
            </h2>
            <p className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
              仓库范围严格限定于服务端授权列表；改期提案自动绑定幂等键并进入独立主管审批。
            </p>
          </div>
          {readTool && <SourceTag source={readTool.source} />}
        </div>

        <div className="p-5 space-y-4">
          {readWarehouses.length === 0 ? (
            <AccessNoticeCard
              variant="ACCESS_RESTRICTED"
              title="暂无可用运单查询仓库"
              message="当前账号未获授权访问任何仓库的运单数据。"
            />
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleLookupShipment();
              }}
              className="flex flex-wrap items-end gap-3"
            >
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                  授权仓库
                </span>
                <select
                  value={warehouse}
                  onChange={(e) => setWarehouse(e.target.value)}
                  data-testid="dispatch-warehouse-select"
                  className="h-9 rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
                >
                  {readWarehouses.map((wh) => (
                    <option key={wh} value={wh}>
                      {wh}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block flex-1 min-w-[200px] space-y-1.5">
                <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                  运单编号
                </span>
                <input
                  type="text"
                  required
                  value={shipmentId}
                  onChange={(e) => setShipmentId(e.target.value)}
                  placeholder="例如 SHP-1001"
                  data-testid="dispatch-shipment-id-input"
                  className="h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[13px] text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
                />
              </label>

              <Button
                type="submit"
                variant="primary"
                loading={lookupLoading}
                data-testid="dispatch-lookup-btn"
              >
                <Search className="h-3.5 w-3.5" />
                <span>查询运单</span>
              </Button>

              <div className="flex items-center gap-1.5">
                {readWarehouses.includes("HK01") && (
                  <Button
                    size="sm"
                    pill
                    variant="secondary"
                    onClick={() => {
                      setWarehouse("HK01");
                      setShipmentId("SHP-1001");
                      void handleLookupShipment({ wh: "HK01", id: "SHP-1001" });
                    }}
                    className="font-mono-code"
                  >
                    HK01 · SHP-1001
                  </Button>
                )}
                {readWarehouses.includes("HK02") && (
                  <Button
                    size="sm"
                    pill
                    variant="secondary"
                    onClick={() => {
                      setWarehouse("HK02");
                      setShipmentId("SHP-2001");
                      void handleLookupShipment({ wh: "HK02", id: "SHP-2001" });
                    }}
                    className="font-mono-code"
                  >
                    HK02 · SHP-2001
                  </Button>
                )}
              </div>
            </form>
          )}

          {lookupError && (
            <AccessNoticeCard
              error={lookupError}
              authorizedWarehouses={
                lookupError.status === 403 ? readWarehouses : undefined
              }
              onSelectWarehouse={
                lookupError.status === 403
                  ? (wh) => {
                      setWarehouse(wh);
                      setLookupError(null);
                    }
                  : undefined
              }
            />
          )}

          {/* Live Shipment Detail + Reschedule Proposal Form */}
          {shipmentResult && (
            <div
              className="rounded-tile bg-[var(--bg-surface-tint)] p-4.5 space-y-4"
              data-testid="dispatch-shipment-result"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent)]">
                    <Truck className="h-4 w-4" strokeWidth={1.85} />
                  </span>
                  <span className="font-mono-code text-[14.5px] font-semibold text-[var(--ink-primary)]">
                    {shipmentResult.data.shipment_id}
                  </span>
                  <span className="rounded-full bg-[var(--bg-surface)] px-2.5 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]">
                    {shipmentResult.data.warehouse}
                  </span>
                  <StatusBadge status={shipmentResult.data.status} compact />
                  <SourceTag source={shipmentResult.source} />
                </div>
                <Button
                  size="sm"
                  pill
                  variant="secondary"
                  onClick={(e) =>
                    openDrawer(
                      {
                        kind: "shipment",
                        id: shipmentResult.data.shipment_id,
                        warehouse: shipmentResult.data.warehouse,
                        title: `运单详情 · ${shipmentResult.data.shipment_id}`,
                        meta: {
                          shipment: shipmentResult.data,
                          source: shipmentResult.source,
                        },
                      },
                      { tab: "current", trigger: e.currentTarget },
                    )
                  }
                >
                  <PanelRight className="h-3.5 w-3.5" />
                  <span>在右侧面板查看</span>
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-[12.5px]">
                <div className="rounded-sm bg-[var(--bg-surface)] px-3.5 py-2.5 shadow-[var(--shadow-subtle)]">
                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                    当前交付日期
                  </div>
                  <div className="mt-0.5 font-mono-code tabular-nums text-[14px] font-semibold text-[var(--ink-primary)]">
                    {shipmentResult.data.delivery_date}
                  </div>
                </div>
                <div className="rounded-sm bg-[var(--bg-surface)] px-3.5 py-2.5 shadow-[var(--shadow-subtle)]">
                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                    乐观版本锁
                  </div>
                  <div className="mt-0.5 font-mono-code tabular-nums text-[14px] font-semibold text-[var(--ink-primary)]">
                    v{shipmentResult.data.version}
                  </div>
                </div>
                <div className="rounded-sm bg-[var(--bg-surface)] px-3.5 py-2.5 shadow-[var(--shadow-subtle)]">
                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                    运单状态
                  </div>
                  <div className="mt-0.5 font-mono-code text-[14px] font-medium text-[var(--ink-primary)]">
                    {shipmentResult.data.status}
                  </div>
                </div>
              </div>

              {canRescheduleCurrent ? (
                <form
                  onSubmit={handleSubmitReschedule}
                  className="flex flex-wrap items-end gap-3 border-t border-[var(--hairline-subtle)] pt-3.5"
                  data-testid="dispatch-reschedule-form"
                >
                  <label className="block space-y-1.5">
                    <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                      拟调整交付日期（须不同于当前交期）
                    </span>
                    <input
                      type="date"
                      required
                      value={newDeliveryDate}
                      onChange={(e) => setNewDeliveryDate(e.target.value)}
                      data-testid="dispatch-reschedule-date-input"
                      className="h-9 rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
                    />
                  </label>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={rescheduleLoading}
                    disabled={
                      shipmentResult.data.status !== "OPEN" ||
                      newDeliveryDate === shipmentResult.data.delivery_date
                    }
                    data-testid="dispatch-reschedule-submit-btn"
                  >
                    <CalendarClock className="h-3.5 w-3.5" />
                    <span>提交运单改期提案</span>
                  </Button>
                </form>
              ) : (
                <p className="text-[12.5px] text-[var(--ink-muted)]">
                  当前账号对该仓库仅有运单只读查询权限，无法发起改期提案。
                </p>
              )}

              {rescheduleError && <AccessNoticeCard error={rescheduleError} />}

              {createdProposal && (
                <div
                  data-testid="dispatch-created-proposal"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-tile bg-[var(--status-emerald-wash)] p-3.5 text-[12.5px]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-[var(--status-emerald)]" />
                    <span className="font-medium text-[var(--ink-primary)]">
                      已生成改期提案{" "}
                      <span className="font-mono-code font-semibold">
                        {createdProposal.id}
                      </span>
                    </span>
                    <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-muted)]">
                      digest {formatShortDigest(createdProposal.digest)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      pill
                      variant="secondary"
                      onClick={(e) =>
                        openDrawer(
                          {
                            kind: "proposal",
                            id: createdProposal.id,
                            warehouse: createdProposal.warehouse,
                            title: `运单改期 · ${createdProposal.id}`,
                          },
                          { tab: "current", trigger: e.currentTarget },
                        )
                      }
                    >
                      右侧面板查看
                    </Button>
                    <Link
                      href={`/proposals/${encodeURIComponent(createdProposal.id)}`}
                      className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--accent)] px-3.5 text-[12px] font-medium text-white hover:bg-[var(--accent-hover)] transition-colors"
                    >
                      <span>打开详情</span>
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Clearly Labeled Synthetic Warehouse Dock Milestones */}
      <div
        className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden"
        data-testid="dispatch-synthetic-dock-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <h3 className="text-[14px] font-semibold text-[var(--ink-primary)]">
              仓库月台收发里程碑
            </h3>
            <SourceTag source="synthetic" />
          </div>
          <span className="text-[12px] text-[var(--ink-muted)]">
            演示用合成数据（待收待发 / 短收 / 破损 / 签收）
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[11.5px] text-[var(--ink-muted)]">
                <th className="px-4 py-2.5 font-medium">月台单号</th>
                <th className="px-3.5 py-2.5 font-medium">站点 / 泊位</th>
                <th className="px-3.5 py-2.5 font-medium">关联运单</th>
                <th className="px-3.5 py-2.5 font-medium">节点状态</th>
                <th className="px-3.5 py-2.5 font-medium text-right">
                  计划 / 实收件数
                </th>
                <th className="px-3.5 py-2.5 font-medium">现场备注</th>
                <th className="px-4 py-2.5 font-medium text-right">更新时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--hairline-subtle)]">
              {visibleDockRows.map((row) => {
                const badgeKey =
                  row.stage === "签收"
                    ? "VERIFIED"
                    : row.stage === "破损"
                      ? "NEEDS_OPERATOR"
                      : row.stage === "短收"
                        ? "OUTCOME_UNKNOWN"
                        : "OPEN";
                return (
                  <tr
                    key={row.id}
                    className="hover:bg-[var(--bg-surface-tint)]/80 transition-colors duration-[150ms]"
                  >
                    <td className="px-4 py-3 font-mono-code font-medium text-[var(--ink-primary)]">
                      {row.id}
                    </td>
                    <td className="px-3.5 py-3 font-mono-code text-[var(--ink-secondary)]">
                      {row.warehouse} · {row.dockBay}
                    </td>
                    <td className="px-3.5 py-3 font-mono-code text-[var(--ink-primary)]">
                      {row.shipmentRef}
                    </td>
                    <td className="px-3.5 py-3">
                      <StatusBadge
                        status={badgeKey}
                        label={row.stage}
                        compact
                      />
                    </td>
                    <td className="px-3.5 py-3 font-mono-code tabular-nums text-right text-[var(--ink-primary)]">
                      {row.plannedQty} /{" "}
                      <span
                        className={
                          row.actualQty < row.plannedQty
                            ? "font-semibold text-[var(--status-amber-ink)]"
                            : ""
                        }
                      >
                        {row.actualQty}
                      </span>
                    </td>
                    <td className="px-3.5 py-3 text-[var(--ink-secondary)]">
                      {row.note}
                    </td>
                    <td className="px-4 py-3 font-mono-code tabular-nums text-right text-[var(--ink-muted)]">
                      {row.updatedAt}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
