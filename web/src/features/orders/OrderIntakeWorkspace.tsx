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
  ScanSearch,
  Search,
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
import { formatShortDigest, sortWarehouses } from "@/lib/format";
import { useLocale, type TrilingualText } from "@/lib/i18n";
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

const BATCH_REVIEW_CODE_LABELS_I18N: Record<string, TrilingualText> = {
  INVALID_ORDER: {
    "zh-CN": "订单结构或字段格式校验失败",
    "zh-HK": "訂單結構或欄位格式校驗失敗",
    en: "Order structure or field format validation failed",
  },
  CONFLICTING_ORDER_REVISIONS: {
    "zh-CN": "同批次内存在相同 PO 冲突修订版本",
    "zh-HK": "同批次內存在相同 PO 衝突修訂版本",
    en: "Conflicting revisions for the same PO in this batch",
  },
  CURRENCY_OR_WAREHOUSE_UNSUPPORTED: {
    "zh-CN": "该仓库不支持所选币种或仓库配置",
    "zh-HK": "該倉庫不支援所選幣別或倉庫設定",
    en: "Currency or warehouse configuration is unsupported",
  },
  ORDER_LIMIT_EXCEEDED: {
    "zh-CN": "超出该仓库单笔订单总额上限",
    "zh-HK": "超出該倉庫單筆訂單總額上限",
    en: "Order total exceeds single-order warehouse limit",
  },
  MAPPING_MISSING: {
    "zh-CN": "商品 SKU / 买方 / 单位换算映射缺失",
    "zh-HK": "商品 SKU / 買方 / 單位換算對應缺失",
    en: "Missing SKU, buyer, or UOM conversion mapping",
  },
  LINE_AMOUNT_MISMATCH: {
    "zh-CN": "明细行金额与数量×单价不一致",
    "zh-HK": "明細行金額與數量×單價不一致",
    en: "Line amount does not match quantity × unit price",
  },
  ORDER_TOTAL_MISMATCH: {
    "zh-CN": "订单总额与明细行汇总不一致",
    "zh-HK": "訂單總額與明細行彙總不一致",
    en: "Order total does not match sum of line amounts",
  },
  POLICY_DENIED: {
    "zh-CN": "外部策略拒绝该提案",
    "zh-HK": "外部策略拒絕該提案",
    en: "Proposal rejected by external policy",
  },
};

const INPUT_CLASS =
  "h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[13px] text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]";

const CELL_INPUT_CLASS =
  "h-8.5 rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]";

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

  const { tx, formatCurrency } = useLocale();
  const { actor, capabilities, authGeneration, handleAccessChanged } =
    useSession();
  const { openDrawer } = useWorkbench();

  const authorizedWarehouses = useMemo(() => {
    const tool = capabilities?.tools.find(
      (tItem) => tItem.id === "order.draft.prepare" && tItem.available,
    );
    return sortWarehouses(tool?.warehouses ?? []);
  }, [capabilities]);

  const readableWarehouses = useMemo(
    () => sortWarehouses(capabilities?.order_read_warehouses ?? []),
    [capabilities],
  );

  const [warehouse, setWarehouse] = useState<string>("");
  const [activeTab, setActiveTab] = useState<IntakeTab>("structured");

  // Structured intake state
  const [form, setForm] = useState<StructuredFormState>(DEMO_STRUCTURED_FORM);
  const [poSuffixCounter, setPoSuffixCounter] = useState(1);
  const [structuredIntake, setStructuredIntake] =
    useState<StructuredIntakeResponse | null>(null);
  const [structuredFingerprint, setStructuredFingerprint] =
    useState<string>("");
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
          setBatchJsonError(
            tx({
              "zh-CN": "请输入非空的 JSON 订单数组（1–50 条）。",
              "zh-HK": "請輸入非空的 JSON 訂單陣列（1–50 筆）。",
              en: "Enter a non-empty JSON array of orders (1–50 items).",
            }),
          );
          return;
        }
        if (parsed.length > 50) {
          setBatchJsonError(
            tx({
              "zh-CN": "单次批量导入最多支持 50 条订单。",
              "zh-HK": "單次批次匯入最多支援 50 筆訂單。",
              en: "Batch import supports up to 50 orders per submission.",
            }),
          );
          return;
        }
        ordersPayload = parsed;
      } catch {
        setBatchJsonError(
          tx({
            "zh-CN": "JSON 格式无法解析，请检查逗号与引号。",
            "zh-HK": "JSON 格式無法解析，請檢查逗號與引號。",
            en: "Invalid JSON syntax — check commas and quotes.",
          }),
        );
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
      setOcrFileValidationError(
        tx({
          "zh-CN": "仅支持 PNG 或 JPEG 格式单据图片。",
          "zh-HK": "僅支援 PNG 或 JPEG 格式單據圖片。",
          en: "Only PNG or JPEG document images are supported.",
        }),
      );
      setOcrFile(null);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setOcrFileValidationError(
        tx(
          {
            "zh-CN": "文件大小 {mb} MB 超过 8 MB 限制。",
            "zh-HK": "檔案大小 {mb} MB 超過 8 MB 限制。",
            en: "File size ({mb} MB) exceeds the 8 MB limit.",
          },
          { mb: (file.size / 1_000_000).toFixed(2) },
        ),
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
        className="mx-auto max-w-[780px] p-4 lg:p-6 space-y-4"
        data-testid="order-access-restricted"
      >
        <AccessNoticeCard
          variant="ACCESS_RESTRICTED"
          title={tx({
            "zh-CN": "当前账号无订单进件写入权限",
            "zh-HK": "目前帳號無訂單進件寫入權限",
            en: "No Order Intake Write Permission",
          })}
          message={tx({
            "zh-CN":
              "新建销售订单进件需要 order.work 权限及有效仓库授权范围。如需查看已有进件或申请权限，请返回工作台或联系租户权限管理员。",
            "zh-HK":
              "新增銷售訂單進件需要 order.work 權限及有效倉庫授權範圍。如需檢視已有進件或申請權限，請返回工作台或聯絡租戶權限管理員。",
            en: "Creating sales order intakes requires order.work permission and an authorized warehouse scope. Return to the workbench or contact your access administrator.",
          })}
          backHref="/work"
        />

        {readableWarehouses.length > 0 && (
          <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 space-y-3.5">
            <h3 className="text-[14px] font-semibold text-[var(--ink-primary)]">
              {tx(
                {
                  "zh-CN": "只读查询已有进件证据（已授权读仓：{sites}）",
                  "zh-HK": "唯讀查詢已有進件憑證（已授權讀倉：{sites}）",
                  en: "Read-Only Intake Evidence Lookup (Warehouses: {sites})",
                },
                { sites: readableWarehouses.join(", ") },
              )}
            </h3>
            <div className="flex gap-2">
              <input
                type="text"
                value={lookupInput}
                onChange={(e) => setLookupInput(e.target.value)}
                placeholder={tx({
                  "zh-CN": "输入进件编号 (intake_id)",
                  "zh-HK": "輸入進件編號 (intake_id)",
                  en: "Enter intake ID",
                })}
                className={INPUT_CLASS}
              />
              <Button
                variant="secondary"
                pill
                loading={lookupLoading}
                onClick={() => void handleLookupIntake(lookupInput)}
              >
                <Search className="h-3.5 w-3.5" />
                <span>
                  {tx({
                    "zh-CN": "查询进件",
                    "zh-HK": "查詢進件",
                    en: "Look Up",
                  })}
                </span>
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
      className="mx-auto max-w-[1220px] space-y-5 p-4 sm:p-6 pb-20"
      data-testid="order-intake-workspace"
    >
      {/* Top Action Strip: Warehouse Selector, Mode Tabs & Saved Intake Lookup */}
      <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label
                htmlFor="order-warehouse-select"
                className="text-[12.5px] font-medium text-[var(--ink-secondary)]"
              >
                {tx({
                  "zh-CN": "目标仓库",
                  "zh-HK": "目標倉庫",
                  en: "Target Warehouse",
                })}
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
                className="h-9 rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
              >
                {authorizedWarehouses.map((wh) => (
                  <option key={wh} value={wh}>
                    {wh}
                  </option>
                ))}
              </select>
            </div>

            <span
              aria-hidden="true"
              className="hidden sm:inline-block h-5 w-px bg-[var(--hairline)]"
            />

            <div
              role="tablist"
              aria-label={tx({
                "zh-CN": "订单进件方式",
                "zh-HK": "訂單進件方式",
                en: "Order intake mode",
              })}
              className="inline-flex flex-wrap items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] p-1"
            >
              {(
                [
                  {
                    id: "structured" as const,
                    label: tx({
                      "zh-CN": "结构化单笔进件",
                      "zh-HK": "結構化單筆進件",
                      en: "Structured PO",
                    }),
                    icon: FileText,
                    testId: "orders-tab-structured",
                  },
                  {
                    id: "batch" as const,
                    label: tx({
                      "zh-CN": "批量结构化进件 (≤50)",
                      "zh-HK": "批次結構化進件 (≤50)",
                      en: "Batch Intake (≤50)",
                    }),
                    icon: Layers,
                    testId: "orders-tab-batch",
                  },
                  {
                    id: "ocr" as const,
                    label: tx({
                      "zh-CN": "单据图片 OCR 进件",
                      "zh-HK": "單據圖片 OCR 進件",
                      en: "Image OCR Intake",
                    }),
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
                      "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] transition-all duration-[165ms] cursor-pointer",
                      active
                        ? "bg-[var(--bg-surface)] text-[var(--accent-ink)] font-semibold shadow-[var(--shadow-subtle)]"
                        : "text-[var(--ink-secondary)] font-medium hover:text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.85} />
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
              placeholder={tx({
                "zh-CN": "按 intake_id 查询历史进件",
                "zh-HK": "按 intake_id 查詢歷史進件",
                en: "Look up saved intake ID",
              })}
              data-testid="orders-intake-lookup-input"
              className="h-9 w-48 sm:w-56 rounded-full border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3.5 font-mono-code text-[12px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
            />
            <Button
              type="submit"
              size="sm"
              pill
              variant="secondary"
              loading={lookupLoading}
              data-testid="orders-intake-lookup-btn"
            >
              <Search className="h-3.5 w-3.5" />
              <span>
                {tx({ "zh-CN": "调阅", "zh-HK": "調閱", en: "Look Up" })}
              </span>
            </Button>
          </form>
        </div>

        {/* Lookup Result Panel (if user searched or arrived via ?intake=...) */}
        {(lookupError || lookupDetail) && (
          <div className="border-t border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "历史进件证据",
                  "zh-HK": "歷史進件憑證",
                  en: "Saved Intake Evidence",
                })}
              </span>
              <button
                type="button"
                onClick={() => {
                  setLookupDetail(null);
                  setLookupError(null);
                }}
                className="rounded-full px-2.5 py-1 text-[12px] text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
              >
                {tx({ "zh-CN": "收起", "zh-HK": "收合", en: "Collapse" })}
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
                <div className="rounded-tile bg-[var(--bg-surface)] shadow-[var(--shadow-subtle)] p-4 space-y-2 text-[12.5px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono-code font-semibold text-[var(--ink-primary)]">
                      {lookupDetail.id} · {lookupDetail.data.warehouse} · PO{" "}
                      {lookupDetail.data.evidence.order.po}
                    </span>
                    <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 font-mono-code text-[11px] text-[var(--ink-muted)]">
                      SHA-256{" "}
                      {formatShortDigest(
                        lookupDetail.data.evidence.artifact_sha256,
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--ink-secondary)]">
                    <span>
                      {tx({
                        "zh-CN": "买方：",
                        "zh-HK": "買方：",
                        en: "Buyer: ",
                      })}
                      <span className="font-mono-code">
                        {lookupDetail.data.evidence.order.buyer}
                      </span>
                    </span>
                    <span>
                      {tx({
                        "zh-CN": "交期：",
                        "zh-HK": "交期：",
                        en: "Delivery: ",
                      })}
                      <span className="font-mono-code tabular-nums">
                        {lookupDetail.data.evidence.order.delivery}
                      </span>
                    </span>
                    <span className="font-semibold text-[var(--ink-primary)]">
                      {tx({
                        "zh-CN": "总额：",
                        "zh-HK": "總額：",
                        en: "Total: ",
                      })}
                      <span className="font-mono-code tabular-nums">
                        {formatCurrency(
                          lookupDetail.data.evidence.order.total,
                          lookupDetail.data.evidence.order.currency,
                        )}
                      </span>
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
            className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] px-5 py-4">
              <div>
                <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                  {tx({
                    "zh-CN": "结构化采购单进件",
                    "zh-HK": "結構化採購單進件",
                    en: "Structured Purchase Order Intake",
                  })}
                </h2>
                <p className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "第 1 步写入内容寻址进件（仓库 ",
                    "zh-HK": "第 1 步寫入內容定址進件（倉庫 ",
                    en: "Step 1 writes a content-addressed intake (warehouse ",
                  })}
                  <span className="font-mono-code text-[var(--ink-secondary)]">
                    {warehouse || "—"}
                  </span>
                  {tx({
                    "zh-CN": "），第 2 步携带稳定幂等键生成 ERP 销售草稿提案。",
                    "zh-HK": "），第 2 步攜帶穩定冪等鍵產生 ERP 銷售草稿提案。",
                    en: "); Step 2 prepares an idempotent ERP sales order draft proposal.",
                  })}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  pill
                  variant="secondary"
                  onClick={handlePrefillDemo}
                  data-testid="orders-prefill-demo-btn"
                >
                  <ScanSearch className="h-3.5 w-3.5 text-[var(--accent)]" />
                  <span>
                    {tx({
                      "zh-CN": "载入演示样例 (FE-DEMO-001)",
                      "zh-HK": "載入示範樣例 (FE-DEMO-001)",
                      en: "Prefill Sample (FE-DEMO-001)",
                    })}
                  </span>
                </Button>
                <Button
                  size="sm"
                  pill
                  variant="ghost"
                  onClick={handleGenerateNewPoSuffix}
                  data-testid="orders-po-suffix-btn"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>
                    {tx({
                      "zh-CN": "生成新 PO 后缀",
                      "zh-HK": "產生新 PO 後綴",
                      en: "New PO Suffix",
                    })}
                  </span>
                </Button>
              </div>
            </div>

            <div className="p-5 space-y-5">
              {/* Header Fields */}
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-5">
                <label className="block space-y-1.5">
                  <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                    {tx({
                      "zh-CN": "采购单号 (PO)",
                      "zh-HK": "採購單號 (PO)",
                      en: "Purchase Order (PO)",
                    })}
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
                    className={INPUT_CLASS}
                  />
                  {fieldErrorMap.has("po") && (
                    <span className="block text-[11.5px] text-[var(--status-crimson)]">
                      {fieldErrorMap.get("po")}
                    </span>
                  )}
                </label>

                <label className="block space-y-1.5">
                  <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                    {tx({
                      "zh-CN": "买方编码 (Buyer)",
                      "zh-HK": "買方編號 (Buyer)",
                      en: "Buyer Code",
                    })}
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
                    className={INPUT_CLASS}
                  />
                  {fieldErrorMap.has("buyer") && (
                    <span className="block text-[11.5px] text-[var(--status-crimson)]">
                      {fieldErrorMap.get("buyer")}
                    </span>
                  )}
                </label>

                <label className="block space-y-1.5">
                  <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                    {tx({
                      "zh-CN": "币种 (ISO-4217)",
                      "zh-HK": "幣別 (ISO-4217)",
                      en: "Currency (ISO-4217)",
                    })}
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
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="block space-y-1.5">
                  <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                    {tx({
                      "zh-CN": "交付日期",
                      "zh-HK": "交付日期",
                      en: "Delivery Date",
                    })}
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
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="block space-y-1.5">
                  <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                    {tx({
                      "zh-CN": "订单总额",
                      "zh-HK": "訂單總額",
                      en: "Order Total",
                    })}
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
                    className={`${INPUT_CLASS} text-right font-semibold tabular-nums`}
                  />
                </label>
              </div>

              {/* Line Items Well */}
              <div className="rounded-tile bg-[var(--bg-surface-tint)] overflow-hidden">
                <div className="flex items-center justify-between border-b border-[var(--hairline-subtle)] px-4 py-2.5">
                  <span className="text-[13px] font-semibold text-[var(--ink-primary)]">
                    {tx({
                      "zh-CN": "商品明细行",
                      "zh-HK": "商品明細行",
                      en: "Order Line Items",
                    })}
                    <span className="ml-1.5 tabular-nums text-[12px] font-normal text-[var(--ink-muted)]">
                      ({form.lines.length})
                    </span>
                  </span>
                  <Button
                    size="sm"
                    pill
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
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>
                      {tx({
                        "zh-CN": "添加明细行",
                        "zh-HK": "新增明細行",
                        en: "Add Line",
                      })}
                    </span>
                  </Button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-[12.5px]">
                    <thead>
                      <tr className="border-b border-[var(--hairline-subtle)] text-[11.5px] text-[var(--ink-muted)]">
                        <th className="px-3.5 py-2 font-medium">SKU</th>
                        <th className="px-3.5 py-2 font-medium">
                          {tx({
                            "zh-CN": "源单位",
                            "zh-HK": "源單位",
                            en: "UOM",
                          })}
                        </th>
                        <th className="px-3.5 py-2 font-medium text-right">
                          {tx({
                            "zh-CN": "数量",
                            "zh-HK": "數量",
                            en: "Qty",
                          })}
                        </th>
                        <th className="px-3.5 py-2 font-medium text-right">
                          {tx({
                            "zh-CN": "单价",
                            "zh-HK": "單價",
                            en: "Unit Price",
                          })}
                        </th>
                        <th className="px-3.5 py-2 font-medium text-right">
                          {tx({
                            "zh-CN": "行金额",
                            "zh-HK": "行金額",
                            en: "Amount",
                          })}
                        </th>
                        <th className="px-2 py-2 w-10" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--hairline-subtle)]">
                      {form.lines.map((line, idx) => (
                        <tr key={line.id}>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              required
                              value={line.sku}
                              onChange={(e) =>
                                updateLine(idx, { sku: e.target.value })
                              }
                              data-testid={`orders-line-${idx}-sku`}
                              className={`${CELL_INPUT_CLASS} w-full min-w-[120px]`}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              required
                              value={line.unit}
                              onChange={(e) =>
                                updateLine(idx, { unit: e.target.value })
                              }
                              data-testid={`orders-line-${idx}-unit`}
                              className={`${CELL_INPUT_CLASS} w-24`}
                            />
                          </td>
                          <td className="px-3 py-2">
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
                              className={`${CELL_INPUT_CLASS} w-24 ml-auto block text-right tabular-nums`}
                            />
                          </td>
                          <td className="px-3 py-2">
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
                              className={`${CELL_INPUT_CLASS} w-28 ml-auto block text-right tabular-nums`}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              required
                              value={line.amount}
                              onChange={(e) =>
                                updateLine(idx, { amount: e.target.value })
                              }
                              data-testid={`orders-line-${idx}-amount`}
                              className={`${CELL_INPUT_CLASS} w-28 ml-auto block text-right font-semibold tabular-nums`}
                            />
                          </td>
                          <td className="px-2 py-2 text-center">
                            <button
                              type="button"
                              disabled={form.lines.length <= 1}
                              onClick={() =>
                                setForm((prev) => ({
                                  ...prev,
                                  lines: prev.lines.filter((_, i) => i !== idx),
                                }))
                              }
                              aria-label={tx({
                                "zh-CN": "删除行",
                                "zh-HK": "刪除行",
                                en: "Remove line",
                              })}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--status-crimson-wash)] hover:text-[var(--status-crimson)] disabled:opacity-30 transition-colors cursor-pointer"
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
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--hairline-subtle)] pt-4">
                <div className="space-y-0.5 text-[12.5px]">
                  {structuredIntake && !formModifiedSinceIntake ? (
                    <div className="flex flex-wrap items-center gap-2 text-[var(--status-emerald)]">
                      <CheckCircle2 className="h-4 w-4" strokeWidth={1.85} />
                      <span>
                        {tx({
                          "zh-CN": "步骤 1 完成 · 进件号",
                          "zh-HK": "步驟 1 完成 · 進件號",
                          en: "Step 1 complete · Intake",
                        })}{" "}
                        <span
                          className="font-mono-code font-semibold"
                          data-testid="orders-intake-id-value"
                        >
                          {structuredIntake.intake_id}
                        </span>
                      </span>
                      <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 text-[11px] text-[var(--ink-muted)]">
                        {tx({
                          "zh-CN": "幂等键：",
                          "zh-HK": "冪等鍵：",
                          en: "Idempotency key: ",
                        })}
                        <span className="font-mono-code text-[var(--ink-secondary)]">
                          {formatShortDigest(structuredIdemKey, 10, 6)}
                        </span>
                      </span>
                    </div>
                  ) : (
                    <span className="text-[var(--ink-muted)]">
                      {formModifiedSinceIntake
                        ? tx({
                            "zh-CN":
                              "表单字段已修改，将重新提交进件并生成新的幂等键。",
                            "zh-HK":
                              "表單欄位已修改，將重新提交進件並產生新的冪等鍵。",
                            en: "Form changed — submitting again creates a fresh intake and idempotency key.",
                          })
                        : tx({
                            "zh-CN":
                              "支持分步提交，或一键完成「写入进件 → 生成 ERP 销售草稿提案」。",
                            "zh-HK":
                              "支援分步提交，或一鍵完成「寫入進件 → 產生 ERP 銷售草稿提案」。",
                            en: "Run steps individually or submit & prepare an ERP sales draft in one click.",
                          })}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    pill
                    loading={structuredSubmitting}
                    onClick={() => void handleStep1SubmitStructured()}
                    data-testid="orders-submit-intake-btn"
                  >
                    {tx({
                      "zh-CN": "1. 提交结构化进件",
                      "zh-HK": "1. 提交結構化進件",
                      en: "1. Save Intake",
                    })}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    pill
                    disabled={!structuredIntake || formModifiedSinceIntake}
                    loading={structuredPreparing}
                    onClick={() => void handleStep2PrepareProposal()}
                    data-testid="orders-prepare-proposal-btn"
                  >
                    {tx({
                      "zh-CN": "2. 生成订单提案",
                      "zh-HK": "2. 產生訂單提案",
                      en: "2. Prepare Proposal",
                    })}
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    pill
                    loading={structuredSubmitting || structuredPreparing}
                    data-testid="orders-submit-and-prepare-btn"
                  >
                    {tx({
                      "zh-CN": "提交并生成提案",
                      "zh-HK": "提交並產生提案",
                      en: "Submit & Prepare Draft",
                    })}
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
                    title: tx(
                      {
                        "zh-CN": "销售订单草稿 · {id}",
                        "zh-HK": "銷售訂單草稿 · {id}",
                        en: "Sales Order Draft · {id}",
                      },
                      { id: createdProposal.id },
                    ),
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
          <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] px-5 py-4">
              <div>
                <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                  {tx({
                    "zh-CN": "批量结构化订单进件",
                    "zh-HK": "批次結構化訂單進件",
                    en: "Batch Structured Order Intake",
                  })}
                </h2>
                <p className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "一次向仓库 ",
                    "zh-HK": "一次向倉庫 ",
                    en: "Submit 1–50 purchase orders to ",
                  })}
                  <span className="font-mono-code text-[var(--ink-secondary)]">
                    {warehouse || "—"}
                  </span>
                  {tx({
                    "zh-CN":
                      " 提交 1–50 条采购单，逐条返回已生成提案或需人工复核原因。",
                    "zh-HK":
                      " 提交 1–50 筆採購單，逐筆回傳已產生提案或須人工覆核原因。",
                    en: " at once; each row returns either a prepared proposal or review diagnostics.",
                  })}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  pill
                  variant="secondary"
                  onClick={handleLoadBatchSample}
                  data-testid="orders-batch-load-sample-btn"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 text-[var(--accent)]" />
                  <span>
                    {tx({
                      "zh-CN": "载入批量示例（1 正常 + 1 异常）",
                      "zh-HK": "載入批次示範（1 正常 + 1 異常）",
                      en: "Load Batch Sample (1 OK + 1 Review)",
                    })}
                  </span>
                </Button>
                <div className="inline-flex rounded-full bg-[var(--bg-surface-subtle)] p-1">
                  <button
                    type="button"
                    onClick={() => setBatchMode("rows")}
                    className={[
                      "rounded-full px-3 py-1 text-[12px] font-medium transition-all cursor-pointer",
                      batchMode === "rows"
                        ? "bg-[var(--bg-surface)] text-[var(--accent-ink)] font-semibold shadow-[var(--shadow-subtle)]"
                        : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    {tx({
                      "zh-CN": "多行表格",
                      "zh-HK": "多行表格",
                      en: "Table Rows",
                    })}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setBatchJsonText(JSON.stringify(batchOrders, null, 2));
                      setBatchMode("json");
                    }}
                    className={[
                      "rounded-full px-3 py-1 text-[12px] font-medium transition-all cursor-pointer",
                      batchMode === "json"
                        ? "bg-[var(--bg-surface)] text-[var(--accent-ink)] font-semibold shadow-[var(--shadow-subtle)]"
                        : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    {tx({
                      "zh-CN": "JSON 编辑",
                      "zh-HK": "JSON 編輯",
                      en: "JSON Editor",
                    })}
                  </button>
                </div>
              </div>
            </div>

            <div className="p-5 space-y-4">
              {batchMode === "rows" ? (
                <div className="space-y-3">
                  <div className="overflow-x-auto rounded-tile bg-[var(--bg-surface-tint)]">
                    <table className="w-full border-collapse text-left text-[12px]">
                      <thead>
                        <tr className="border-b border-[var(--hairline-subtle)] text-[11.5px] text-[var(--ink-muted)]">
                          <th className="px-3 py-2.5 font-medium">#</th>
                          <th className="px-3 py-2.5 font-medium">PO</th>
                          <th className="px-3 py-2.5 font-medium">
                            {tx({
                              "zh-CN": "买方",
                              "zh-HK": "買方",
                              en: "Buyer",
                            })}
                          </th>
                          <th className="px-3 py-2.5 font-medium">
                            {tx({
                              "zh-CN": "交期",
                              "zh-HK": "交期",
                              en: "Delivery",
                            })}
                          </th>
                          <th className="px-3 py-2.5 font-medium">SKU</th>
                          <th className="px-3 py-2.5 font-medium text-right">
                            {tx({
                              "zh-CN": "数量",
                              "zh-HK": "數量",
                              en: "Qty",
                            })}
                          </th>
                          <th className="px-3 py-2.5 font-medium text-right">
                            {tx({
                              "zh-CN": "单价",
                              "zh-HK": "單價",
                              en: "Unit Price",
                            })}
                          </th>
                          <th className="px-3 py-2.5 font-medium text-right">
                            {tx({
                              "zh-CN": "总额 (HKD)",
                              "zh-HK": "總額 (HKD)",
                              en: "Total (HKD)",
                            })}
                          </th>
                          <th className="px-2 py-2.5 w-10" />
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
                              <td className="px-3 py-2 font-mono-code text-[var(--ink-muted)]">
                                {idx + 1}
                              </td>
                              <td className="p-2">
                                <input
                                  type="text"
                                  value={ord.po}
                                  onChange={(e) =>
                                    patchRow({ po: e.target.value })
                                  }
                                  className={`${CELL_INPUT_CLASS} w-32`}
                                />
                              </td>
                              <td className="p-2">
                                <input
                                  type="text"
                                  value={ord.buyer}
                                  onChange={(e) =>
                                    patchRow({ buyer: e.target.value })
                                  }
                                  className={`${CELL_INPUT_CLASS} w-24`}
                                />
                              </td>
                              <td className="p-2">
                                <input
                                  type="date"
                                  value={ord.delivery}
                                  onChange={(e) =>
                                    patchRow({ delivery: e.target.value })
                                  }
                                  className={`${CELL_INPUT_CLASS} w-36`}
                                />
                              </td>
                              <td className="p-2">
                                <input
                                  type="text"
                                  value={firstLine.sku}
                                  onChange={(e) =>
                                    patchFirstLine({ sku: e.target.value })
                                  }
                                  className={`${CELL_INPUT_CLASS} w-28`}
                                />
                              </td>
                              <td className="p-2">
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
                                  className={`${CELL_INPUT_CLASS} w-20 ml-auto block text-right tabular-nums`}
                                />
                              </td>
                              <td className="p-2">
                                <input
                                  type="text"
                                  value={firstLine.unit_price}
                                  onChange={(e) =>
                                    patchFirstLine({
                                      unit_price: e.target.value,
                                    })
                                  }
                                  className={`${CELL_INPUT_CLASS} w-24 ml-auto block text-right tabular-nums`}
                                />
                              </td>
                              <td className="px-3 py-2 text-right font-mono-code tabular-nums font-semibold text-[var(--ink-primary)]">
                                {ord.total}
                              </td>
                              <td className="p-2 text-center">
                                <button
                                  type="button"
                                  disabled={batchOrders.length <= 1}
                                  aria-label={tx({
                                    "zh-CN": "删除订单行",
                                    "zh-HK": "刪除訂單行",
                                    en: "Remove order row",
                                  })}
                                  onClick={() =>
                                    setBatchOrders((prev) =>
                                      prev.filter((_, i) => i !== idx),
                                    )
                                  }
                                  className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--status-crimson-wash)] hover:text-[var(--status-crimson)] disabled:opacity-30 cursor-pointer"
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
                    pill
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
                    <span>
                      {tx({
                        "zh-CN": "新增订单行",
                        "zh-HK": "新增訂單行",
                        en: "Add Order Row",
                      })}
                    </span>
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
                    className="w-full rounded-tile border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] p-3.5 font-mono-code text-[12px] text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
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

              <div className="flex items-center justify-end border-t border-[var(--hairline-subtle)] pt-3.5">
                <Button
                  variant="primary"
                  pill
                  loading={batchSubmitting}
                  onClick={() => void handleSubmitBatch()}
                  data-testid="orders-batch-submit-btn"
                >
                  {tx(
                    {
                      "zh-CN": "批量校验并提交 ({count})",
                      "zh-HK": "批次校驗並提交 ({count})",
                      en: "Validate & Submit Batch ({count})",
                    },
                    {
                      count:
                        batchMode === "rows" ? batchOrders.length : "JSON",
                    },
                  )}
                </Button>
              </div>
            </div>
          </div>

          {/* Per-item Batch Outcome Table */}
          {batchItems && (
            <div
              className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden"
              data-testid="orders-batch-results"
            >
              <div className="flex items-center justify-between border-b border-[var(--hairline)] px-5 py-3.5">
                <span className="text-[14px] font-semibold text-[var(--ink-primary)]">
                  {tx({
                    "zh-CN": "批量进件结果明细",
                    "zh-HK": "批次進件結果明細",
                    en: "Batch Intake Results",
                  })}
                </span>
                <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 tabular-nums text-[11.5px] text-[var(--ink-secondary)]">
                  {tx(
                    {
                      "zh-CN": "已生成 {prepared} · 待复核 {review}",
                      "zh-HK": "已產生 {prepared} · 待覆核 {review}",
                      en: "Prepared {prepared} · Needs review {review}",
                    },
                    {
                      prepared: batchItems.filter(
                        (i) => i.status === "prepared",
                      ).length,
                      review: batchItems.filter((i) => i.status === "review")
                        .length,
                    },
                  )}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[11.5px] text-[var(--ink-muted)]">
                      <th className="px-4 py-2.5 font-medium">
                        {tx({ "zh-CN": "序号", "zh-HK": "序號", en: "#" })}
                      </th>
                      <th className="px-3.5 py-2.5 font-medium">
                        {tx({
                          "zh-CN": "处理结果",
                          "zh-HK": "處理結果",
                          en: "Outcome",
                        })}
                      </th>
                      <th className="px-3.5 py-2.5 font-medium">
                        {tx({
                          "zh-CN": "进件 / 提案编号",
                          "zh-HK": "進件 / 提案編號",
                          en: "Intake / Proposal ID",
                        })}
                      </th>
                      <th className="px-3.5 py-2.5 font-medium">
                        {tx({
                          "zh-CN": "详情 / 复核原因",
                          "zh-HK": "詳情 / 覆核原因",
                          en: "Details / Review Reason",
                        })}
                      </th>
                      <th className="px-4 py-2.5 font-medium text-right">
                        {tx({
                          "zh-CN": "操作",
                          "zh-HK": "操作",
                          en: "Actions",
                        })}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--hairline-subtle)]">
                    {batchItems.map((item) => (
                      <tr
                        key={`batch-res-${item.position}`}
                        className="hover:bg-[var(--bg-surface-tint)]/80 transition-colors"
                      >
                        <td className="px-4 py-3 font-mono-code text-[var(--ink-muted)]">
                          #{item.position + 1}
                        </td>
                        <td className="px-3.5 py-3">
                          {item.status === "prepared" ? (
                            <StatusBadge status={item.state} compact />
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-amber-wash)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--status-amber-ink)]">
                              <AlertTriangle className="h-3 w-3" />
                              <span>
                                {tx({
                                  "zh-CN": "需人工复核",
                                  "zh-HK": "須人工覆核",
                                  en: "Needs Review",
                                })}
                              </span>
                            </span>
                          )}
                        </td>
                        <td className="px-3.5 py-3 text-[12px]">
                          {item.status === "prepared" ? (
                            <div>
                              <div className="font-mono-code font-semibold text-[var(--ink-primary)]">
                                {item.proposal_id}
                              </div>
                              <div className="text-[11px] text-[var(--ink-muted)]">
                                {tx({
                                  "zh-CN": "进件 ",
                                  "zh-HK": "進件 ",
                                  en: "Intake ",
                                })}
                                <span className="font-mono-code">
                                  {item.intake_id}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <span
                              className={
                                item.intake_id
                                  ? "font-mono-code text-[var(--ink-muted)]"
                                  : "text-[var(--ink-muted)]"
                              }
                            >
                              {item.intake_id ||
                                tx({
                                  "zh-CN": "未写入进件",
                                  "zh-HK": "未寫入進件",
                                  en: "Not persisted",
                                })}
                            </span>
                          )}
                        </td>
                        <td className="px-3.5 py-3 text-[12px]">
                          {item.status === "prepared" ? (
                            <span className="text-[11.5px] text-[var(--ink-muted)]">
                              {tx({
                                "zh-CN": "摘要 ",
                                "zh-HK": "摘要 ",
                                en: "Digest ",
                              })}
                              <span className="font-mono-code text-[var(--ink-secondary)]">
                                {formatShortDigest(item.digest)}
                              </span>
                            </span>
                          ) : (
                            <div className="space-y-0.5">
                              <div className="font-medium text-[var(--status-amber-ink)]">
                                {BATCH_REVIEW_CODE_LABELS_I18N[item.code]
                                  ? tx(BATCH_REVIEW_CODE_LABELS_I18N[item.code]!)
                                  : item.code}
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
                        <td className="px-4 py-3 text-right">
                          {item.status === "prepared" && (
                            <div className="inline-flex items-center gap-1.5">
                              <Button
                                size="sm"
                                pill
                                variant="quiet"
                                onClick={(e) =>
                                  openDrawer(
                                    {
                                      kind: "proposal",
                                      id: item.proposal_id,
                                      warehouse,
                                      title: tx(
                                        {
                                          "zh-CN": "销售订单草稿 · {id}",
                                          "zh-HK": "銷售訂單草稿 · {id}",
                                          en: "Sales Order Draft · {id}",
                                        },
                                        { id: item.proposal_id },
                                      ),
                                    },
                                    { tab: "current", trigger: e.currentTarget },
                                  )
                                }
                              >
                                {tx({
                                  "zh-CN": "面板查看",
                                  "zh-HK": "面板檢視",
                                  en: "Inspect",
                                })}
                              </Button>
                              <Link
                                href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                                className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] px-3 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] transition-colors"
                              >
                                <span>
                                  {tx({
                                    "zh-CN": "详情",
                                    "zh-HK": "詳情",
                                    en: "Details",
                                  })}
                                </span>
                                <ArrowUpRight className="h-3.5 w-3.5" />
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
          <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                  {tx({
                    "zh-CN": "单据图片 OCR 进件与坐标定位核对",
                    "zh-HK": "單據圖片 OCR 進件與座標定位核對",
                    en: "Image OCR Intake & Bounding-Box Verification",
                  })}
                </h2>
                <p className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN":
                      "上传 PNG / JPEG 单据（≤ 8 MB），本地预览通过临时对象地址管理，切换账号或离开页面时立即释放。",
                    "zh-HK":
                      "上傳 PNG / JPEG 單據（≤ 8 MB），本地預覽透過臨時物件網址管理，切換帳號或離開頁面時立即釋放。",
                    en: "Upload a PNG or JPEG purchase order (≤ 8 MB). Local object previews are revoked immediately on identity switch or navigation.",
                  })}
                </p>
              </div>
              <SourceTag source="internal" />
            </div>

            <div className="flex flex-wrap items-center gap-3 rounded-tile border border-dashed border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] p-4.5">
              <input
                type="file"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                onChange={(e) =>
                  handleOcrFileSelect(e.target.files?.[0] ?? null)
                }
                data-testid="orders-ocr-file-input"
                className="block max-w-full text-[12.5px] text-[var(--ink-secondary)] file:mr-3 file:rounded-full file:border-0 file:bg-[var(--bg-surface)] file:px-3.5 file:py-1.5 file:text-[12px] file:font-medium file:text-[var(--ink-primary)] file:shadow-[var(--shadow-subtle)] file:cursor-pointer hover:file:bg-[var(--bg-hover)]"
              />
              {ocrFile && (
                <span className="rounded-full bg-[var(--bg-surface)] px-2.5 py-0.5 font-mono-code text-[11.5px] text-[var(--ink-muted)] shadow-[var(--shadow-subtle)]">
                  {ocrFile.name} · {(ocrFile.size / 1024).toFixed(1)} KB
                </span>
              )}
              <div className="ml-auto">
                <Button
                  variant="primary"
                  pill
                  disabled={!ocrFile || !warehouse}
                  loading={ocrUploading}
                  onClick={() => void handleUploadOcr()}
                  data-testid="orders-ocr-upload-btn"
                >
                  <ImageUp className="h-4 w-4" strokeWidth={1.85} />
                  <span>
                    {tx({
                      "zh-CN": "上传并执行本地 OCR 提取",
                      "zh-HK": "上傳並執行本地 OCR 擷取",
                      en: "Upload & Run Local OCR",
                    })}
                  </span>
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
                    title: tx(
                      {
                        "zh-CN": "销售订单草稿 · {id}",
                        "zh-HK": "銷售訂單草稿 · {id}",
                        en: "Sales Order Draft · {id}",
                      },
                      { id: ocrProposal.id },
                    ),
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
  const { tx } = useLocale();
  return (
    <div
      data-testid="orders-created-proposal-card"
      className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--status-emerald-wash)] px-5 py-3.5">
        <div className="flex items-center gap-2">
          <CheckCircle2
            className="h-4 w-4 text-[var(--status-emerald)]"
            strokeWidth={1.9}
          />
          <span className="text-[14px] font-semibold text-[var(--ink-primary)]">
            {tx({
              "zh-CN": "已生成 ERP 销售草稿提案",
              "zh-HK": "已產生 ERP 銷售草稿提案",
              en: "ERP Sales Order Draft Proposal Created",
            })}
          </span>
          <StatusBadge status={proposal.state} compact />
        </div>
        <span className="rounded-full bg-[var(--bg-surface)] px-2.5 py-0.5 text-[11.5px] text-[var(--ink-muted)] shadow-[var(--shadow-subtle)]">
          {tx({
            "zh-CN": "摘要 ",
            "zh-HK": "摘要 ",
            en: "Digest ",
          })}
          <span className="font-mono-code text-[var(--ink-secondary)]">
            {formatShortDigest(proposal.digest)}
          </span>
        </span>
      </div>

      <div className="p-5 space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-[12.5px]">
          <div className="rounded-sm bg-[var(--bg-surface-tint)] px-3.5 py-2.5">
            <div className="text-[11px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "提案编号",
                "zh-HK": "提案編號",
                en: "Proposal ID",
              })}
            </div>
            <div
              className="mt-0.5 font-mono-code font-semibold text-[var(--ink-primary)]"
              data-testid="orders-created-proposal-id"
            >
              {proposal.id}
            </div>
          </div>
          <div className="rounded-sm bg-[var(--bg-surface-tint)] px-3.5 py-2.5">
            <div className="text-[11px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "仓库",
                "zh-HK": "倉庫",
                en: "Warehouse",
              })}
            </div>
            <div className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)]">
              {proposal.warehouse}
            </div>
          </div>
          <div className="rounded-sm bg-[var(--bg-surface-tint)] px-3.5 py-2.5">
            <div className="text-[11px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "业务目标",
                "zh-HK": "業務目標",
                en: "Target",
              })}
            </div>
            <div className="mt-0.5 font-mono-code text-[var(--ink-primary)] break-all">
              {proposal.plan.target}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/proposals/${encodeURIComponent(proposal.id)}`}
            data-testid="orders-open-proposal-link"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent-solid)] px-4 text-[13px] font-medium text-[var(--accent-fg)] shadow-[var(--shadow-subtle)] hover:bg-[var(--accent-solid-hover)] transition-all duration-[160ms]"
          >
            <span>
              {tx({
                "zh-CN": "打开提案详情页",
                "zh-HK": "開啟提案詳情頁",
                en: "Open Proposal Page",
              })}
            </span>
            <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.85} />
          </Link>
          <Button
            size="md"
            pill
            variant="secondary"
            onClick={(e) => onInspectDrawer(e.currentTarget)}
            data-testid="orders-inspect-drawer-btn"
          >
            <PanelRight className="h-3.5 w-3.5" strokeWidth={1.85} />
            <span>
              {tx({
                "zh-CN": "在右侧面板核对",
                "zh-HK": "於右側面板核對",
                en: "Inspect in Drawer",
              })}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}
