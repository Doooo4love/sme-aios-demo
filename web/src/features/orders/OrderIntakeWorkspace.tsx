"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  ImageUp,
  Layers,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  createObjectUrlRegistry,
  generateIdempotencyKey,
  getAuthGeneration,
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
import type {
  BatchIntakeItem,
  ImageIntakeUploadResponse,
  IntakeDetail,
  Proposal,
  PurchaseOrder,
  PurchaseOrderLine,
  StructuredIntakeResponse,
} from "@/lib/types";
import {
  createStructuredBatchIntake,
  createStructuredIntake,
  fetchIntakeDetail,
  prepareOrderDraft,
  submitOrderOverridesAction,
  uploadImageIntake,
} from "@/features/orders/api";
import { OcrEvidenceViewer } from "@/features/orders/OcrEvidenceViewer";

type IntakeTab = "structured" | "batch" | "ocr";

const MAX_UPLOAD_BYTES = 8_000_000;

interface EditableOrderLine {
  id: string;
  sku: string;
  unit: string;
  quantity: string;
  unit_price: string;
  amount: string;
}

interface StructuredFormState {
  po: string;
  buyer: string;
  currency: string;
  delivery: string;
  total: string;
  lines: EditableOrderLine[];
}

const DEMO_STRUCTURED_FORM: StructuredFormState = {
  po: "FE-DEMO-001",
  buyer: "HBR-47",
  currency: "HKD",
  delivery: "2026-12-15",
  total: "50.00",
  lines: [
    {
      id: "line-1",
      sku: "TEA-24",
      unit: "CASE",
      quantity: "2",
      unit_price: "25.00",
      amount: "50.00",
    },
  ],
};

const BATCH_REVIEW_CODE_LABELS: Record<string, string> = {
  INVALID_ORDER: "订单结构或字段格式校验失败",
  CONFLICTING_ORDER_REVISIONS: "同批次内存在相同 PO 冲突修订版本",
  CURRENCY_OR_WAREHOUSE_UNSUPPORTED: "该仓库不支持所选币种或站点配置",
  ORDER_LIMIT_EXCEEDED: "超出该仓库单笔订单总额上限",
  MAPPING_MISSING: "商品 SKU / 买方 / 单位换算映射缺失",
  LINE_AMOUNT_MISMATCH: "明细行金额与数量×单价不一致",
  ORDER_TOTAL_MISMATCH: "订单总额与明细行汇总不一致",
  POLICY_DENIED: "外部策略拒绝该提案",
};

function makeEmptyLine(idx: number): EditableOrderLine {
  return {
    id: `line-${Date.now()}-${idx}`,
    sku: "",
    unit: "CASE",
    quantity: "1",
    unit_price: "0.00",
    amount: "0.00",
  };
}

function serializeFormToOrder(form: StructuredFormState): PurchaseOrder {
  return {
    po: form.po.trim(),
    buyer: form.buyer.trim(),
    currency: form.currency.trim().toUpperCase(),
    delivery: form.delivery.trim(),
    total: form.total.trim(),
    lines: form.lines.map(
      (line): PurchaseOrderLine => ({
        sku: line.sku.trim(),
        unit: line.unit.trim(),
        quantity: Number.parseInt(line.quantity, 10) || 0,
        unit_price: line.unit_price.trim(),
        amount: line.amount.trim(),
      }),
    ),
  };
}

function computeOrderFingerprint(warehouse: string, order: PurchaseOrder): string {
  return JSON.stringify({ warehouse, order });
}

function makeBatchSampleOrders(tenant?: string): PurchaseOrder[] {
  const isIsland = tenant === "island";
  return [
    {
      po: `FE-BATCH-${Math.floor(100 + Math.random() * 900)}`,
      buyer: isIsland ? "ISL-10" : "HBR-47",
      currency: "HKD",
      delivery: "2026-12-18",
      total: "50.00",
      lines: [
        {
          sku: isIsland ? "SHIP-BOX" : "TEA-24",
          unit: isIsland ? "PACK" : "CASE",
          quantity: 2,
          unit_price: "25.00",
          amount: "50.00",
        },
      ],
    },
    {
      po: "FE-BATCH-BAD-01",
      buyer: isIsland ? "ISL-10" : "HBR-47",
      currency: "HKD",
      delivery: "2026-12-18",
      total: "99999.00",
      lines: [
        {
          sku: "UNKNOWN-SKU",
          unit: "CASE",
          quantity: 1,
          unit_price: "99999.00",
          amount: "99999.00",
        },
      ],
    },
  ];
}

export function OrderIntakeWorkspace() {
  const searchParams = useSearchParams();
  const initialLookupId = searchParams.get("intake") ?? "";

  const { actor, capabilities, authGeneration, handleAccessChanged } =
    useSession();
  const { openDrawer } = useWorkbench();

  const authorizedWarehouses = useMemo(() => {
    const tool = capabilities?.tools.find(
      (t) => t.id === "order.draft.prepare" && t.available,
    );
    return tool?.warehouses ?? [];
  }, [capabilities]);

  const readableWarehouses = useMemo(
    () => capabilities?.order_read_warehouses ?? [],
    [capabilities],
  );

  const [warehouse, setWarehouse] = useState<string>("");
  const [activeTab, setActiveTab] = useState<IntakeTab>("structured");

  // Structured intake state
  const [form, setForm] = useState<StructuredFormState>(DEMO_STRUCTURED_FORM);
  const [poSuffixCounter, setPoSuffixCounter] = useState(1);
  const [structuredIntake, setStructuredIntake] =
    useState<StructuredIntakeResponse | null>(null);
  const [structuredFingerprint, setStructuredFingerprint] = useState<string>("");
  const [structuredIdemKey, setStructuredIdemKey] = useState<string>("");
  const [structuredSubmitting, setStructuredSubmitting] = useState(false);
  const [structuredPreparing, setStructuredPreparing] = useState(false);
  const [structuredError, setStructuredError] = useState<ApiError | null>(null);
  const [createdProposal, setCreatedProposal] = useState<Proposal | null>(null);

  // Batch intake state
  const [batchMode, setBatchMode] = useState<"rows" | "json">("rows");
  const [batchOrders, setBatchOrders] = useState<PurchaseOrder[]>(() => [
    serializeFormToOrder(DEMO_STRUCTURED_FORM),
  ]);
  const [batchJsonText, setBatchJsonText] = useState<string>(() =>
    JSON.stringify([serializeFormToOrder(DEMO_STRUCTURED_FORM)], null, 2),
  );
  const [batchJsonError, setBatchJsonError] = useState<string | null>(null);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchError, setBatchError] = useState<ApiError | null>(null);
  const [batchItems, setBatchItems] = useState<BatchIntakeItem[] | null>(null);

  // OCR image intake state
  const objectUrlRegistryRef = useRef(createObjectUrlRegistry());
  const [ocrFile, setOcrFile] = useState<File | null>(null);
  const [ocrPreviewUrl, setOcrPreviewUrl] = useState<string | null>(null);
  const [ocrFileValidationError, setOcrFileValidationError] = useState<
    string | null
  >(null);
  const [ocrUploading, setOcrUploading] = useState(false);
  const [ocrError, setOcrError] = useState<ApiError | null>(null);
  const [ocrResult, setOcrResult] = useState<ImageIntakeUploadResponse | null>(
    null,
  );
  const [ocrIdemMap, setOcrIdemMap] = useState<{
    fingerprint: string;
    key: string;
  }>({ fingerprint: "", key: "" });
  const [ocrPreparing, setOcrPreparing] = useState(false);
  const [ocrProposal, setOcrProposal] = useState<Proposal | null>(null);

  // Saved intake lookup
  const [lookupInput, setLookupInput] = useState(initialLookupId);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<ApiError | null>(null);
  const [lookupDetail, setLookupDetail] = useState<{
    id: string;
    data: IntakeDetail;
  } | null>(null);

  // Keep selected warehouse synced to authorized list
  useEffect(() => {
    if (authorizedWarehouses.length === 0) {
      setWarehouse("");
      return;
    }
    setWarehouse((prev) =>
      prev && authorizedWarehouses.includes(prev)
        ? prev
        : authorizedWarehouses[0]!,
    );
  }, [authorizedWarehouses]);

  // Revoke transient object URLs & wipe state on unmount or authGeneration change
  useEffect(() => {
    const registry = objectUrlRegistryRef.current;
    return () => {
      registry.revokeAll();
    };
  }, []);

  useEffect(() => {
    objectUrlRegistryRef.current.revokeAll();
    setOcrPreviewUrl(null);
    setOcrFile(null);
    setOcrResult(null);
    setOcrError(null);
    setOcrProposal(null);
    setStructuredIntake(null);
    setStructuredFingerprint("");
    setStructuredIdemKey("");
    setStructuredError(null);
    setCreatedProposal(null);
    setBatchItems(null);
    setBatchError(null);
    setLookupDetail(null);
    setLookupError(null);
  }, [authGeneration]);

  const handleLookupIntake = useCallback(
    async (idToFetch: string) => {
      const trimmed = idToFetch.trim();
      if (!trimmed) return;
      const startGen = getAuthGeneration();
      setLookupLoading(true);
      setLookupError(null);
      try {
        const data = await fetchIntakeDetail(trimmed);
        if (startGen !== getAuthGeneration()) return;
        setLookupDetail({ id: trimmed, data });
      } catch (error) {
        if (isStaleAuthError(error) || startGen !== getAuthGeneration()) return;
        if (isApiError(error)) {
          if (error.code === "ACCESS_CHANGED") {
            setLookupDetail(null);
            void handleAccessChanged();
          }
          setLookupError(error);
        }
      } finally {
        if (startGen === getAuthGeneration()) setLookupLoading(false);
      }
    },
    [handleAccessChanged],
  );

  useEffect(() => {
    if (initialLookupId && readableWarehouses.length > 0) {
      setLookupInput(initialLookupId);
      void handleLookupIntake(initialLookupId);
    }
  }, [initialLookupId, readableWarehouses.length, handleLookupIntake]);

  const currentStructuredOrder = useMemo(
    () => serializeFormToOrder(form),
    [form],
  );
  const currentStructuredFingerprint = useMemo(
    () => computeOrderFingerprint(warehouse, currentStructuredOrder),
    [warehouse, currentStructuredOrder],
  );
  const formModifiedSinceIntake =
    structuredIntake !== null &&
    structuredFingerprint !== currentStructuredFingerprint;

  // Map 422 fieldErrors cleanly to field keys
  const fieldErrorMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!structuredError?.fieldErrors) return map;
    for (const err of structuredError.fieldErrors) {
      const path = err.loc
        .filter((seg) => seg !== "body")
        .map(String)
        .join(".");
      if (path) map.set(path, err.msg);
    }
    return map;
  }, [structuredError]);

  const handlePrefillDemo = () => {
    const isIsland = actor?.tenant === "island";
    setForm(
      isIsland
        ? {
            po: "FE-DEMO-001",
            buyer: "ISL-10",
            currency: "HKD",
            delivery: "2026-12-15",
            total: "50.00",
            lines: [
              {
                id: "line-demo-1",
                sku: "SHIP-BOX",
                unit: "PACK",
                quantity: "2",
                unit_price: "25.00",
                amount: "50.00",
              },
            ],
          }
        : DEMO_STRUCTURED_FORM,
    );
    setStructuredIntake(null);
    setStructuredFingerprint("");
    setStructuredIdemKey("");
    setCreatedProposal(null);
    setStructuredError(null);
  };

  const handleGenerateNewPoSuffix = () => {
    const next = poSuffixCounter + 1;
    setPoSuffixCounter(next);
    const stamp = String(Date.now()).slice(-4);
    setForm((prev) => ({
      ...prev,
      po: `FE-DEMO-${String(next).padStart(2, "0")}-${stamp}`,
    }));
    setStructuredIntake(null);
    setStructuredFingerprint("");
    setStructuredIdemKey("");
    setCreatedProposal(null);
    setStructuredError(null);
  };

  const updateLine = (
    idx: number,
    patch: Partial<EditableOrderLine>,
    recalc = false,
  ) => {
    setForm((prev) => {
      const lines = prev.lines.map((line, i) => {
        if (i !== idx) return line;
        const next = { ...line, ...patch };
        if (recalc) {
          const qty = Number.parseInt(next.quantity, 10);
          const price = Number.parseFloat(next.unit_price);
          if (Number.isFinite(qty) && Number.isFinite(price)) {
            next.amount = (qty * price).toFixed(2);
          }
        }
        return next;
      });
      let total = prev.total;
      if (recalc) {
        const sum = lines.reduce(
          (acc, l) => acc + (Number.parseFloat(l.amount) || 0),
          0,
        );
        total = sum.toFixed(2);
      }
      return { ...prev, lines, total };
    });
  };

  const handleStep1SubmitStructured = async (): Promise<{
    intake: StructuredIntakeResponse;
    idemKey: string;
  } | null> => {
    if (!warehouse) return null;
    setStructuredSubmitting(true);
    setStructuredError(null);
    setCreatedProposal(null);
    const orderPayload = serializeFormToOrder(form);
    const fingerprint = computeOrderFingerprint(warehouse, orderPayload);
    try {
      const res = await createStructuredIntake(warehouse, orderPayload);
      // Reuse existing Idempotency-Key if exact same payload & intake_id; generate fresh if payload materially changed
      const idemKey =
        structuredFingerprint === fingerprint && structuredIdemKey
          ? structuredIdemKey
          : generateIdempotencyKey("ord");
      setStructuredIntake(res);
      setStructuredFingerprint(fingerprint);
      setStructuredIdemKey(idemKey);
      return { intake: res, idemKey };
    } catch (error) {
      if (isStaleAuthError(error)) return null;
      if (isApiError(error)) {
        if (error.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setStructuredError(error);
      }
      return null;
    } finally {
      setStructuredSubmitting(false);
    }
  };

  const handleStep2PrepareProposal = async (override?: {
    intake: StructuredIntakeResponse;
    idemKey: string;
  }) => {
    const targetIntake = override?.intake ?? structuredIntake;
    if (!targetIntake) return;
    const idemKey =
      override?.idemKey ||
      (structuredIdemKey || generateIdempotencyKey("ord"));
    if (!structuredIdemKey) setStructuredIdemKey(idemKey);

    setStructuredPreparing(true);
    setStructuredError(null);
    try {
      const result = await prepareOrderDraft(
        targetIntake.warehouse,
        targetIntake.intake_id,
        idemKey,
      );
      if (result.kind === "proposal") {
        setCreatedProposal(result.proposal);
      }
    } catch (error) {
      if (isStaleAuthError(error)) return;
      if (isApiError(error)) {
        if (error.code === "ACCESS_CHANGED") {
          setCreatedProposal(null);
          void handleAccessChanged();
        }
        setStructuredError(error);
      }
    } finally {
      setStructuredPreparing(false);
    }
  };

  const handleOneClickSubmitAndPrepare = async (e: React.FormEvent) => {
    e.preventDefault();
    if (structuredIntake && !formModifiedSinceIntake) {
      await handleStep2PrepareProposal();
      return;
    }
    const step1 = await handleStep1SubmitStructured();
    if (step1) {
      await handleStep2PrepareProposal(step1);
    }
  };

  // --- Batch Intake Handlers ---
  const handleLoadBatchSample = () => {
    const sample = makeBatchSampleOrders(actor?.tenant);
    setBatchOrders(sample);
    setBatchJsonText(JSON.stringify(sample, null, 2));
    setBatchJsonError(null);
    setBatchItems(null);
    setBatchError(null);
  };

  const handleSubmitBatch = async () => {
    if (!warehouse) return;
    setBatchError(null);
    setBatchJsonError(null);
    let ordersPayload: unknown[] = batchOrders;
    if (batchMode === "json") {
      try {
        const parsed = JSON.parse(batchJsonText);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          setBatchJsonError("请输入非空的 JSON 订单数组（1–50 条）。");
          return;
        }
        if (parsed.length > 50) {
          setBatchJsonError("单次批量导入最多支持 50 条订单。");
          return;
        }
        ordersPayload = parsed;
      } catch {
        setBatchJsonError("JSON 格式无法解析，请检查逗号与引号。");
        return;
      }
    }

    setBatchSubmitting(true);
    try {
      const res = await createStructuredBatchIntake(warehouse, ordersPayload);
      setBatchItems(res.items);
    } catch (error) {
      if (isStaleAuthError(error)) return;
      if (isApiError(error)) {
        if (error.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setBatchError(error);
      }
    } finally {
      setBatchSubmitting(false);
    }
  };

  // --- OCR Upload Handlers ---
  const handleOcrFileSelect = (file: File | null) => {
    setOcrFileValidationError(null);
    setOcrError(null);
    setOcrResult(null);
    setOcrProposal(null);
    objectUrlRegistryRef.current.revokeAll();
    setOcrPreviewUrl(null);

    if (!file) {
      setOcrFile(null);
      return;
    }
    const validMime =
      file.type === "image/png" ||
      file.type === "image/jpeg" ||
      /\.(png|jpe?g)$/i.test(file.name);
    if (!validMime) {
      setOcrFileValidationError("仅支持 PNG 或 JPEG 格式单据图片。");
      setOcrFile(null);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setOcrFileValidationError(
        `文件大小 ${(file.size / 1_000_000).toFixed(2)} MB 超过 8 MB 限制。`,
      );
      setOcrFile(null);
      return;
    }

    setOcrFile(file);
    const url = objectUrlRegistryRef.current.create(file);
    setOcrPreviewUrl(url);
  };

  const handleUploadOcr = async () => {
    if (!warehouse || !ocrFile) return;
    setOcrUploading(true);
    setOcrError(null);
    setOcrProposal(null);
    try {
      const res = await uploadImageIntake(warehouse, ocrFile);
      setOcrResult(res);
      setOcrIdemMap({
        fingerprint: `${res.warehouse}:${res.intake_id}`,
        key: generateIdempotencyKey("ocr"),
      });
    } catch (error) {
      if (isStaleAuthError(error)) return;
      if (isApiError(error)) {
        if (error.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setOcrError(error);
      }
    } finally {
      setOcrUploading(false);
    }
  };

  const handlePrepareFromOcr = async (
    targetWarehouse: string,
    targetIntakeId: string,
    overrides?: Record<string, string>,
  ) => {
    const fp = `${targetWarehouse}:${targetIntakeId}:${JSON.stringify(overrides ?? {})}`;
    const key =
      ocrIdemMap.fingerprint === fp && ocrIdemMap.key
        ? ocrIdemMap.key
        : generateIdempotencyKey("ocr");
    setOcrIdemMap({ fingerprint: fp, key });

    setOcrPreparing(true);
    setOcrError(null);
    try {
      if (overrides && Object.keys(overrides).length > 0) {
        const res = await submitOrderOverridesAction(
          targetIntakeId,
          overrides,
          key,
        );
        if (res.status === "proposed") {
          const { status: _ignored, ...proposalData } = res;
          void _ignored;
          setOcrProposal(proposalData);
        }
      } else {
        const res = await prepareOrderDraft(
          targetWarehouse,
          targetIntakeId,
          key,
        );
        if (res.kind === "proposal") {
          setOcrProposal(res.proposal);
        }
      }
    } catch (error) {
      if (isStaleAuthError(error)) return;
      if (isApiError(error)) {
        if (error.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setOcrError(error);
      }
    } finally {
      setOcrPreparing(false);
    }
  };

  // --- Restricted Access Gate when actor has no order.work warehouses ---
  if (capabilities && authorizedWarehouses.length === 0) {
    return (
      <div
        className="mx-auto max-w-[760px] p-4 lg:p-6 space-y-4"
        data-testid="order-access-restricted"
      >
        <AccessNoticeCard
          variant="ACCESS_RESTRICTED"
          title="当前账号无订单进件写入权限"
          message="新建销售订单进件需要 order.work 权限及有效仓库授权范围。如需查看已有进件或申请权限，请返回工作台或联系租户权限管理员。"
          backHref="/work"
        />

        {readableWarehouses.length > 0 && (
          <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-4 space-y-3">
            <h3 className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
              只读查询已有进件证据（已授权读仓：{readableWarehouses.join(", ")}）
            </h3>
            <div className="flex gap-2">
              <input
                type="text"
                value={lookupInput}
                onChange={(e) => setLookupInput(e.target.value)}
                placeholder="输入进件编号 (intake_id)"
                className="h-9 flex-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12.5px]"
              />
              <Button
                variant="secondary"
                loading={lookupLoading}
                onClick={() => void handleLookupIntake(lookupInput)}
              >
                <Search className="h-3.5 w-3.5" />
                <span>查询进件</span>
              </Button>
            </div>
            {lookupError && <AccessNoticeCard error={lookupError} />}
            {lookupDetail && lookupDetail.data.evidence.kind === "image" && (
              <OcrEvidenceViewer
                intakeId={lookupDetail.id}
                warehouse={lookupDetail.data.warehouse}
                evidence={lookupDetail.data.evidence}
                imageUrl={null}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-[1200px] space-y-4 p-4 lg:p-6 pb-16"
      data-testid="order-intake-workspace"
    >
      {/* Top Action Strip: Warehouse Selector, Mode Tabs & Saved Intake Lookup */}
      <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label
                htmlFor="order-warehouse-select"
                className="text-[12px] font-medium text-[var(--ink-secondary)]"
              >
                目标仓库
              </label>
              <select
                id="order-warehouse-select"
                value={warehouse}
                onChange={(e) => {
                  setWarehouse(e.target.value);
                  setStructuredIntake(null);
                  setStructuredFingerprint("");
                  setStructuredIdemKey("");
                  setCreatedProposal(null);
                  setStructuredError(null);
                }}
                data-testid="orders-warehouse-select"
                className="h-8 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
              >
                {authorizedWarehouses.map((wh) => (
                  <option key={wh} value={wh}>
                    {wh}
                  </option>
                ))}
              </select>
            </div>

            <span className="hidden sm:inline-block h-4 w-px bg-[var(--hairline-strong)]" />

            <div
              role="tablist"
              aria-label="订单进件方式"
              className="flex flex-wrap items-center gap-1"
            >
              {(
                [
                  {
                    id: "structured" as const,
                    label: "结构化单笔进件",
                    icon: FileText,
                    testId: "orders-tab-structured",
                  },
                  {
                    id: "batch" as const,
                    label: "批量结构化进件 (≤50)",
                    icon: Layers,
                    testId: "orders-tab-batch",
                  },
                  {
                    id: "ocr" as const,
                    label: "单据图片 OCR 进件",
                    icon: ImageUp,
                    testId: "orders-tab-ocr",
                  },
                ] as const
              ).map((tab) => {
                const active = activeTab === tab.id;
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={tab.testId}
                    onClick={() => setActiveTab(tab.id)}
                    className={[
                      "inline-flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[12.5px] font-medium transition-colors duration-[120ms] cursor-pointer",
                      active
                        ? "border-[var(--accent-border)] bg-[var(--bg-sheet)] text-[var(--accent)]"
                        : "border-transparent text-[var(--ink-secondary)] hover:bg-[var(--bg-plane-hover)] hover:text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Saved Intake Lookup */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleLookupIntake(lookupInput);
            }}
            className="flex items-center gap-1.5"
          >
            <input
              type="text"
              value={lookupInput}
              onChange={(e) => setLookupInput(e.target.value)}
              placeholder="按 intake_id 查询历史进件"
              data-testid="orders-intake-lookup-input"
              className="h-8 w-44 sm:w-52 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              loading={lookupLoading}
              data-testid="orders-intake-lookup-btn"
            >
              <Search className="h-3.5 w-3.5" />
              <span>调阅</span>
            </Button>
          </form>
        </div>

        {/* Lookup Result Panel (if user searched or arrived via ?intake=...) */}
        {(lookupError || lookupDetail) && (
          <div className="border-b border-[var(--hairline)] bg-[var(--bg-subtle)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-secondary)]">
                SAVED INTAKE LOOKUP · 历史进件证据
              </span>
              <button
                type="button"
                onClick={() => {
                  setLookupDetail(null);
                  setLookupError(null);
                }}
                className="text-[12px] text-[var(--ink-muted)] hover:text-[var(--ink-primary)] cursor-pointer"
              >
                收起
              </button>
            </div>
            {lookupError && <AccessNoticeCard error={lookupError} />}
            {lookupDetail && lookupDetail.data.evidence.kind === "image" && (
              <OcrEvidenceViewer
                intakeId={lookupDetail.id}
                warehouse={lookupDetail.data.warehouse}
                evidence={lookupDetail.data.evidence}
                imageUrl={null}
                onPrepareDraft={
                  authorizedWarehouses.includes(lookupDetail.data.warehouse)
                    ? (overrides) =>
                        handlePrepareFromOcr(
                          lookupDetail.data.warehouse,
                          lookupDetail.id,
                          overrides,
                        )
                    : undefined
                }
                preparing={ocrPreparing}
              />
            )}
            {lookupDetail &&
              lookupDetail.data.evidence.kind === "structured" && (
                <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-3.5 space-y-2 text-[12.5px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono-code font-semibold text-[var(--ink-primary)]">
                      {lookupDetail.id} · {lookupDetail.data.warehouse} · PO{" "}
                      {lookupDetail.data.evidence.order.po}
                    </span>
                    <span className="font-mono-code text-[11.5px] text-[var(--ink-muted)]">
                      SHA-256{" "}
                      {formatShortDigest(
                        lookupDetail.data.evidence.artifact_sha256,
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono-code text-[12px] text-[var(--ink-secondary)]">
                    <span>买方：{lookupDetail.data.evidence.order.buyer}</span>
                    <span>
                      交期：{lookupDetail.data.evidence.order.delivery}
                    </span>
                    <span className="font-semibold text-[var(--ink-primary)]">
                      总额：{lookupDetail.data.evidence.order.currency}{" "}
                      {lookupDetail.data.evidence.order.total}
                    </span>
                  </div>
                </div>
              )}
          </div>
        )}
      </div>

      {/* ================================================================== */}
      {/* TAB A: Structured Single Order Intake                              */}
      {/* ================================================================== */}
      {activeTab === "structured" && (
        <div className="space-y-4">
          <form
            onSubmit={handleOneClickSubmitAndPrepare}
            data-testid="orders-structured-form"
            className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)]"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-2.5">
              <div>
                <h2 className="text-[14px] font-semibold text-[var(--ink-primary)]">
                  结构化采购单进件（两步确定性提交）
                </h2>
                <p className="text-[12px] text-[var(--ink-muted)]">
                  第 1 步写入内容寻址进件（POST /v1/intakes/{warehouse}/structured），第 2 步携带稳定 Idempotency-Key 生成 ERP 销售草稿提案。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handlePrefillDemo}
                  data-testid="orders-prefill-demo-btn"
                >
                  <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
                  <span>载入合成演示样例 (FE-DEMO-001)</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleGenerateNewPoSuffix}
                  data-testid="orders-po-suffix-btn"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>生成新 PO 后缀</span>
                </Button>
              </div>
            </div>

            <div className="p-4 space-y-4">
              {/* Header Fields */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <label className="block space-y-1">
                  <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                    采购单号 (PO)
                  </span>
                  <input
                    type="text"
                    required
                    value={form.po}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, po: e.target.value }))
                    }
                    aria-invalid={fieldErrorMap.has("po") ? "true" : undefined}
                    data-testid="orders-input-po"
                    className="h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[13px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  {fieldErrorMap.has("po") && (
                    <span className="block text-[11.5px] text-[var(--status-crimson)]">
                      {fieldErrorMap.get("po")}
                    </span>
                  )}
                </label>

                <label className="block space-y-1">
                  <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                    买方编码 (Buyer)
                  </span>
                  <input
                    type="text"
                    required
                    value={form.buyer}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, buyer: e.target.value }))
                    }
                    aria-invalid={
                      fieldErrorMap.has("buyer") ? "true" : undefined
                    }
                    data-testid="orders-input-buyer"
                    className="h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[13px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  {fieldErrorMap.has("buyer") && (
                    <span className="block text-[11.5px] text-[var(--status-crimson)]">
                      {fieldErrorMap.get("buyer")}
                    </span>
                  )}
                </label>

                <label className="block space-y-1">
                  <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                    币种 (ISO-4217)
                  </span>
                  <input
                    type="text"
                    required
                    maxLength={3}
                    value={form.currency}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        currency: e.target.value.toUpperCase(),
                      }))
                    }
                    aria-invalid={
                      fieldErrorMap.has("currency") ? "true" : undefined
                    }
                    data-testid="orders-input-currency"
                    className="h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[13px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                    交付日期
                  </span>
                  <input
                    type="date"
                    required
                    value={form.delivery}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, delivery: e.target.value }))
                    }
                    aria-invalid={
                      fieldErrorMap.has("delivery") ? "true" : undefined
                    }
                    data-testid="orders-input-delivery"
                    className="h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[13px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                    订单总额
                  </span>
                  <input
                    type="text"
                    required
                    value={form.total}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, total: e.target.value }))
                    }
                    aria-invalid={
                      fieldErrorMap.has("total") ? "true" : undefined
                    }
                    data-testid="orders-input-total"
                    className="h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 text-right font-mono-code text-[13px] font-semibold text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                </label>
              </div>

              {/* Line Items Table */}
              <div className="rounded-[4px] border border-[var(--hairline)] overflow-hidden">
                <div className="flex items-center justify-between border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-3 py-2">
                  <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-secondary)]">
                    ORDER LINES · 商品明细行（{form.lines.length}）
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        lines: [
                          ...prev.lines,
                          makeEmptyLine(prev.lines.length + 1),
                        ],
                      }))
                    }
                    className="h-6 px-2 text-[11.5px]"
                  >
                    <Plus className="h-3 w-3" />
                    <span>添加明细行</span>
                  </Button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-[12px]">
                    <thead>
                      <tr className="border-b border-[var(--hairline)] bg-[var(--bg-subtle)] text-[11px] text-[var(--ink-muted)]">
                        <th className="px-3 py-1.5 font-medium">SKU</th>
                        <th className="px-3 py-1.5 font-medium">源单位</th>
                        <th className="px-3 py-1.5 font-medium text-right">
                          数量
                        </th>
                        <th className="px-3 py-1.5 font-medium text-right">
                          单价
                        </th>
                        <th className="px-3 py-1.5 font-medium text-right">
                          行金额
                        </th>
                        <th className="px-2 py-1.5 w-10" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--hairline-subtle)]">
                      {form.lines.map((line, idx) => (
                        <tr key={line.id}>
                          <td className="p-2">
                            <input
                              type="text"
                              required
                              value={line.sku}
                              onChange={(e) =>
                                updateLine(idx, { sku: e.target.value })
                              }
                              data-testid={`orders-line-${idx}-sku`}
                              className="h-8 w-full min-w-[110px] rounded-[4px] border border-[var(--hairline-strong)] px-2 font-mono-code text-[12.5px]"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              required
                              value={line.unit}
                              onChange={(e) =>
                                updateLine(idx, { unit: e.target.value })
                              }
                              data-testid={`orders-line-${idx}-unit`}
                              className="h-8 w-24 rounded-[4px] border border-[var(--hairline-strong)] px-2 font-mono-code text-[12.5px]"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              min={1}
                              step={1}
                              required
                              value={line.quantity}
                              onChange={(e) =>
                                updateLine(
                                  idx,
                                  { quantity: e.target.value },
                                  true,
                                )
                              }
                              data-testid={`orders-line-${idx}-quantity`}
                              className="h-8 w-24 ml-auto block rounded-[4px] border border-[var(--hairline-strong)] px-2 text-right font-mono-code text-[12.5px]"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              required
                              value={line.unit_price}
                              onChange={(e) =>
                                updateLine(
                                  idx,
                                  { unit_price: e.target.value },
                                  true,
                                )
                              }
                              data-testid={`orders-line-${idx}-unit-price`}
                              className="h-8 w-28 ml-auto block rounded-[4px] border border-[var(--hairline-strong)] px-2 text-right font-mono-code text-[12.5px]"
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="text"
                              required
                              value={line.amount}
                              onChange={(e) =>
                                updateLine(idx, { amount: e.target.value })
                              }
                              data-testid={`orders-line-${idx}-amount`}
                              className="h-8 w-28 ml-auto block rounded-[4px] border border-[var(--hairline-strong)] px-2 text-right font-mono-code text-[12.5px] font-semibold"
                            />
                          </td>
                          <td className="p-2 text-center">
                            <button
                              type="button"
                              disabled={form.lines.length <= 1}
                              onClick={() =>
                                setForm((prev) => ({
                                  ...prev,
                                  lines: prev.lines.filter((_, i) => i !== idx),
                                }))
                              }
                              aria-label="删除行"
                              className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[var(--ink-muted)] hover:bg-[var(--status-crimson-wash)] hover:text-[var(--status-crimson)] disabled:opacity-35 cursor-pointer"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Error Banner */}
              {structuredError && (
                <div data-testid="orders-structured-error">
                  <AccessNoticeCard
                    error={structuredError}
                    authorizedWarehouses={
                      structuredError.status === 403
                        ? authorizedWarehouses
                        : undefined
                    }
                    onSelectWarehouse={
                      structuredError.status === 403
                        ? (wh) => {
                            setWarehouse(wh);
                            setStructuredError(null);
                          }
                        : undefined
                    }
                    onRetry={
                      structuredError.status === 429 ||
                      structuredError.status >= 500
                        ? () => {
                            if (structuredIntake && !formModifiedSinceIntake) {
                              void handleStep2PrepareProposal();
                            } else {
                              void handleStep1SubmitStructured();
                            }
                          }
                        : undefined
                    }
                  />
                </div>
              )}

              {/* Step 1 + Step 2 Execution Footer */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--hairline)] pt-3.5">
                <div className="space-y-0.5 text-[12px]">
                  {structuredIntake && !formModifiedSinceIntake ? (
                    <div className="flex flex-wrap items-center gap-2 text-[var(--status-emerald)]">
                      <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />
                      <span>
                        步骤 1 完成 · 进件号{" "}
                        <span
                          className="font-mono-code font-semibold"
                          data-testid="orders-intake-id-value"
                        >
                          {structuredIntake.intake_id}
                        </span>
                      </span>
                      <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                        Idempotency-Key: {formatShortDigest(structuredIdemKey, 10, 6)}
                      </span>
                    </div>
                  ) : (
                    <span className="text-[var(--ink-muted)]">
                      {formModifiedSinceIntake
                        ? "表单字段已修改，将重新提交进件并生成新的幂等键（Idempotency-Key）。"
                        : "支持分步提交或一键完成「写入进件 → 生成 ERP 销售草稿提案」。"}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    loading={structuredSubmitting}
                    onClick={() => void handleStep1SubmitStructured()}
                    data-testid="orders-submit-intake-btn"
                  >
                    1. 提交结构化进件
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!structuredIntake || formModifiedSinceIntake}
                    loading={structuredPreparing}
                    onClick={() => void handleStep2PrepareProposal()}
                    data-testid="orders-prepare-proposal-btn"
                  >
                    2. 生成订单提案
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={structuredSubmitting || structuredPreparing}
                    data-testid="orders-submit-and-prepare-btn"
                  >
                    提交并生成提案
                  </Button>
                </div>
              </div>
            </div>
          </form>

          {/* Created Proposal Result Card */}
          {createdProposal && (
            <CreatedProposalBanner
              proposal={createdProposal}
              onInspectDrawer={(trigger) =>
                openDrawer(
                  {
                    kind: "proposal",
                    id: createdProposal.id,
                    warehouse: createdProposal.warehouse,
                    title: `销售订单草稿 · ${createdProposal.id}`,
                  },
                  { tab: "current", trigger },
                )
              }
            />
          )}
        </div>
      )}

      {/* ================================================================== */}
      {/* TAB B: Batch Structured Intake                                     */}
      {/* ================================================================== */}
      {activeTab === "batch" && (
        <div className="space-y-4">
          <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-2.5">
              <div>
                <h2 className="text-[14px] font-semibold text-[var(--ink-primary)]">
                  批量结构化订单进件（POST /v1/intakes/{warehouse}/structured/batch）
                </h2>
                <p className="text-[12px] text-[var(--ink-muted)]">
                  一次提交 1–50 条采购单，逐条返回 prepared（已生成提案）或 review（待人工复核及具体错误码）。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleLoadBatchSample}
                  data-testid="orders-batch-load-sample-btn"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 text-[var(--accent)]" />
                  <span>载入批量示例（1 正常 + 1 异常）</span>
                </Button>
                <div className="inline-flex rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] p-0.5">
                  <button
                    type="button"
                    onClick={() => setBatchMode("rows")}
                    className={[
                      "rounded-[2px] px-2.5 py-1 text-[11.5px] font-medium cursor-pointer",
                      batchMode === "rows"
                        ? "bg-[var(--accent-wash)] text-[var(--accent)]"
                        : "text-[var(--ink-muted)]",
                    ].join(" ")}
                  >
                    多行表格
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setBatchJsonText(JSON.stringify(batchOrders, null, 2));
                      setBatchMode("json");
                    }}
                    className={[
                      "rounded-[2px] px-2.5 py-1 text-[11.5px] font-medium cursor-pointer",
                      batchMode === "json"
                        ? "bg-[var(--accent-wash)] text-[var(--accent)]"
                        : "text-[var(--ink-muted)]",
                    ].join(" ")}
                  >
                    JSON 编辑
                  </button>
                </div>
              </div>
            </div>

            <div className="p-4 space-y-3">
              {batchMode === "rows" ? (
                <div className="space-y-2">
                  <div className="overflow-x-auto rounded-[4px] border border-[var(--hairline)]">
                    <table className="w-full border-collapse text-left text-[12px]">
                      <thead>
                        <tr className="border-b border-[var(--hairline)] bg-[var(--bg-plane)] text-[11px] text-[var(--ink-muted)]">
                          <th className="px-2.5 py-1.5 font-medium">#</th>
                          <th className="px-2.5 py-1.5 font-medium">PO</th>
                          <th className="px-2.5 py-1.5 font-medium">买方</th>
                          <th className="px-2.5 py-1.5 font-medium">交期</th>
                          <th className="px-2.5 py-1.5 font-medium">SKU</th>
                          <th className="px-2.5 py-1.5 font-medium text-right">
                            数量
                          </th>
                          <th className="px-2.5 py-1.5 font-medium text-right">
                            单价
                          </th>
                          <th className="px-2.5 py-1.5 font-medium text-right">
                            总额 (HKD)
                          </th>
                          <th className="px-2 py-1.5 w-8" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--hairline-subtle)]">
                        {batchOrders.map((ord, idx) => {
                          const firstLine = ord.lines[0] ?? {
                            sku: "TEA-24",
                            unit: "CASE",
                            quantity: 1,
                            unit_price: "25.00",
                            amount: "25.00",
                          };
                          const patchRow = (patch: Partial<PurchaseOrder>) => {
                            setBatchOrders((prev) =>
                              prev.map((row, i) =>
                                i === idx ? { ...row, ...patch } : row,
                              ),
                            );
                          };
                          const patchFirstLine = (
                            lPatch: Partial<PurchaseOrderLine>,
                          ) => {
                            const updatedLine: PurchaseOrderLine = {
                              ...firstLine,
                              ...lPatch,
                            };
                            const amt = (
                              updatedLine.quantity *
                              (Number.parseFloat(updatedLine.unit_price) || 0)
                            ).toFixed(2);
                            updatedLine.amount = amt;
                            patchRow({
                              lines: [updatedLine, ...ord.lines.slice(1)],
                              total: amt,
                            });
                          };
                          return (
                            <tr key={`batch-row-${idx}`}>
                              <td className="px-2.5 py-2 font-mono-code text-[var(--ink-muted)]">
                                {idx + 1}
                              </td>
                              <td className="p-1.5">
                                <input
                                  type="text"
                                  value={ord.po}
                                  onChange={(e) =>
                                    patchRow({ po: e.target.value })
                                  }
                                  className="h-8 w-32 rounded-[4px] border border-[var(--hairline-strong)] px-2 font-mono-code text-[12px]"
                                />
                              </td>
                              <td className="p-1.5">
                                <input
                                  type="text"
                                  value={ord.buyer}
                                  onChange={(e) =>
                                    patchRow({ buyer: e.target.value })
                                  }
                                  className="h-8 w-24 rounded-[4px] border border-[var(--hairline-strong)] px-2 font-mono-code text-[12px]"
                                />
                              </td>
                              <td className="p-1.5">
                                <input
                                  type="date"
                                  value={ord.delivery}
                                  onChange={(e) =>
                                    patchRow({ delivery: e.target.value })
                                  }
                                  className="h-8 w-36 rounded-[4px] border border-[var(--hairline-strong)] px-2 font-mono-code text-[12px]"
                                />
                              </td>
                              <td className="p-1.5">
                                <input
                                  type="text"
                                  value={firstLine.sku}
                                  onChange={(e) =>
                                    patchFirstLine({ sku: e.target.value })
                                  }
                                  className="h-8 w-28 rounded-[4px] border border-[var(--hairline-strong)] px-2 font-mono-code text-[12px]"
                                />
                              </td>
                              <td className="p-1.5">
                                <input
                                  type="number"
                                  min={1}
                                  value={firstLine.quantity}
                                  onChange={(e) =>
                                    patchFirstLine({
                                      quantity:
                                        Number.parseInt(e.target.value, 10) ||
                                        1,
                                    })
                                  }
                                  className="h-8 w-20 ml-auto block rounded-[4px] border border-[var(--hairline-strong)] px-2 text-right font-mono-code text-[12px]"
                                />
                              </td>
                              <td className="p-1.5">
                                <input
                                  type="text"
                                  value={firstLine.unit_price}
                                  onChange={(e) =>
                                    patchFirstLine({
                                      unit_price: e.target.value,
                                    })
                                  }
                                  className="h-8 w-24 ml-auto block rounded-[4px] border border-[var(--hairline-strong)] px-2 text-right font-mono-code text-[12px]"
                                />
                              </td>
                              <td className="px-2.5 py-2 text-right font-mono-code font-semibold text-[var(--ink-primary)]">
                                {ord.total}
                              </td>
                              <td className="p-1.5 text-center">
                                <button
                                  type="button"
                                  disabled={batchOrders.length <= 1}
                                  onClick={() =>
                                    setBatchOrders((prev) =>
                                      prev.filter((_, i) => i !== idx),
                                    )
                                  }
                                  className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[var(--ink-muted)] hover:text-[var(--status-crimson)] disabled:opacity-35 cursor-pointer"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={batchOrders.length >= 50}
                    onClick={() =>
                      setBatchOrders((prev) => [
                        ...prev,
                        {
                          ...serializeFormToOrder(DEMO_STRUCTURED_FORM),
                          po: `FE-BATCH-${prev.length + 1}-${String(Date.now()).slice(-3)}`,
                        },
                      ])
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>新增订单行</span>
                  </Button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <textarea
                    rows={12}
                    value={batchJsonText}
                    onChange={(e) => {
                      setBatchJsonText(e.target.value);
                      setBatchJsonError(null);
                    }}
                    data-testid="orders-batch-json-input"
                    className="w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] p-3 font-mono-code text-[12px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  {batchJsonError && (
                    <p className="text-[12px] text-[var(--status-crimson)]">
                      {batchJsonError}
                    </p>
                  )}
                </div>
              )}

              {batchError && (
                <AccessNoticeCard
                  error={batchError}
                  authorizedWarehouses={
                    batchError.status === 403 ? authorizedWarehouses : undefined
                  }
                  onSelectWarehouse={
                    batchError.status === 403
                      ? (wh) => {
                          setWarehouse(wh);
                          setBatchError(null);
                        }
                      : undefined
                  }
                />
              )}

              <div className="flex items-center justify-end border-t border-[var(--hairline)] pt-3">
                <Button
                  variant="primary"
                  loading={batchSubmitting}
                  onClick={() => void handleSubmitBatch()}
                  data-testid="orders-batch-submit-btn"
                >
                  批量校验并提交 ({batchMode === "rows" ? batchOrders.length : "JSON"})
                </Button>
              </div>
            </div>
          </div>

          {/* Per-item Batch Outcome Table */}
          {batchItems && (
            <div
              className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden"
              data-testid="orders-batch-results"
            >
              <div className="flex items-center justify-between border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2">
                <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-secondary)]">
                  BATCH OUTCOMES · 批量进件结果明细
                </span>
                <span className="font-mono-code text-[11.5px] text-[var(--ink-muted)]">
                  已生成{" "}
                  {batchItems.filter((i) => i.status === "prepared").length} ·
                  待复核{" "}
                  {batchItems.filter((i) => i.status === "review").length}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-[var(--hairline)] bg-[var(--bg-subtle)] text-[11px] text-[var(--ink-muted)]">
                      <th className="px-3 py-2 font-medium">序号</th>
                      <th className="px-3 py-2 font-medium">处理结果</th>
                      <th className="px-3 py-2 font-medium">进件 / 提案编号</th>
                      <th className="px-3 py-2 font-medium">详情 / 复核原因</th>
                      <th className="px-3 py-2 font-medium text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--hairline-subtle)]">
                    {batchItems.map((item) => (
                      <tr key={`batch-res-${item.position}`}>
                        <td className="px-3 py-2 font-mono-code text-[var(--ink-muted)]">
                          #{item.position + 1}
                        </td>
                        <td className="px-3 py-2">
                          {item.status === "prepared" ? (
                            <StatusBadge status={item.state} compact />
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-[4px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--status-amber-ink)]">
                              <AlertTriangle className="h-3 w-3" />
                              <span>需人工复核</span>
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono-code text-[12px]">
                          {item.status === "prepared" ? (
                            <div>
                              <div className="font-semibold text-[var(--ink-primary)]">
                                {item.proposal_id}
                              </div>
                              <div className="text-[11px] text-[var(--ink-muted)]">
                                进件 {item.intake_id}
                              </div>
                            </div>
                          ) : (
                            <span className="text-[var(--ink-muted)]">
                              {item.intake_id || "未写入进件"}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[12px]">
                          {item.status === "prepared" ? (
                            <span className="font-mono-code text-[11.5px] text-[var(--ink-muted)]">
                              digest {formatShortDigest(item.digest)}
                            </span>
                          ) : (
                            <div className="space-y-0.5">
                              <div className="font-medium text-[var(--status-amber-ink)]">
                                {BATCH_REVIEW_CODE_LABELS[item.code] ??
                                  item.code}
                              </div>
                              <div className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                                {item.code}
                                {item.fields && item.fields.length > 0
                                  ? ` (${item.fields.map((f) => `${f.field}:${f.code}`).join(", ")})`
                                  : ""}
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {item.status === "prepared" && (
                            <div className="inline-flex items-center gap-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={(e) =>
                                  openDrawer(
                                    {
                                      kind: "proposal",
                                      id: item.proposal_id,
                                      warehouse,
                                      title: `销售订单草稿 · ${item.proposal_id}`,
                                    },
                                    { tab: "current", trigger: e.currentTarget },
                                  )
                                }
                              >
                                面板查看
                              </Button>
                              <Link
                                href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                                className="inline-flex h-7 items-center gap-1 rounded-[4px] border border-[var(--hairline-strong)] px-2 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-subtle)]"
                              >
                                <span>详情</span>
                                <ArrowUpRight className="h-3 w-3" />
                              </Link>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ================================================================== */}
      {/* TAB C: Image OCR Intake & SVG Bounding-Box Evidence Viewer         */}
      {/* ================================================================== */}
      {activeTab === "ocr" && (
        <div className="space-y-4">
          <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[14px] font-semibold text-[var(--ink-primary)]">
                  单据图片 OCR 进件与坐标定位核对
                </h2>
                <p className="text-[12px] text-[var(--ink-muted)]">
                  上传 PNG / JPEG 单据（≤ 8 MB），以 application/octet-stream 发送原始字节；本地预览通过 ObjectURL 管理，切换账号或离开页面时立即销毁。
                </p>
              </div>
              <SourceTag source="internal" />
            </div>

            <div className="flex flex-wrap items-center gap-3 rounded-[4px] border border-dashed border-[var(--hairline-strong)] bg-[var(--bg-subtle)] p-3.5">
              <input
                type="file"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                onChange={(e) =>
                  handleOcrFileSelect(e.target.files?.[0] ?? null)
                }
                data-testid="orders-ocr-file-input"
                className="block max-w-full text-[12.5px] text-[var(--ink-secondary)] file:mr-3 file:rounded-[4px] file:border file:border-[var(--hairline-strong)] file:bg-[var(--bg-sheet)] file:px-3 file:py-1.5 file:text-[12px] file:font-medium file:text-[var(--ink-primary)] file:cursor-pointer hover:file:bg-[var(--bg-plane)]"
              />
              {ocrFile && (
                <span className="font-mono-code text-[11.5px] text-[var(--ink-muted)]">
                  {ocrFile.name} · {(ocrFile.size / 1024).toFixed(1)} KB
                </span>
              )}
              <div className="ml-auto">
                <Button
                  variant="primary"
                  disabled={!ocrFile || !warehouse}
                  loading={ocrUploading}
                  onClick={() => void handleUploadOcr()}
                  data-testid="orders-ocr-upload-btn"
                >
                  <ImageUp className="h-4 w-4" strokeWidth={1.75} />
                  <span>上传并执行本地 OCR 提取</span>
                </Button>
              </div>
            </div>

            {ocrFileValidationError && (
              <p
                role="alert"
                data-testid="orders-ocr-validation-error"
                className="text-[12.5px] text-[var(--status-crimson)]"
              >
                {ocrFileValidationError}
              </p>
            )}

            {ocrError && (
              <div data-testid="orders-ocr-error">
                <AccessNoticeCard
                  error={ocrError}
                  authorizedWarehouses={
                    ocrError.status === 403 ? authorizedWarehouses : undefined
                  }
                  onSelectWarehouse={
                    ocrError.status === 403
                      ? (wh) => {
                          setWarehouse(wh);
                          setOcrError(null);
                        }
                      : undefined
                  }
                />
              </div>
            )}
          </div>

          {ocrResult && (
            <OcrEvidenceViewer
              intakeId={ocrResult.intake_id}
              warehouse={ocrResult.warehouse}
              evidence={ocrResult.evidence}
              imageUrl={ocrPreviewUrl}
              filename={ocrFile?.name ?? null}
              preparing={ocrPreparing}
              onPrepareDraft={(overrides) =>
                handlePrepareFromOcr(
                  ocrResult.warehouse,
                  ocrResult.intake_id,
                  overrides,
                )
              }
            />
          )}

          {ocrProposal && (
            <CreatedProposalBanner
              proposal={ocrProposal}
              onInspectDrawer={(trigger) =>
                openDrawer(
                  {
                    kind: "proposal",
                    id: ocrProposal.id,
                    warehouse: ocrProposal.warehouse,
                    title: `销售订单草稿 · ${ocrProposal.id}`,
                  },
                  { tab: "current", trigger },
                )
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function CreatedProposalBanner({
  proposal,
  onInspectDrawer,
}: {
  proposal: Proposal;
  onInspectDrawer: (trigger: HTMLElement) => void;
}) {
  return (
    <div
      data-testid="orders-created-proposal-card"
      className="rounded-[4px] border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] p-4 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CheckCircle2
            className="h-4 w-4 text-[var(--status-emerald)]"
            strokeWidth={1.75}
          />
          <span className="text-[14px] font-semibold text-[var(--ink-primary)]">
            已生成提案 · 待审批
          </span>
          <StatusBadge status={proposal.state} compact />
        </div>
        <span className="font-mono-code text-[12px] text-[var(--ink-muted)]">
          digest {formatShortDigest(proposal.digest)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] px-3 py-2.5 text-[12px]">
        <div>
          <span className="text-[var(--ink-muted)]">提案编号：</span>
          <span
            className="font-mono-code font-semibold text-[var(--ink-primary)]"
            data-testid="orders-created-proposal-id"
          >
            {proposal.id}
          </span>
        </div>
        <div>
          <span className="text-[var(--ink-muted)]">仓库站点：</span>
          <span className="font-mono-code font-medium text-[var(--ink-primary)]">
            {proposal.warehouse}
          </span>
        </div>
        <div>
          <span className="text-[var(--ink-muted)]">业务目标：</span>
          <span className="font-mono-code text-[var(--ink-primary)]">
            {proposal.plan.target}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/proposals/${encodeURIComponent(proposal.id)}`}
          data-testid="orders-open-proposal-link"
          className="inline-flex h-8 items-center gap-1.5 rounded-[4px] bg-[var(--accent)] px-3 text-[12.5px] font-medium text-white hover:bg-[var(--accent-hover)]"
        >
          <span>打开提案详情页</span>
          <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Link>
        <Button
          size="sm"
          variant="secondary"
          onClick={(e) => onInspectDrawer(e.currentTarget)}
          data-testid="orders-inspect-drawer-btn"
        >
          <PanelRight className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>在右侧面板核对</span>
        </Button>
      </div>
    </div>
  );
}
