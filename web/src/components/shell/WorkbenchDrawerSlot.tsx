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
import { formatLocalIsoDate, formatShortDigest } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { BriefProgressChain } from "@/components/kinetic/BriefProgressChain";
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

function defaultRescheduleDateFrom(deliveryDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deliveryDate.trim());
  if (match) {
    const y = Number(match[1]);
    const mo = Number(match[2]);
    const d = Number(match[3]);
    // Noon Hong Kong Time (04:00 UTC) avoids UTC midnight day-shift
    return formatLocalIsoDate(new Date(Date.UTC(y, mo - 1, d + 3, 4, 0, 0)));
  }
  const parsed = new Date(deliveryDate);
  if (!Number.isNaN(parsed.getTime())) {
    return formatLocalIsoDate(new Date(parsed.getTime() + 3 * 86_400_000));
  }
  return formatLocalIsoDate(new Date(Date.now() + 3 * 86_400_000));
}

export function WorkbenchDrawerSlot() {
  const {
    tx,
    formatDateTime,
    formatCurrency,
    localizeAction,
    localizeStatus,
  } = useLocale();
  const { status, actor, capabilities, authGeneration, handleAccessChanged } =
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

  const drawerTabs = useMemo<ReadonlyArray<{ id: DrawerTab; label: string }>>(
    () => [
      {
        id: "current",
        label: tx({
          "zh-CN": "当前对象",
          "zh-HK": "當前對象",
          en: "Current",
        }),
      },
      {
        id: "assigned",
        label: tx({
          "zh-CN": "待我处理",
          "zh-HK": "待我處理",
          en: "Assigned",
        }),
      },
      {
        id: "submitted",
        label: tx({
          "zh-CN": "已提交",
          "zh-HK": "已提交",
          en: "Submitted",
        }),
      },
    ],
    [tx],
  );

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

  useEffect(() => {
    if (drawerOpen) {
      requestAnimationFrame(() => {
        headingRef.current?.focus({ preventScroll: true });
      });
    }
  }, [drawerOpen]);

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
          setRescheduleDate(defaultRescheduleDateFrom(view.delivery_date));
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
      (tItem) => tItem.id === "shipment.reschedule" && tItem.available,
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

  const defaultDrawerHeading = tx({
    "zh-CN": "业务核对面板",
    "zh-HK": "業務核對面板",
    en: "Business Inspector",
  });

  return (
    <>
      {drawerOpen && (
        <div
          aria-hidden="true"
          onClick={() => closeDrawer({ restoreFocus: true })}
          className="fixed inset-0 z-30 bg-[var(--scrim)] backdrop-blur-[3px] transition-opacity duration-[180ms] xl:hidden"
        />
      )}

      <aside
        aria-label={defaultDrawerHeading}
        aria-hidden={!drawerOpen}
        data-testid="workbench-drawer"
        className={[
          "aios-drawer-transition flex flex-col bg-[var(--bg-surface)]/95 backdrop-blur-2xl overflow-hidden",
          // Frosted Porcelain / Obsidian Slide-Over (380-420px): floating below xl, docked with crisp hairline border >= xl
          "fixed bottom-2.5 right-2.5 top-2.5 z-40 rounded-card border border-[var(--hairline-strong)] xl:static xl:z-auto xl:top-auto xl:bottom-auto xl:right-auto xl:h-full xl:rounded-none xl:border-y-0 xl:border-r-0 xl:border-l xl:border-[var(--hairline)]",
          drawerOpen
            ? "w-[min(420px,calc(100vw-20px))] xl:w-[clamp(380px,30vw,420px)] translate-x-0 opacity-100 shadow-[var(--shadow-modal)] xl:shadow-[var(--shadow-floating)]"
            : "w-0 translate-x-[calc(100%+16px)] xl:translate-x-0 opacity-0 pointer-events-none xl:border-l-0",
        ].join(" ")}
      >
        {/* Frosted Drawer Header */}
        <div className="flex h-[56px] shrink-0 items-center justify-between border-b border-[var(--hairline)] px-5">
          <div className="min-w-0 flex items-center gap-2">
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)] focus:outline-none"
            >
              {selectedObject?.title && activeTab === "current"
                ? selectedObject.title
                : defaultDrawerHeading}
            </h2>
            {selectedObject?.warehouse && activeTab === "current" && (
              <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 font-mono-code text-[10.5px] font-medium text-[var(--ink-secondary)]">
                {selectedObject.warehouse}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <kbd className="hidden sm:inline-block rounded-xs bg-[var(--bg-surface-subtle)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--ink-muted)]">
              ESC
            </kbd>
            <button
              type="button"
              onClick={() => closeDrawer({ restoreFocus: true })}
              aria-label={tx({
                "zh-CN": "收起业务面板",
                "zh-HK": "收合業務面板",
                en: "Close inspector drawer",
              })}
              data-testid="workbench-drawer-close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors duration-[150ms] cursor-pointer"
            >
              <X className="h-4 w-4" strokeWidth={1.85} />
            </button>
          </div>
        </div>

        {/* Clean Segmented Tabs: 当前对象 | 待我处理 | 已提交 */}
        <div className="shrink-0 border-b border-[var(--hairline)] px-4 py-2.5">
          <div
            role="tablist"
            aria-label={tx({
              "zh-CN": "业务面板视图",
              "zh-HK": "業務面板檢視",
              en: "Inspector drawer views",
            })}
            className="grid grid-cols-3 gap-1 rounded-full bg-[var(--bg-surface-subtle)] p-1"
          >
            {drawerTabs.map((tab) => {
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
                    "rounded-full px-2.5 py-1.5 text-[12px] transition-all duration-[160ms] cursor-pointer",
                    active
                      ? "bg-[var(--bg-surface)] text-[var(--accent-ink)] font-semibold shadow-[var(--shadow-subtle)]"
                      : "text-[var(--ink-muted)] font-medium hover:text-[var(--ink-primary)]",
                  ].join(" ")}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Drawer Body */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {activeTab === "current" && (
            <>
              {customDrawerContent ? (
                customDrawerContent
              ) : !selectedObject ? (
                <div className="flex flex-col items-start gap-3 rounded-tile bg-[var(--bg-surface-tint)] p-4.5">
                  <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--ink-primary)]">
                    <ClipboardCheck
                      className="h-4 w-4 text-[var(--accent)]"
                      strokeWidth={1.85}
                    />
                    <span>
                      {tx({
                        "zh-CN": "按需核对业务单据与证据",
                        "zh-HK": "按需核對業務單據與憑證",
                        en: "Inspect Records & Evidence On Demand",
                      })}
                    </span>
                  </div>
                  <p className="text-[12.5px] text-[var(--ink-muted)] leading-relaxed">
                    {tx({
                      "zh-CN":
                        "在对话卡片、审批队列、进件页或业务模块中点击任意单据，即可在此展开差异比对、摘要核验、正式确认动作或工作简报，同时保留当前对话上下文。",
                      "zh-HK":
                        "在對話卡片、審批佇列、進件頁或業務模組中點擊任意單據，即可在此展開差異比對、摘要核驗、正式確認操作或工作簡報，同時保留目前對話上下文。",
                      en: "Click any record from chat, queues, intake, or workbench modules to inspect diffs, verify digests, take formal actions, or view your 7-day brief without losing context.",
                    })}
                  </p>
                  <Button
                    size="sm"
                    pill
                    variant="secondary"
                    onClick={() =>
                      openDrawer({
                        kind: "brief",
                        id: "brief-7d",
                        title: tx({
                          "zh-CN": "工作简报（未来 7 天）",
                          "zh-HK": "工作簡報（未來 7 天）",
                          en: "Work Brief (Next 7 Days)",
                        }),
                      })
                    }
                  >
                    <Calendar
                      className="h-3.5 w-3.5 text-[var(--accent)]"
                      strokeWidth={1.85}
                    />
                    <span>
                      {tx({
                        "zh-CN": "查看工作简报",
                        "zh-HK": "檢視工作簡報",
                        en: "View Work Brief",
                      })}
                    </span>
                  </Button>
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
                      {tx({
                        "zh-CN": "正在读取进件证据…",
                        "zh-HK": "正在讀取進件憑證…",
                        en: "Loading intake evidence…",
                      })}
                    </div>
                  )}
                  {intakeError && <AccessNoticeCard error={intakeError} />}
                  {!intakeLoading && !intakeError && intakeDetail && (
                    <>
                      <BriefProgressChain
                        phase="done"
                        summaryLabel={tx({
                          "zh-CN": "进件证据核验明细",
                          "zh-HK": "進件憑證核驗明細",
                          en: "Intake Evidence Check",
                        })}
                        steps={[
                          {
                            id: "intake-scope",
                            label: tx(
                              {
                                "zh-CN": "仓库与读取权限已校验（{wh}）",
                                "zh-HK": "倉庫與讀取權限已校驗（{wh}）",
                                en: "Warehouse & read scope verified ({wh})",
                              },
                              { wh: intakeDetail.warehouse },
                            ),
                            status: "done",
                          },
                          {
                            id: "intake-sha",
                            label: tx({
                              "zh-CN": "已核对内容寻址证据摘要",
                              "zh-HK": "已核對內容定址憑證摘要",
                              en: "Content-addressed artifact digest matched",
                            }),
                            status: "done",
                            meta: formatShortDigest(
                              intakeDetail.evidence.artifact_sha256,
                            ),
                          },
                        ]}
                      />

                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText
                            className="h-4 w-4 shrink-0 text-[var(--accent)]"
                            strokeWidth={1.85}
                          />
                          <span
                            title={selectedObject.id}
                            className="truncate font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)]"
                          >
                            {formatShortDigest(selectedObject.id, 6, 4)}
                          </span>
                        </div>
                        <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)]">
                          {intakeDetail.warehouse}
                        </span>
                      </div>

                      <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] text-[12.5px]">
                        <div className="flex justify-between gap-2 px-3.5 py-2.5">
                          <dt className="text-[var(--ink-muted)]">
                            {tx({
                              "zh-CN": "进件类型",
                              "zh-HK": "進件類型",
                              en: "Intake Type",
                            })}
                          </dt>
                          <dd className="text-[var(--ink-primary)]">
                            {intakeDetail.evidence.kind === "structured"
                              ? tx({
                                  "zh-CN": "结构化进件",
                                  "zh-HK": "結構化進件",
                                  en: "Structured PO",
                                })
                              : tx({
                                  "zh-CN": "图片 OCR 进件",
                                  "zh-HK": "圖片 OCR 進件",
                                  en: "Image OCR",
                                })}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3.5 py-2.5">
                          <dt className="text-[var(--ink-muted)]">
                            {tx({
                              "zh-CN": "证据摘要",
                              "zh-HK": "憑證摘要",
                              en: "Artifact Digest",
                            })}
                          </dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            {formatShortDigest(
                              intakeDetail.evidence.artifact_sha256,
                            )}
                          </dd>
                        </div>
                        {intakeDetail.evidence.kind === "structured" && (
                          <>
                            <div className="flex justify-between gap-2 px-3.5 py-2.5">
                              <dt className="text-[var(--ink-muted)]">PO</dt>
                              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                                {intakeDetail.evidence.order.po}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2 px-3.5 py-2.5">
                              <dt className="text-[var(--ink-muted)]">
                                {tx({
                                  "zh-CN": "买方",
                                  "zh-HK": "買方",
                                  en: "Buyer",
                                })}
                              </dt>
                              <dd className="font-mono-code text-[var(--ink-primary)]">
                                {intakeDetail.evidence.order.buyer}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2 px-3.5 py-2.5">
                              <dt className="text-[var(--ink-muted)]">
                                {tx({
                                  "zh-CN": "总额",
                                  "zh-HK": "總額",
                                  en: "Total",
                                })}
                              </dt>
                              <dd className="font-mono-code tabular-nums font-semibold text-[var(--ink-primary)]">
                                {formatCurrency(
                                  intakeDetail.evidence.order.total,
                                  intakeDetail.evidence.order.currency,
                                )}
                              </dd>
                            </div>
                          </>
                        )}
                      </dl>

                      <Link
                        href={`/orders/new?intake=${encodeURIComponent(selectedObject.id)}`}
                        className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-[var(--accent-solid)] px-4 text-[13px] font-medium text-[var(--accent-fg)] shadow-[var(--shadow-subtle)] hover:bg-[var(--accent-solid-hover)] transition-all duration-[160ms]"
                      >
                        <span>
                          {tx({
                            "zh-CN": "在订单进件页查看完整证据",
                            "zh-HK": "在訂單進件頁檢視完整憑證",
                            en: "View Full Evidence in Order Intake",
                          })}
                        </span>
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
                      {tx({
                        "zh-CN": "正在实时查询运单状态…",
                        "zh-HK": "正在即時查詢運單狀態…",
                        en: "Fetching live shipment status…",
                      })}
                    </div>
                  )}
                  {shipmentError && <AccessNoticeCard error={shipmentError} />}
                  {!shipmentLoading && !shipmentError && shipmentData && (
                    <>
                      <BriefProgressChain
                        phase="done"
                        summaryLabel={tx({
                          "zh-CN": "运单实时核验明细",
                          "zh-HK": "運單即時核驗明細",
                          en: "Live Shipment Check",
                        })}
                        steps={[
                          {
                            id: "ship-scope",
                            label: tx(
                              {
                                "zh-CN": "仓库范围鉴权通过（{wh}）",
                                "zh-HK": "倉庫範圍鑑權通過（{wh}）",
                                en: "Warehouse scope authorized ({wh})",
                              },
                              { wh: shipmentData.view.warehouse },
                            ),
                            status: "done",
                          },
                          {
                            id: "ship-read",
                            label: tx({
                              "zh-CN": "已拉取最新交期与版本锁",
                              "zh-HK": "已拉取最新交期與版本鎖",
                              en: "Fetched live delivery date & version lock",
                            }),
                            status: "done",
                            meta: `v${shipmentData.view.version}`,
                          },
                        ]}
                      />

                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Truck className="h-4 w-4 text-[var(--accent)]" />
                          <span className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)]">
                            {shipmentData.view.shipment_id}
                          </span>
                          <StatusBadge
                            status={shipmentData.view.status}
                            compact
                          />
                        </div>
                        <SourceTag source={shipmentData.source} />
                      </div>

                      <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] text-[12.5px]">
                        <div className="flex justify-between gap-2 px-3.5 py-2.5">
                          <dt className="text-[var(--ink-muted)]">
                            {tx({
                              "zh-CN": "仓库",
                              "zh-HK": "倉庫",
                              en: "Warehouse",
                            })}
                          </dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            {shipmentData.view.warehouse}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3.5 py-2.5">
                          <dt className="text-[var(--ink-muted)]">
                            {tx({
                              "zh-CN": "当前交期",
                              "zh-HK": "目前交期",
                              en: "Delivery Date",
                            })}
                          </dt>
                          <dd className="font-mono-code tabular-nums font-semibold text-[var(--ink-primary)]">
                            {shipmentData.view.delivery_date}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3.5 py-2.5">
                          <dt className="text-[var(--ink-muted)]">
                            {tx({
                              "zh-CN": "版本号",
                              "zh-HK": "版本號",
                              en: "Version",
                            })}
                          </dt>
                          <dd className="font-mono-code tabular-nums text-[var(--ink-primary)]">
                            v{shipmentData.view.version}
                          </dd>
                        </div>
                      </dl>

                      {canRescheduleDrawerShipment &&
                        shipmentData.view.status === "OPEN" && (
                          <form
                            onSubmit={handleDrawerReschedule}
                            className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5 space-y-2.5"
                          >
                            <div className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
                              {tx({
                                "zh-CN": "快捷发起改期提案",
                                "zh-HK": "快捷發起改期提案",
                                en: "Quick Reschedule Proposal",
                              })}
                            </div>
                            <input
                              type="date"
                              required
                              value={rescheduleDate}
                              onChange={(e) =>
                                setRescheduleDate(e.target.value)
                              }
                              className="h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none"
                            />
                            <Button
                              type="submit"
                              size="sm"
                              pill
                              variant="primary"
                              loading={rescheduleBusy}
                              disabled={
                                rescheduleDate ===
                                shipmentData.view.delivery_date
                              }
                              className="w-full"
                            >
                              <CalendarClock className="h-3.5 w-3.5" />
                              <span>
                                {tx({
                                  "zh-CN": "提交改期提案",
                                  "zh-HK": "提交改期提案",
                                  en: "Submit Reschedule Proposal",
                                })}
                              </span>
                            </Button>
                          </form>
                        )}

                      {rescheduleErr && (
                        <AccessNoticeCard error={rescheduleErr} />
                      )}

                      {rescheduleProposal && (
                        <div className="rounded-tile bg-[var(--status-emerald-wash)] p-3.5 text-[12.5px] space-y-2.5">
                          <div className="flex items-center gap-1.5 font-medium text-[var(--status-emerald)]">
                            <CheckCircle2 className="h-4 w-4" />
                            <span>
                              {tx(
                                {
                                  "zh-CN": "已生成提案 {id}",
                                  "zh-HK": "已產生提案 {id}",
                                  en: "Created proposal {id}",
                                },
                                {
                                  id: formatShortDigest(
                                    rescheduleProposal.id,
                                    6,
                                    4,
                                  ),
                                },
                              )}
                            </span>
                          </div>
                          <Button
                            size="sm"
                            pill
                            variant="secondary"
                            onClick={() =>
                              openDrawer(
                                {
                                  kind: "proposal",
                                  id: rescheduleProposal.id,
                                  warehouse: rescheduleProposal.warehouse,
                                  title: tx(
                                    {
                                      "zh-CN": "运单改期 · {id}",
                                      "zh-HK": "運單改期 · {id}",
                                      en: "Reschedule · {id}",
                                    },
                                    {
                                      id: formatShortDigest(
                                        rescheduleProposal.id,
                                        6,
                                        4,
                                      ),
                                    },
                                  ),
                                },
                                { tab: "current" },
                              )
                            }
                            className="w-full"
                          >
                            {tx({
                              "zh-CN": "切换查看提案详情",
                              "zh-HK": "切換檢視提案詳情",
                              en: "Inspect Proposal",
                            })}
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
                      {tx({
                        "zh-CN": "正在实时核验发票数据…",
                        "zh-HK": "正在即時核驗發票資料…",
                        en: "Fetching live invoice data…",
                      })}
                    </div>
                  )}
                  {invoiceError && <AccessNoticeCard error={invoiceError} />}
                  {!invoiceLoading && !invoiceError && invoiceData && (
                    <>
                      <BriefProgressChain
                        phase="done"
                        summaryLabel={tx({
                          "zh-CN": "财务发票核验明细",
                          "zh-HK": "財務發票核驗明細",
                          en: "Invoice Verification",
                        })}
                        steps={[
                          {
                            id: "inv-scope",
                            label: tx(
                              {
                                "zh-CN": "财务读取范围已校验（{wh}）",
                                "zh-HK": "財務讀取範圍已校驗（{wh}）",
                                en: "Finance read scope verified ({wh})",
                              },
                              { wh: invoiceData.view.warehouse },
                            ),
                            status: "done",
                          },
                          {
                            id: "inv-read",
                            label: tx({
                              "zh-CN": "已返回实时结算状态",
                              "zh-HK": "已回傳即時結算狀態",
                              en: "Returned live settlement status",
                            }),
                            status: "done",
                            meta: localizeStatus(invoiceData.view.state),
                          },
                        ]}
                      />

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
                      <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] text-[12.5px]">
                        <div className="flex justify-between gap-2 px-3.5 py-2.5">
                          <dt className="text-[var(--ink-muted)]">
                            {tx({
                              "zh-CN": "仓库",
                              "zh-HK": "倉庫",
                              en: "Warehouse",
                            })}
                          </dt>
                          <dd className="font-mono-code text-[var(--ink-primary)]">
                            {invoiceData.view.warehouse}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3.5 py-2.5">
                          <dt className="text-[var(--ink-muted)]">
                            {tx({
                              "zh-CN": "发票金额",
                              "zh-HK": "發票金額",
                              en: "Amount",
                            })}
                          </dt>
                          <dd className="font-mono-code tabular-nums font-semibold text-[var(--ink-primary)]">
                            {formatCurrency(
                              invoiceData.view.amount,
                              invoiceData.view.currency,
                            )}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2 px-3.5 py-2.5">
                          <dt className="text-[var(--ink-muted)]">
                            {tx({
                              "zh-CN": "结算状态",
                              "zh-HK": "結算狀態",
                              en: "Status",
                            })}
                          </dt>
                          <dd className="font-medium text-[var(--ink-primary)]">
                            {localizeStatus(invoiceData.view.state)}
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
                      {tx({
                        "zh-CN": "正在实时鉴权拉取仓库汇总…",
                        "zh-HK": "正在即時鑑權拉取倉庫摘要…",
                        en: "Authorizing and fetching warehouse summary…",
                      })}
                    </div>
                  )}
                  {summaryError && <AccessNoticeCard error={summaryError} />}
                  {!summaryLoading && !summaryError && summaryData && (
                    <>
                      <BriefProgressChain
                        phase="done"
                        summaryLabel={tx({
                          "zh-CN": "经营汇总实时鉴权明细",
                          "zh-HK": "營運摘要即時鑑權明細",
                          en: "Live Authorized Summary",
                        })}
                        steps={[
                          {
                            id: "sum-scope",
                            label: tx(
                              {
                                "zh-CN":
                                  "租户与仓库只读范围核验（{tenant} · {wh}）",
                                "zh-HK":
                                  "租戶與倉庫唯讀範圍核驗（{tenant} · {wh}）",
                                en: "Tenant & warehouse read-only scope verified ({tenant} · {wh})",
                              },
                              {
                                tenant:
                                  actor?.tenant ??
                                  tx({
                                    "zh-CN": "当前租户",
                                    "zh-HK": "目前租戶",
                                    en: "Current tenant",
                                  }),
                                wh: summaryData.view.warehouse,
                              },
                            ),
                            status: "done",
                          },
                          {
                            id: "sum-asof",
                            label: tx({
                              "zh-CN": "已同步实时在途统计基准",
                              "zh-HK": "已同步即時在途統計基準",
                              en: "Synced live open-shipment snapshot",
                            }),
                            status: "done",
                            meta: summaryData.view.as_of,
                          },
                        ]}
                      />

                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <BarChart3 className="h-4 w-4 text-[var(--accent)]" />
                          <span className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)]">
                            {summaryData.view.warehouse}
                          </span>
                        </div>
                        <SourceTag source={summaryData.source} />
                      </div>
                      <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-4.5">
                        <div className="aios-micro-label">
                          {tx({
                            "zh-CN": "在途未结运单",
                            "zh-HK": "在途未結運單",
                            en: "Open Shipments",
                          })}
                        </div>
                        <div className="aios-kpi mt-1.5 text-[30px] font-semibold text-[var(--accent)]">
                          {summaryData.view.open_shipments}
                        </div>
                        <div className="mt-2 text-[11px] text-[var(--ink-muted)]">
                          {tx({
                            "zh-CN": "统计基准日：",
                            "zh-HK": "統計基準日：",
                            en: "As of: ",
                          })}
                          <span className="font-mono-code tabular-nums">
                            {summaryData.view.as_of}
                          </span>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        pill
                        variant="secondary"
                        onClick={() => void loadSelectedObject()}
                        className="w-full"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>
                          {tx({
                            "zh-CN": "重新鉴权刷新",
                            "zh-HK": "重新鑑權重新整理",
                            en: "Re-Verify & Refresh",
                          })}
                        </span>
                      </Button>
                    </>
                  )}
                </div>
              ) : selectedObject.kind === "brief" ? (
                <div className="space-y-3" data-testid="drawer-brief-inspector">
                  {briefLoading && (
                    <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                      {tx({
                        "zh-CN": "正在汇总工作简报…",
                        "zh-HK": "正在彙整工作簡報…",
                        en: "Compiling work brief…",
                      })}
                    </div>
                  )}
                  {briefError && <AccessNoticeCard error={briefError} />}
                  {!briefLoading && !briefError && brief && (
                    <>
                      <BriefProgressChain
                        phase="done"
                        summaryLabel={tx({
                          "zh-CN": "简报快照明细",
                          "zh-HK": "簡報快照明細",
                          en: "Brief Snapshot",
                        })}
                        steps={[
                          {
                            id: "brief-auth",
                            label: tx({
                              "zh-CN": "已按当前账号授权仓库汇总待办与会议",
                              "zh-HK": "已按目前帳號授權倉庫彙整待辦與會議",
                              en: "Aggregated tasks & meetings for your authorized warehouses",
                            }),
                            status: "done",
                          },
                          {
                            id: "brief-time",
                            label: tx({
                              "zh-CN": "快照生成时间",
                              "zh-HK": "快照產生時間",
                              en: "Snapshot timestamp",
                            }),
                            status: "done",
                            meta: formatDateTime(brief.as_of),
                          },
                        ]}
                      />

                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3.5">
                          <div className="aios-micro-label">
                            {tx({
                              "zh-CN": "待我审批",
                              "zh-HK": "待我審批",
                              en: "Pending Approvals",
                            })}
                          </div>
                          <div className="aios-kpi mt-1.5 text-[24px] font-semibold text-[var(--ink-primary)]">
                            {brief.pending_approvals}
                            {brief.pending_approvals_capped ? "+" : ""}
                          </div>
                        </div>
                        <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3.5">
                          <div className="aios-micro-label">
                            {tx({
                              "zh-CN": "未来 7 天会议",
                              "zh-HK": "未來 7 天會議",
                              en: "Meetings (7d)",
                            })}
                          </div>
                          <div className="aios-kpi mt-1.5 text-[24px] font-semibold text-[var(--ink-primary)]">
                            {brief.meetings}
                          </div>
                        </div>
                      </div>

                      <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] overflow-hidden">
                        <div className="aios-micro-label border-b border-[var(--hairline-subtle)] px-3.5 py-2.5">
                          {tx({
                            "zh-CN": "已提交单据状态分布",
                            "zh-HK": "已提交單據狀態分佈",
                            en: "Submitted Proposal Breakdown",
                          })}
                        </div>
                        <div className="divide-y divide-[var(--hairline-subtle)]">
                          {Object.entries(brief.submitted_current_states)
                            .length === 0 ? (
                            <div className="px-3.5 py-5 text-center text-[12px] text-[var(--ink-muted)]">
                              {tx({
                                "zh-CN": "暂无已提交记录",
                                "zh-HK": "暫無已提交紀錄",
                                en: "No submitted proposals",
                              })}
                            </div>
                          ) : (
                            Object.entries(brief.submitted_current_states).map(
                              ([stateKey, count]) => (
                                <div
                                  key={stateKey}
                                  className="flex items-center justify-between px-3.5 py-2.5 text-[12px]"
                                >
                                  <StatusBadge status={stateKey} compact />
                                  <span className="font-mono-code tabular-nums font-semibold text-[var(--ink-primary)]">
                                    {count}
                                  </span>
                                </div>
                              ),
                            )
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--ink-muted)]">
                        <span>
                          {tx({
                            "zh-CN": "快照：",
                            "zh-HK": "快照：",
                            en: "Snapshot: ",
                          })}
                          <span className="font-mono-code tabular-nums">
                            {formatDateTime(brief.as_of)}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => void loadSelectedObject()}
                          className="text-[var(--accent)] hover:underline cursor-pointer"
                        >
                          {tx({
                            "zh-CN": "刷新简报",
                            "zh-HK": "重新整理簡報",
                            en: "Refresh Brief",
                          })}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-4 text-[12.5px] text-[var(--ink-secondary)]">
                  <div className="text-[11px] text-[var(--ink-muted)]">
                    {selectedObject.kind} ·{" "}
                    <span className="font-mono-code">{selectedObject.id}</span>
                  </div>
                  <div className="mt-1 font-semibold text-[var(--ink-primary)]">
                    {selectedObject.title || selectedObject.id}
                  </div>
                </div>
              )}
            </>
          )}

          {(activeTab === "assigned" || activeTab === "submitted") && (
            <div className="space-y-2.5">
              {tasksLoading && (
                <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "正在加载队列…",
                    "zh-HK": "正在載入佇列…",
                    en: "Loading queue…",
                  })}
                </div>
              )}
              {tasksError && <AccessNoticeCard error={tasksError} />}
              {!tasksLoading && !tasksError && tasks.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-12 text-center text-[12.5px] text-[var(--ink-muted)]">
                  <Inbox className="h-5 w-5 opacity-60" strokeWidth={1.6} />
                  <span>
                    {activeTab === "assigned"
                      ? tx({
                          "zh-CN": "当前没有待您审批的单据",
                          "zh-HK": "目前沒有待您審批的單據",
                          en: "No proposals currently awaiting your approval",
                        })
                      : tx({
                          "zh-CN": "暂无已提交的单据",
                          "zh-HK": "暫無已提交的單據",
                          en: "No submitted proposals yet",
                        })}
                  </span>
                </div>
              )}
              {!tasksLoading && !tasksError && tasks.length > 0 && (
                <div className="space-y-2">
                  {tasks.map((item) => {
                    const shortId = formatShortDigest(item.id, 4, 4);
                    const actionLabel = localizeAction(item.action);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() =>
                          openDrawer(
                            {
                              kind: "proposal",
                              id: item.id,
                              warehouse: item.warehouse,
                              title: `${actionLabel} · ${shortId}`,
                            },
                            { tab: "current" },
                          )
                        }
                        className="flex w-full flex-col gap-1.5 rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-3 text-left hover:bg-[var(--bg-hover)] transition-colors duration-[150ms] cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12.5px] font-semibold text-[var(--ink-primary)] truncate">
                            {actionLabel} · {item.warehouse}
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
                          <span
                            title={item.id}
                            className="font-mono-code tabular-nums"
                          >
                            {shortId}
                          </span>
                          <span className="font-mono-code tabular-nums">
                            {formatDateTime(item.due)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="pt-2">
                <Link
                  href="/work"
                  className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[var(--accent)] hover:underline"
                >
                  <span>
                    {tx({
                      "zh-CN": "前往完整工作台列表",
                      "zh-HK": "前往完整工作台清單",
                      en: "Open Full Workbench",
                    })}
                  </span>
                  <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.85} />
                </Link>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
