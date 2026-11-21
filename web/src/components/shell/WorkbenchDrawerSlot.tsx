"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  BarChart3,
  Calendar,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Inbox,
  Receipt,
  RefreshCw,
  Truck,
  X,
} from "lucide-react";
import {
  callWorkbenchTool,
  fetchBrief,
  fetchTasks,
  generateIdempotencyKey,
  getAuthGeneration,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import {
  formatProposalAction,
  formatShortDigest,
  formatUnixTime,
} from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type {
  BriefResponse,
  DrawerTab,
  IntakeDetail,
  InvoiceView,
  Proposal,
  ShipmentView,
  TaskItem,
  WarehouseDecisionSummary,
} from "@/lib/types";
import { fetchIntakeDetail } from "@/features/orders/api";
import { ProposalInspectorPanel } from "@/features/proposals/ProposalInspectorPanel";
import { AssuranceCaseInspector } from "@/features/workbench/AssurancePanel";

const DRAWER_TABS: ReadonlyArray<{ id: DrawerTab; label: string }> = [
  { id: "current", label: "当前对象" },
  { id: "assigned", label: "待我处理" },
  { id: "submitted", label: "已提交" },
];

export function WorkbenchDrawerSlot() {
  const { status, capabilities, authGeneration, handleAccessChanged } =
    useSession();
  const {
    drawerOpen,
    activeTab,
    selectedObject,
    customDrawerContent,
    closeDrawer,
    setActiveTab,
    openDrawer,
    setAssignedCount,
  } = useWorkbench();

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<ApiError | null>(null);

  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<ApiError | null>(null);

  const [intakeDetail, setIntakeDetail] = useState<IntakeDetail | null>(null);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [intakeError, setIntakeError] = useState<ApiError | null>(null);

  const [shipmentData, setShipmentData] = useState<{
    view: ShipmentView;
    source: string;
  } | null>(null);
  const [shipmentLoading, setShipmentLoading] = useState(false);
  const [shipmentError, setShipmentError] = useState<ApiError | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleBusy, setRescheduleBusy] = useState(false);
  const [rescheduleErr, setRescheduleErr] = useState<ApiError | null>(null);
  const [rescheduleProposal, setRescheduleProposal] = useState<Proposal | null>(
    null,
  );

  const [invoiceData, setInvoiceData] = useState<{
    view: InvoiceView;
    source: string;
  } | null>(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceError, setInvoiceError] = useState<ApiError | null>(null);

  const [summaryData, setSummaryData] = useState<{
    view: WarehouseDecisionSummary;
    source: string;
  } | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<ApiError | null>(null);

  // Move keyboard focus cleanly into the drawer header when opened
  useEffect(() => {
    if (drawerOpen) {
      requestAnimationFrame(() => {
        headingRef.current?.focus({ preventScroll: true });
      });
    }
  }, [drawerOpen]);

  // Reset ALL local drawer inspection state on authGeneration change
  useEffect(() => {
    setTasks([]);
    setTasksError(null);
    setBrief(null);
    setBriefError(null);
    setIntakeDetail(null);
    setIntakeError(null);
    setShipmentData(null);
    setShipmentError(null);
    setRescheduleProposal(null);
    setRescheduleErr(null);
    setInvoiceData(null);
    setInvoiceError(null);
    setSummaryData(null);
    setSummaryError(null);
  }, [authGeneration]);

  const loadLaneTasks = useCallback(
    async (lane: "assigned" | "submitted") => {
      if (status !== "authenticated") return;
      const startGen = getAuthGeneration();
      setTasksLoading(true);
      setTasksError(null);
      try {
        const res = await fetchTasks(lane, { limit: 25 });
        if (startGen !== getAuthGeneration()) return;
        setTasks(res.items);
        if (lane === "assigned") {
          setAssignedCount(res.items.length);
        }
      } catch (error) {
        if (isStaleAuthError(error) || startGen !== getAuthGeneration()) return;
        if (isApiError(error)) {
          if (error.code === "ACCESS_CHANGED") {
            setTasks([]);
            void handleAccessChanged();
          }
          setTasksError(error);
        }
      } finally {
        if (startGen === getAuthGeneration()) setTasksLoading(false);
      }
    },
    [status, setAssignedCount, handleAccessChanged],
  );

  // Load lane data when drawer opens on assigned / submitted tab
  useEffect(() => {
    if (!drawerOpen || status !== "authenticated") return;
    if (activeTab === "assigned" || activeTab === "submitted") {
      void loadLaneTasks(activeTab);
    }
  }, [drawerOpen, activeTab, status, loadLaneTasks]);

  const loadSelectedObject = useCallback(async () => {
    if (
      !drawerOpen ||
      activeTab !== "current" ||
      customDrawerContent ||
      !selectedObject ||
      status !== "authenticated"
    ) {
      return;
    }

    const startGen = getAuthGeneration();

    if (selectedObject.kind === "brief") {
      setBriefLoading(true);
      setBriefError(null);
      const now = new Date();
      const start = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        0,
        0,
        0,
      );
      const end = new Date(start.getTime() + 7 * 86_400_000);
      try {
        const data = await fetchBrief(start.toISOString(), end.toISOString());
        if (startGen === getAuthGeneration()) setBrief(data);
      } catch (error) {
        if (isStaleAuthError(error) || startGen !== getAuthGeneration()) return;
        if (isApiError(error)) setBriefError(error);
      } finally {
        if (startGen === getAuthGeneration()) setBriefLoading(false);
      }
      return;
    }

    if (selectedObject.kind === "intake") {
      setIntakeLoading(true);
      setIntakeError(null);
      setIntakeDetail(null);
      try {
        const data = await fetchIntakeDetail(selectedObject.id);
        if (startGen === getAuthGeneration()) setIntakeDetail(data);
      } catch (error) {
        if (isStaleAuthError(error) || startGen !== getAuthGeneration()) return;
        if (isApiError(error)) {
          if (error.code === "ACCESS_CHANGED") void handleAccessChanged();
          setIntakeError(error);
        }
      } finally {
        if (startGen === getAuthGeneration()) setIntakeLoading(false);
      }
      return;
    }

    if (selectedObject.kind === "shipment") {
      const wh = selectedObject.warehouse;
      setRescheduleProposal(null);
      setRescheduleErr(null);
      if (!wh) {
        const metaShip = selectedObject.meta?.shipment as
          | ShipmentView
          | undefined;
        if (metaShip) {
          setShipmentData({
            view: metaShip,
            source: String(selectedObject.meta?.source ?? "erp"),
          });
        }
        return;
      }
      setShipmentLoading(true);
      setShipmentError(null);
      try {
        const res = await callWorkbenchTool({
          tool: "shipment.read",
          warehouse: wh,
          shipment_id: selectedObject.id,
        });
        if (startGen !== getAuthGeneration()) return;
        if (res.kind === "result") {
          const view = res.data as ShipmentView;
          setShipmentData({ view, source: res.source });
          const next = new Date(`${view.delivery_date}T00:00:00`);
          if (!Number.isNaN(next.getTime())) {
            next.setDate(next.getDate() + 3);
            setRescheduleDate(next.toISOString().slice(0, 10));
          }
        }
      } catch (error) {
        if (isStaleAuthError(error) || startGen !== getAuthGeneration()) return;
        if (isApiError(error)) {
          if (error.code === "ACCESS_CHANGED") {
            setShipmentData(null);
            void handleAccessChanged();
          }
          setShipmentError(error);
        }
      } finally {
        if (startGen === getAuthGeneration()) setShipmentLoading(false);
      }
      return;
    }

    if (selectedObject.kind === "invoice") {
      const wh = selectedObject.warehouse;
      if (!wh) {
        const metaInv = selectedObject.meta?.invoice as InvoiceView | undefined;
        if (metaInv) {
          setInvoiceData({
            view: metaInv,
            source: String(selectedObject.meta?.source ?? "finance"),
          });
        }
        return;
      }
      setInvoiceLoading(true);
      setInvoiceError(null);
      try {
        const res = await callWorkbenchTool({
          tool: "finance.invoice.read",
          warehouse: wh,
          invoice_id: selectedObject.id,
        });
        if (startGen !== getAuthGeneration()) return;
        if (res.kind === "result") {
          setInvoiceData({
            view: res.data as InvoiceView,
            source: res.source,
          });
        }
      } catch (error) {
        if (isStaleAuthError(error) || startGen !== getAuthGeneration()) return;
        if (isApiError(error)) {
          if (error.code === "ACCESS_CHANGED") {
            setInvoiceData(null);
            void handleAccessChanged();
          }
          setInvoiceError(error);
        }
      } finally {
        if (startGen === getAuthGeneration()) setInvoiceLoading(false);
      }
      return;
    }

    if (selectedObject.kind === "summary") {
      const wh = selectedObject.warehouse || selectedObject.id;
      setSummaryLoading(true);
      setSummaryError(null);
      try {
        const res = await callWorkbenchTool({
          tool: "decision.warehouse.summary",
          warehouse: wh,
        });
        if (startGen !== getAuthGeneration()) return;
        if (res.kind === "result") {
          setSummaryData({
            view: res.data as WarehouseDecisionSummary,
            source: res.source,
          });
        }
      } catch (error) {
        if (isStaleAuthError(error) || startGen !== getAuthGeneration()) return;
        if (isApiError(error)) {
          if (error.code === "ACCESS_CHANGED") {
            setSummaryData(null);
            void handleAccessChanged();
          }
          setSummaryError(error);
        }
      } finally {
        if (startGen === getAuthGeneration()) setSummaryLoading(false);
      }
    }
  }, [
    drawerOpen,
    activeTab,
    customDrawerContent,
    selectedObject,
    status,
    handleAccessChanged,
  ]);

  useEffect(() => {
    void loadSelectedObject();
  }, [loadSelectedObject]);

  const canRescheduleDrawerShipment = useMemo(() => {
    if (!shipmentData || !capabilities) return false;
    const tool = capabilities.tools.find(
      (t) => t.id === "shipment.reschedule" && t.available,
    );
    return Boolean(tool?.warehouses.includes(shipmentData.view.warehouse));
  }, [shipmentData, capabilities]);

  const handleDrawerReschedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shipmentData || !rescheduleDate) return;
    setRescheduleBusy(true);
    setRescheduleErr(null);
    setRescheduleProposal(null);
    try {
      const res = await callWorkbenchTool(
        {
          tool: "shipment.reschedule",
          warehouse: shipmentData.view.warehouse,
          shipment_id: shipmentData.view.shipment_id,
          delivery_date: rescheduleDate,
        },
        { idempotencyKey: generateIdempotencyKey("drw-shp") },
      );
      if (res.kind === "proposal") {
        setRescheduleProposal(res.proposal);
      }
    } catch (error) {
      if (isStaleAuthError(error)) return;
      if (isApiError(error)) {
        if (error.code === "ACCESS_CHANGED") void handleAccessChanged();
        setRescheduleErr(error);
      }
    } finally {
      setRescheduleBusy(false);
    }
  };

  return (
    <>
      {/* Medium-viewport overlay scrim (768px - 1179px) */}
      {drawerOpen && (
        <div
          aria-hidden="true"
          onClick={() => closeDrawer({ restoreFocus: true })}
          className="fixed inset-0 z-30 bg-[var(--scrim)] xl:hidden"
        />
      )}

      <aside
        aria-label="业务核对面板"
        aria-hidden={!drawerOpen}
        data-testid="workbench-drawer"
        className={[
          "aios-drawer-transition flex flex-col bg-[var(--bg-sheet)] border-l border-[var(--hairline)] overflow-hidden",
          // Docked on wide desktop (>= 1280px / xl), slide-over overlay below xl
          "fixed bottom-0 right-0 top-[var(--topbar-h)] z-40 xl:static xl:z-auto xl:top-auto xl:bottom-auto xl:h-full",
          drawerOpen
            ? "w-[min(420px,92vw)] xl:w-[var(--drawer-w)] translate-x-0 opacity-100 shadow-[var(--shadow-popover)] xl:shadow-none"
            : "w-0 translate-x-full xl:translate-x-0 opacity-0 pointer-events-none border-l-0",
        ].join(" ")}
      >
        {/* Drawer Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--hairline)] px-4">
          <div className="min-w-0 flex items-center gap-2">
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="truncate text-[14.5px] font-semibold text-[var(--ink-primary)] focus:outline-none"
            >
              {selectedObject?.title && activeTab === "current"
                ? selectedObject.title
                : "业务工作面板"}
            </h2>
            {selectedObject?.warehouse && activeTab === "current" && (
              <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]">
                {selectedObject.warehouse}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <kbd className="hidden sm:inline-block rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--ink-muted)]">
              ESC
            </kbd>
            <button
              type="button"
              onClick={() => closeDrawer({ restoreFocus: true })}
              aria-label="收起业务面板"
              data-testid="workbench-drawer-close"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[var(--ink-muted)] hover:bg-[var(--bg-plane)] hover:text-[var(--ink-primary)] cursor-pointer"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {/* Hairline Segmented Tabs */}
        <div
          role="tablist"
          aria-label="业务面板视图"
          className="flex shrink-0 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-3"
        >
          {DRAWER_TABS.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`drawer-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={[
                  "relative px-3 py-2 text-[12.5px] font-medium transition-colors duration-[120ms] cursor-pointer",
                  "border-b-2 -mb-px",
                  active
                    ? "border-[var(--accent)] text-[var(--ink-primary)]"
                    : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                ].join(" ")}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Drawer Body */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {activeTab === "current" && (
            <>
              {customDrawerContent ? (
                customDrawerContent
              ) : !selectedObject ? (
                <div className="flex flex-col items-start gap-3 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-4">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--ink-primary)]">
                    <ClipboardCheck
                      className="h-4 w-4 text-[var(--accent)]"
                      strokeWidth={1.75}
                    />
                    <span>按需核对业务单据与证据</span>
                  </div>
                  <p className="text-[12.5px] text-[var(--ink-muted)] leading-relaxed">
                    在对话卡片、审批队列、进件页或业务模块中点击任意单据，即可在此处展开差异比对、摘要核验、正式确认动作或工作简报，同时保留主视图上下文与草稿。
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      openDrawer({
                        kind: "brief",
                        id: "brief-7d",
                        title: "工作简报（未来 7 天）",
                      })
                    }
                    className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-3 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-plane)] cursor-pointer"
                  >
                    <Calendar className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>查看工作简报</span>
                  </button>
                </div>
              ) : selectedObject.kind === "proposal" ? (
                <ProposalInspectorPanel
                  proposalId={selectedObject.id}
                  mode="drawer"
                />
              ) : selectedObject.kind === "assurance" ? (
                <AssuranceCaseInspector
                  reference={selectedObject.id}
                  compact
                />
              ) : selectedObject.kind === "intake" ? (
                <div className="space-y-3" data-testid="drawer-intake-inspector">
                  {intakeLoading && (
                    <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                      正在读取进件证据…
                    </div>
                  )}
                  {intakeError && <AccessNoticeCard error={intakeError} />}
                  {!intakeLoading && !intakeError && intakeDetail && (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText
                            className="h-4 w-4 shrink-0 text-[var(--accent)]"
                            strokeWidth={1.75}
                          />
                          <span className="truncate font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)]">
                            {selectedObject.id}
                          </span>
                        </div>
                        <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[11px]">
                          {intakeDetail.warehouse}
                        </span>
                      </div>

                      <dl className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] text-[12px]">
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">进件类型</dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            {intakeDetail.evidence.kind}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">证据摘要</dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            {formatShortDigest(
                              intakeDetail.evidence.artifact_sha256,
                            )}
                          </dd>
                        </div>
                        {intakeDetail.evidence.kind === "structured" && (
                          <>
                            <div className="flex justify-between gap-2 px-3 py-2">
                              <dt className="text-[var(--ink-muted)]">PO</dt>
                              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                                {intakeDetail.evidence.order.po}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2 px-3 py-2">
                              <dt className="text-[var(--ink-muted)]">买方</dt>
                              <dd className="font-mono-code text-[var(--ink-primary)]">
                                {intakeDetail.evidence.order.buyer}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2 px-3 py-2">
                              <dt className="text-[var(--ink-muted)]">总额</dt>
                              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                                {intakeDetail.evidence.order.currency}{" "}
                                {intakeDetail.evidence.order.total}
                              </dd>
                            </div>
                          </>
                        )}
                      </dl>

                      <Link
                        href={`/orders/new?intake=${encodeURIComponent(selectedObject.id)}`}
                        className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-[4px] bg-[var(--accent)] px-3 text-[13px] font-medium text-white hover:bg-[var(--accent-hover)]"
                      >
                        <span>在订单进件页查看完整证据</span>
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                    </>
                  )}
                </div>
              ) : selectedObject.kind === "shipment" ? (
                <div
                  className="space-y-3"
                  data-testid="drawer-shipment-inspector"
                >
                  {shipmentLoading && (
                    <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                      正在实时查询运单状态…
                    </div>
                  )}
                  {shipmentError && <AccessNoticeCard error={shipmentError} />}
                  {!shipmentLoading && !shipmentError && shipmentData && (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Truck className="h-4 w-4 text-[var(--accent)]" />
                          <span className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)]">
                            {shipmentData.view.shipment_id}
                          </span>
                          <StatusBadge status={shipmentData.view.status} compact />
                        </div>
                        <SourceTag source={shipmentData.source} />
                      </div>

                      <dl className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] text-[12px]">
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">仓库站点</dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            {shipmentData.view.warehouse}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">当前交期</dt>
                          <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                            {shipmentData.view.delivery_date}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">版本号</dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            v{shipmentData.view.version}
                          </dd>
                        </div>
                      </dl>

                      {canRescheduleDrawerShipment &&
                        shipmentData.view.status === "OPEN" && (
                          <form
                            onSubmit={handleDrawerReschedule}
                            className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3 space-y-2.5"
                          >
                            <div className="text-[12px] font-semibold text-[var(--ink-primary)]">
                              快捷发起改期提案
                            </div>
                            <input
                              type="date"
                              required
                              value={rescheduleDate}
                              onChange={(e) =>
                                setRescheduleDate(e.target.value)
                              }
                              className="h-8 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 font-mono-code text-[12px]"
                            />
                            <Button
                              type="submit"
                              size="sm"
                              variant="primary"
                              loading={rescheduleBusy}
                              disabled={
                                rescheduleDate ===
                                shipmentData.view.delivery_date
                              }
                              className="w-full"
                            >
                              <CalendarClock className="h-3.5 w-3.5" />
                              <span>提交改期提案</span>
                            </Button>
                          </form>
                        )}

                      {rescheduleErr && (
                        <AccessNoticeCard error={rescheduleErr} />
                      )}

                      {rescheduleProposal && (
                        <div className="rounded-[4px] border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] p-3 text-[12px] space-y-2">
                          <div className="flex items-center gap-1.5 font-medium text-[var(--status-emerald)]">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>
                              已生成提案 {rescheduleProposal.id}
                            </span>
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              openDrawer(
                                {
                                  kind: "proposal",
                                  id: rescheduleProposal.id,
                                  warehouse: rescheduleProposal.warehouse,
                                  title: `运单改期 · ${rescheduleProposal.id}`,
                                },
                                { tab: "current" },
                              )
                            }
                            className="w-full"
                          >
                            切换查看提案详情
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : selectedObject.kind === "invoice" ? (
                <div
                  className="space-y-3"
                  data-testid="drawer-invoice-inspector"
                >
                  {invoiceLoading && (
                    <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                      正在实时核验发票数据…
                    </div>
                  )}
                  {invoiceError && <AccessNoticeCard error={invoiceError} />}
                  {!invoiceLoading && !invoiceError && invoiceData && (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Receipt className="h-4 w-4 text-[var(--accent)]" />
                          <span className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)]">
                            {invoiceData.view.invoice_id}
                          </span>
                          <StatusBadge status={invoiceData.view.state} compact />
                        </div>
                        <SourceTag source={invoiceData.source} />
                      </div>
                      <dl className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] text-[12px]">
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">仓库站点</dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            {invoiceData.view.warehouse}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">发票金额</dt>
                          <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                            {invoiceData.view.currency} {invoiceData.view.amount}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3 py-2">
                          <dt className="text-[var(--ink-muted)]">结算状态</dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            {invoiceData.view.state}
                          </dd>
                        </div>
                      </dl>
                    </>
                  )}
                </div>
              ) : selectedObject.kind === "summary" ? (
                <div
                  className="space-y-3"
                  data-testid="drawer-summary-inspector"
                >
                  {summaryLoading && (
                    <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                      正在实时鉴权拉取站点汇总…
                    </div>
                  )}
                  {summaryError && <AccessNoticeCard error={summaryError} />}
                  {!summaryLoading && !summaryError && summaryData && (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <BarChart3 className="h-4 w-4 text-[var(--accent)]" />
                          <span className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)]">
                            {summaryData.view.warehouse}
                          </span>
                        </div>
                        <SourceTag source={summaryData.source} />
                      </div>
                      <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-4">
                        <div className="text-[11.5px] text-[var(--ink-muted)]">
                          在途未结运单 (open_shipments)
                        </div>
                        <div className="mt-1 font-mono-code text-[24px] font-semibold text-[var(--accent)]">
                          {summaryData.view.open_shipments}
                        </div>
                        <div className="mt-2 font-mono-code text-[11px] text-[var(--ink-muted)]">
                          统计基准日：{summaryData.view.as_of}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void loadSelectedObject()}
                        className="w-full"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>重新鉴权刷新</span>
                      </Button>
                    </>
                  )}
                </div>
              ) : selectedObject.kind === "brief" ? (
                <div className="space-y-3" data-testid="drawer-brief-inspector">
                  {briefLoading && (
                    <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                      正在汇总工作简报…
                    </div>
                  )}
                  {briefError && <AccessNoticeCard error={briefError} />}
                  {!briefLoading && !briefError && brief && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3">
                          <div className="text-[11.5px] text-[var(--ink-muted)]">
                            待我审批
                          </div>
                          <div className="mt-1 font-mono-code text-[20px] font-semibold text-[var(--ink-primary)]">
                            {brief.pending_approvals}
                            {brief.pending_approvals_capped ? "+" : ""}
                          </div>
                        </div>
                        <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3">
                          <div className="text-[11.5px] text-[var(--ink-muted)]">
                            未来 7 天会议
                          </div>
                          <div className="mt-1 font-mono-code text-[20px] font-semibold text-[var(--ink-primary)]">
                            {brief.meetings}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-[4px] border border-[var(--hairline)]">
                        <div className="border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--ink-secondary)]">
                          已提交单据状态分布
                        </div>
                        <div className="divide-y divide-[var(--hairline-subtle)]">
                          {Object.entries(brief.submitted_current_states)
                            .length === 0 ? (
                            <div className="px-3 py-4 text-center text-[12px] text-[var(--ink-muted)]">
                              暂无已提交记录
                            </div>
                          ) : (
                            Object.entries(brief.submitted_current_states).map(
                              ([stateKey, count]) => (
                                <div
                                  key={stateKey}
                                  className="flex items-center justify-between px-3 py-2 text-[12px]"
                                >
                                  <StatusBadge status={stateKey} compact />
                                  <span className="font-mono-code font-semibold text-[var(--ink-primary)]">
                                    {count}
                                  </span>
                                </div>
                              ),
                            )
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-2 font-mono-code text-[11px] text-[var(--ink-muted)]">
                        <span>快照：{formatUnixTime(brief.as_of)}</span>
                        <button
                          type="button"
                          onClick={() => void loadSelectedObject()}
                          className="text-[var(--accent)] hover:underline cursor-pointer"
                        >
                          刷新简报
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3.5 text-[12.5px] text-[var(--ink-secondary)]">
                  <div className="font-mono-code text-[11px] text-[var(--ink-muted)] uppercase">
                    {selectedObject.kind} · {selectedObject.id}
                  </div>
                  <div className="mt-1 font-medium text-[var(--ink-primary)]">
                    {selectedObject.title || selectedObject.id}
                  </div>
                </div>
              )}
            </>
          )}

          {(activeTab === "assigned" || activeTab === "submitted") && (
            <div className="space-y-2">
              {tasksLoading && (
                <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                  正在加载队列…
                </div>
              )}
              {tasksError && <AccessNoticeCard error={tasksError} />}
              {!tasksLoading && !tasksError && tasks.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-10 text-center text-[12.5px] text-[var(--ink-muted)]">
                  <Inbox className="h-5 w-5 opacity-60" strokeWidth={1.5} />
                  <span>
                    {activeTab === "assigned"
                      ? "当前没有待您审批的单据"
                      : "暂无已提交的单据"}
                  </span>
                </div>
              )}
              {!tasksLoading && !tasksError && tasks.length > 0 && (
                <div className="divide-y divide-[var(--hairline)] rounded-[4px] border border-[var(--hairline)]">
                  {tasks.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() =>
                        openDrawer(
                          {
                            kind: "proposal",
                            id: item.id,
                            warehouse: item.warehouse,
                            title: formatProposalAction(item.action),
                          },
                          { tab: "current" },
                        )
                      }
                      className="flex w-full flex-col gap-1.5 px-3 py-2.5 text-left hover:bg-[var(--bg-subtle)] transition-colors duration-[120ms] cursor-pointer"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono-code text-[12px] font-semibold text-[var(--ink-primary)] truncate">
                          {item.id}
                        </span>
                        <StatusBadge
                          status={
                            item.state === "REJECTED" &&
                            item.decision === "returned"
                              ? "returned"
                              : item.state
                          }
                          compact
                        />
                      </div>
                      <div className="flex items-center justify-between text-[11.5px] text-[var(--ink-muted)]">
                        <span>
                          {formatProposalAction(item.action)} ·{" "}
                          <span className="font-mono-code">
                            {item.warehouse}
                          </span>
                        </span>
                        <span className="font-mono-code">
                          {formatUnixTime(item.due)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <div className="pt-2">
                <Link
                  href="/work"
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)] hover:underline"
                >
                  <span>前往完整工作台列表</span>
                  <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                </Link>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
