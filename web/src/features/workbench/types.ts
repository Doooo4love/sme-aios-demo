import {
  ASSURANCE_FIELD_LABELS_I18N,
  ASSURANCE_KIND_LABELS_I18N,
  ASSURANCE_TRACK_LABELS_I18N,
  DEFAULT_LOCALE,
  translateInline,
  translateKey,
  type Locale,
  type TrilingualText,
} from "@/lib/i18n";
import type {
  Actor,
  AssuranceKind,
  AssuranceTrack,
  Capabilities,
  Grant,
  TaskItem,
} from "@/lib/types";

export type WorkbenchModuleId =
  | "queues"
  | "orders"
  | "approvals"
  | "dispatch"
  | "finance"
  | "assurance"
  | "decision";

export type PermissionTierId =
  | "execution"
  | "specialist"
  | "approval_decision"
  | "governance";

export interface PermissionTierSpec {
  id: PermissionTierId;
  label: string;
  subtitle: string;
  moduleIds: readonly WorkbenchModuleId[];
}

const PERMISSION_TIER_MODULES: ReadonlyArray<{
  id: PermissionTierId;
  moduleIds: readonly WorkbenchModuleId[];
}> = [
  { id: "execution", moduleIds: ["queues", "orders", "dispatch"] },
  { id: "specialist", moduleIds: ["finance", "assurance"] },
  { id: "approval_decision", moduleIds: ["approvals", "decision"] },
  { id: "governance", moduleIds: [] },
];

export function getPermissionTiers(
  locale: Locale = DEFAULT_LOCALE,
): PermissionTierSpec[] {
  return PERMISSION_TIER_MODULES.map((tier) => ({
    id: tier.id,
    label: translateKey(locale, `workbench.tier.${tier.id}.label`),
    subtitle: translateKey(locale, `workbench.tier.${tier.id}.subtitle`),
    moduleIds: tier.moduleIds,
  }));
}

export const PERMISSION_TIERS: readonly PermissionTierSpec[] =
  getPermissionTiers(DEFAULT_LOCALE);

export interface WorkbenchModuleSpec {
  id: WorkbenchModuleId;
  tier: Exclude<PermissionTierId, "governance">;
  label: string;
  shortLabel: string;
  code: string;
  description: string;
  required: boolean;
}

const MODULE_META_BASE: Record<
  WorkbenchModuleId,
  {
    tier: Exclude<PermissionTierId, "governance">;
    code: string;
    required: boolean;
    description: TrilingualText;
  }
> = {
  queues: {
    tier: "execution",
    code: "QUEUES",
    required: true,
    description: {
      "zh-CN": "集中查看待我处理与已提交单据，支持合并视角与快速侧边核对",
      "zh-HK": "集中檢視待我處理與已提交單據，支援合併檢視與快速側邊核對",
      en: "View assigned and submitted proposals with unified tracking and side-drawer inspection",
    },
  },
  orders: {
    tier: "execution",
    code: "ORDERS",
    required: false,
    description: {
      "zh-CN": "销售订单结构化与 OCR 进件入口、订单提案追踪与历史进件调阅",
      "zh-HK": "銷售訂單結構化與 OCR 進件入口、訂單提案追蹤與歷史進件調閱",
      en: "Structured & OCR sales order intake, draft proposal tracking, and saved intake lookup",
    },
  },
  dispatch: {
    tier: "execution",
    code: "DISPATCH",
    required: false,
    description: {
      "zh-CN": "实时查询授权仓库运单、发起改期提案并查看月台收发里程碑",
      "zh-HK": "即時查詢授權倉庫運單、發起改期提案並檢視月台收發里程碑",
      en: "Live shipment lookup, reschedule proposals, and warehouse dock milestones",
    },
  },
  finance: {
    tier: "specialist",
    code: "FINANCE",
    required: false,
    description: {
      "zh-CN": "实时财务发票审阅、关联受控合同预审案件与标准条款差异核对",
      "zh-HK": "即時財務發票審閱、關聯受控合約預審案件與標準條款差異核對",
      en: "Live invoice lookup, contract assurance cases, and standard clause diff review",
    },
  },
  assurance: {
    tier: "specialist",
    code: "ASSURANCE",
    required: false,
    description: {
      "zh-CN": "受控治理预审案件、按岗位投影字段与独立多轨协同表决",
      "zh-HK": "受控治理預審案件、按職位投影欄位與獨立多軌協同表決",
      en: "Governed precheck cases, role-projected fields, and independent multi-track decisions",
    },
  },
  approvals: {
    tier: "approval_decision",
    code: "APPROVALS",
    required: false,
    description: {
      "zh-CN": "独立主管审批队列，按需核对摘要锁并支持单笔与批量批准入队",
      "zh-HK": "獨立主管審批佇列，按需核對摘要鎖並支援單筆與批次批准入隊",
      en: "Independent manager approval queue with on-demand digest checks and batch approvals",
    },
  },
  decision: {
    tier: "approval_decision",
    code: "DECISION",
    required: false,
    description: {
      "zh-CN": "跨仓实时仓库运营指标汇总与按需实时鉴权下钻",
      "zh-HK": "跨倉即時倉儲營運指標摘要與按需即時鑑權下鑽",
      en: "Cross-warehouse live operational metrics with real-time authorized drill-down",
    },
  },
};

export function getModuleSpecs(
  locale: Locale = DEFAULT_LOCALE,
): Record<WorkbenchModuleId, WorkbenchModuleSpec> {
  const result = {} as Record<WorkbenchModuleId, WorkbenchModuleSpec>;
  for (const id of Object.keys(MODULE_META_BASE) as WorkbenchModuleId[]) {
    const base = MODULE_META_BASE[id];
    result[id] = {
      id,
      tier: base.tier,
      code: base.code,
      required: base.required,
      label: translateKey(locale, `workbench.module.${id}.label`),
      shortLabel: translateKey(locale, `workbench.module.${id}.short`),
      description: translateInline(locale, base.description),
    };
  }
  return result;
}

export const ALL_MODULE_SPECS: Record<WorkbenchModuleId, WorkbenchModuleSpec> =
  getModuleSpecs(DEFAULT_LOCALE);

export function deriveAuthorizedModules(
  actor: Actor | null,
  capabilities: Capabilities | null,
): WorkbenchModuleId[] {
  const modules: WorkbenchModuleId[] = ["queues"];
  if (!actor || !capabilities) return modules;

  const hasToolWarehouses = (id: string) =>
    capabilities.tools.some(
      (t) => t.id === id && t.available && t.warehouses.length > 0,
    );

  // 接单
  if (
    hasToolWarehouses("order.draft.prepare") ||
    capabilities.order_read_warehouses.length > 0
  ) {
    modules.push("orders");
  }

  // 主管审批
  const approvalSites = [
    ...(capabilities.approval_warehouses["sales_order.create_draft"] ?? []),
    ...(capabilities.approval_warehouses["shipment.reschedule"] ?? []),
  ];
  if (
    (actor.role === "manager" || actor.role === "admin") &&
    approvalSites.length > 0
  ) {
    modules.push("approvals");
  }

  // 调度
  if (
    hasToolWarehouses("shipment.read") ||
    hasToolWarehouses("shipment.reschedule")
  ) {
    modules.push("dispatch");
  }

  // 财务
  if (
    hasToolWarehouses("finance.invoice.read") ||
    actor.grants.includes("assurance.finance") ||
    actor.grants.includes("assurance.contract")
  ) {
    modules.push("finance");
  }

  // 采购 / 质检 / 法务
  if (
    actor.grants.includes("assurance.purchase") ||
    actor.grants.includes("assurance.incoming") ||
    actor.grants.includes("assurance.contract")
  ) {
    modules.push("assurance");
  }

  // 经营只读
  if (hasToolWarehouses("decision.warehouse.summary")) {
    modules.push("decision");
  }

  return modules;
}

export interface ConsolidatedHat {
  lane: "assigned" | "submitted";
  roleLabel: string;
  subStatus: string;
  reason: string;
  nextStep: string;
}

export interface ConsolidatedTaskRow {
  id: string;
  warehouse: string;
  action: TaskItem["action"];
  state: TaskItem["state"];
  due: number;
  expires: number;
  decision: TaskItem["decision"];
  assigned_to: TaskItem["assigned_to"];
  hats: ConsolidatedHat[];
  primaryReason: string;
  primaryNextStep: string;
}

export function describeTaskTurn(
  item: TaskItem,
  lane: "assigned" | "submitted",
  actorSubject?: string,
  locale: Locale = DEFAULT_LOCALE,
): ConsolidatedHat {
  const tx = (text: TrilingualText, vars?: Record<string, string | number>) =>
    translateInline(locale, text, vars);

  if (lane === "assigned") {
    const isDirectAssignee =
      item.assigned_to && actorSubject && item.assigned_to === actorSubject;
    return {
      lane: "assigned",
      roleLabel: isDirectAssignee
        ? tx({
            "zh-CN": "指定审批人",
            "zh-HK": "指定審批人",
            en: "Assigned Approver",
          })
        : tx({
            "zh-CN": "仓库独立审批",
            "zh-HK": "倉庫獨立審批",
            en: "Warehouse Approver Pool",
          }),
      subStatus: tx({
        "zh-CN": "待审批",
        "zh-HK": "待審批",
        en: "Pending Approval",
      }),
      reason: isDirectAssignee
        ? tx({
            "zh-CN": "已明确指派给您审批",
            "zh-HK": "已明確指派予您審批",
            en: "Explicitly assigned to you for approval",
          })
        : tx(
            {
              "zh-CN": "待 {warehouse} 独立主管审批",
              "zh-HK": "待 {warehouse} 獨立主管審批",
              en: "Awaiting independent manager approval ({warehouse})",
            },
            { warehouse: item.warehouse },
          ),
      nextStep: tx({
        "zh-CN": "核对差异并批准",
        "zh-HK": "核對差異並批准",
        en: "Review diff & approve",
      }),
    };
  }

  const requesterRoleLabel = tx({
    "zh-CN": "单据发起人",
    "zh-HK": "單據發起人",
    en: "Requester",
  });

  if (item.state === "PROPOSED") {
    return {
      lane: "submitted",
      roleLabel: requesterRoleLabel,
      subStatus: item.assigned_to
        ? tx(
            {
              "zh-CN": "等待 {assignee} 审批",
              "zh-HK": "等待 {assignee} 審批",
              en: "Awaiting {assignee}",
            },
            { assignee: item.assigned_to },
          )
        : tx({
            "zh-CN": "等待主管审批",
            "zh-HK": "等待主管審批",
            en: "Awaiting manager",
          }),
      reason: item.assigned_to
        ? tx(
            {
              "zh-CN": "您提交的提案已分派给 {assignee}",
              "zh-HK": "您提交的提案已分派予 {assignee}",
              en: "Your proposal is assigned to {assignee}",
            },
            { assignee: item.assigned_to },
          )
        : tx({
            "zh-CN": "您提交的提案正在等待独立主管审批",
            "zh-HK": "您提交的提案正在等待獨立主管審批",
            en: "Your proposal is awaiting independent manager approval",
          }),
      nextStep: tx({
        "zh-CN": "查看提案详情",
        "zh-HK": "檢視提案詳情",
        en: "Inspect proposal",
      }),
    };
  }
  if (item.state === "VERIFIED") {
    return {
      lane: "submitted",
      roleLabel: requesterRoleLabel,
      subStatus: tx({
        "zh-CN": "已核验入账",
        "zh-HK": "已核驗入帳",
        en: "Verified & Posted",
      }),
      reason: tx({
        "zh-CN": "ERP 回执已核验一致",
        "zh-HK": "ERP 回執已核驗一致",
        en: "ERP receipt verified and matched",
      }),
      nextStep: tx({
        "zh-CN": "查看 ERP 回执",
        "zh-HK": "檢視 ERP 回執",
        en: "View ERP receipt",
      }),
    };
  }
  if (item.state === "REJECTED") {
    const returned = item.decision === "returned";
    return {
      lane: "submitted",
      roleLabel: requesterRoleLabel,
      subStatus: returned
        ? tx({
            "zh-CN": "已退回（终态）",
            "zh-HK": "已退回（終態）",
            en: "Returned (Final)",
          })
        : tx({
            "zh-CN": "已拒绝（终态）",
            "zh-HK": "已拒絕（終態）",
            en: "Rejected (Final)",
          }),
      reason: returned
        ? tx({
            "zh-CN": "主管已退回，需按意见重新进件",
            "zh-HK": "主管已退回，須按意見重新進件",
            en: "Returned by manager; resubmit with corrections",
          })
        : tx({
            "zh-CN": "提案已被拒绝或终止",
            "zh-HK": "提案已被拒絕或終止",
            en: "Proposal was rejected or terminated",
          }),
      nextStep: returned
        ? tx({
            "zh-CN": "查看退回理由并重新进件",
            "zh-HK": "檢視退回理由並重新進件",
            en: "Review reason & resubmit",
          })
        : tx({
            "zh-CN": "查看终止记录",
            "zh-HK": "檢視終止紀錄",
            en: "View termination record",
          }),
    };
  }
  if (item.state === "NEEDS_OPERATOR" || item.state === "OUTCOME_UNKNOWN") {
    return {
      lane: "submitted",
      roleLabel: requesterRoleLabel,
      subStatus:
        item.state === "NEEDS_OPERATOR"
          ? tx({
              "zh-CN": "需运维核查",
              "zh-HK": "須維運核查",
              en: "Needs Operator",
            })
          : tx({
              "zh-CN": "回执待确认",
              "zh-HK": "回執待確認",
              en: "Receipt Pending",
            }),
      reason:
        item.state === "NEEDS_OPERATOR"
          ? tx({
              "zh-CN": "已达回查上限，等待运维核对 ERP 回执",
              "zh-HK": "已達回查上限，等待維運核對 ERP 回執",
              en: "Readback limit reached; awaiting operator receipt check",
            })
          : tx({
              "zh-CN": "系统正在自动回查 ERP 回执结果",
              "zh-HK": "系統正在自動回查 ERP 回執結果",
              en: "Automatically re-checking ERP receipt status",
            }),
      nextStep: tx({
        "zh-CN": "追踪回执核验",
        "zh-HK": "追蹤回執核驗",
        en: "Track verification",
      }),
    };
  }
  return {
    lane: "submitted",
    roleLabel: requesterRoleLabel,
    subStatus: tx({
      "zh-CN": "ERP 执行流转中",
      "zh-HK": "ERP 執行流轉中",
      en: "Executing in ERP",
    }),
    reason: tx({
      "zh-CN": "提案已批准并进入可靠出站队列",
      "zh-HK": "提案已批准並進入可靠出站佇列",
      en: "Approved and queued in reliable ERP outbox",
    }),
    nextStep: tx({
      "zh-CN": "追踪执行状态",
      "zh-HK": "追蹤執行狀態",
      en: "Track execution",
    }),
  };
}

export function consolidateTaskItems(
  assigned: TaskItem[],
  submitted: TaskItem[],
  actorSubject?: string,
  locale: Locale = DEFAULT_LOCALE,
): ConsolidatedTaskRow[] {
  const map = new Map<string, ConsolidatedTaskRow>();

  const upsert = (item: TaskItem, lane: "assigned" | "submitted") => {
    const hat = describeTaskTurn(item, lane, actorSubject, locale);
    const existing = map.get(item.id);
    if (!existing) {
      map.set(item.id, {
        id: item.id,
        warehouse: item.warehouse,
        action: item.action,
        state: item.state,
        due: item.due,
        expires: item.expires,
        decision: item.decision ?? null,
        assigned_to: item.assigned_to ?? null,
        hats: [hat],
        primaryReason: hat.reason,
        primaryNextStep: hat.nextStep,
      });
      return;
    }

    if (!existing.hats.some((h) => h.lane === lane)) {
      existing.hats.push(hat);
    }
    if (lane === "assigned") {
      existing.primaryReason = hat.reason;
      existing.primaryNextStep = hat.nextStep;
    }
    if (item.decision && !existing.decision) {
      existing.decision = item.decision;
    }
    if (item.assigned_to && !existing.assigned_to) {
      existing.assigned_to = item.assigned_to;
    }
  };

  for (const item of assigned) upsert(item, "assigned");
  for (const item of submitted) upsert(item, "submitted");

  return Array.from(map.values()).sort(
    (a, b) => a.due - b.due || a.id.localeCompare(b.id),
  );
}

// --- Assurance Metadata & Labels ---

export const ASSURANCE_KIND_GRANTS: Record<AssuranceKind, Grant> = {
  purchase: "assurance.purchase",
  incoming_quality: "assurance.incoming",
  contract: "assurance.contract",
};

export function getAssuranceKindMeta(
  locale: Locale = DEFAULT_LOCALE,
): Record<AssuranceKind, { label: string; grant: Grant; shortLabel: string }> {
  return {
    purchase: {
      label: ASSURANCE_KIND_LABELS_I18N.purchase.label[locale],
      shortLabel: ASSURANCE_KIND_LABELS_I18N.purchase.shortLabel[locale],
      grant: ASSURANCE_KIND_GRANTS.purchase,
    },
    incoming_quality: {
      label: ASSURANCE_KIND_LABELS_I18N.incoming_quality.label[locale],
      shortLabel: ASSURANCE_KIND_LABELS_I18N.incoming_quality.shortLabel[locale],
      grant: ASSURANCE_KIND_GRANTS.incoming_quality,
    },
    contract: {
      label: ASSURANCE_KIND_LABELS_I18N.contract.label[locale],
      shortLabel: ASSURANCE_KIND_LABELS_I18N.contract.shortLabel[locale],
      grant: ASSURANCE_KIND_GRANTS.contract,
    },
  };
}

export const ASSURANCE_KIND_META: Record<
  AssuranceKind,
  { label: string; grant: Grant; shortLabel: string }
> = getAssuranceKindMeta(DEFAULT_LOCALE);

export const ASSURANCE_TRACK_GRANTS: Record<AssuranceTrack, Grant> = {
  procurement: "assurance.procurement",
  finance: "assurance.finance",
  quality: "assurance.quality",
  legal: "assurance.legal",
};

export function getAssuranceTrackLabels(
  locale: Locale = DEFAULT_LOCALE,
): Record<AssuranceTrack, string> {
  return {
    procurement: ASSURANCE_TRACK_LABELS_I18N.procurement[locale],
    finance: ASSURANCE_TRACK_LABELS_I18N.finance[locale],
    quality: ASSURANCE_TRACK_LABELS_I18N.quality[locale],
    legal: ASSURANCE_TRACK_LABELS_I18N.legal[locale],
  };
}

export const ASSURANCE_TRACK_LABELS: Record<AssuranceTrack, string> =
  getAssuranceTrackLabels(DEFAULT_LOCALE);

const ASSURANCE_INSTRUCTIONS_I18N: ReadonlyArray<{
  value: string;
  labels: TrilingualText;
}> = [
  {
    value: "",
    labels: {
      "zh-CN": "默认标准预审（空指令）",
      "zh-HK": "預設標準預審（空指令）",
      en: "Default standard precheck (empty)",
    },
  },
  {
    value: "预审",
    labels: {
      "zh-CN": "预审",
      "zh-HK": "預審",
      en: "Standard precheck",
    },
  },
  {
    value: "审核这条记录",
    labels: {
      "zh-CN": "审核这条记录",
      "zh-HK": "審核這筆紀錄",
      en: "Review this record",
    },
  },
  {
    value: "precheck",
    labels: {
      "zh-CN": "precheck",
      "zh-HK": "precheck",
      en: "Quick precheck",
    },
  },
  {
    value: "review this case",
    labels: {
      "zh-CN": "review this case",
      "zh-HK": "review this case",
      en: "Review this case",
    },
  },
];

export function getAssuranceInstructions(
  locale: Locale = DEFAULT_LOCALE,
): ReadonlyArray<{ value: string; label: string }> {
  return ASSURANCE_INSTRUCTIONS_I18N.map((opt) => ({
    value: opt.value,
    label: opt.labels[locale],
  }));
}

export const ASSURANCE_INSTRUCTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = getAssuranceInstructions(DEFAULT_LOCALE);

export function getAssuranceFieldLabel(
  fieldKey: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return ASSURANCE_FIELD_LABELS_I18N[fieldKey]?.[locale] ?? fieldKey;
}

export const ASSURANCE_FIELD_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(ASSURANCE_FIELD_LABELS_I18N).map(([k, v]) => [
    k,
    v[DEFAULT_LOCALE],
  ]),
);

// --- Clearly Tagged Synthetic Demo Fixtures ---

export type DockMilestoneStageKey = "staged" | "short" | "damaged" | "signed";

export interface SyntheticDockMilestone {
  id: string;
  warehouse: string;
  shipmentRef: string;
  dockBay: string;
  stageKey: DockMilestoneStageKey;
  stage: string;
  plannedQty: number;
  actualQty: number;
  note: string;
  updatedAt: string;
}

const SYNTHETIC_DOCK_MILESTONES_I18N: ReadonlyArray<{
  id: string;
  warehouse: string;
  shipmentRef: string;
  dockBay: string;
  stageKey: DockMilestoneStageKey;
  stage: TrilingualText;
  plannedQty: number;
  actualQty: number;
  note: TrilingualText;
  updatedAt: string;
}> = [
  {
    id: "DOCK-SYN-01",
    warehouse: "HK01",
    shipmentRef: "SHP-1001",
    dockBay: "BAY-03",
    stageKey: "staged",
    stage: { "zh-CN": "待收待发", "zh-HK": "待收待發", en: "Staged" },
    plannedQty: 48,
    actualQty: 48,
    note: {
      "zh-CN": "托盘已备货完成，待提货车辆进场",
      "zh-HK": "卡板已備貨完成，待提貨車輛進場",
      en: "Pallets staged and ready for carrier arrival",
    },
    updatedAt: "2026-11-21 16:40",
  },
  {
    id: "DOCK-SYN-02",
    warehouse: "HK01",
    shipmentRef: "SHP-1008",
    dockBay: "BAY-01",
    stageKey: "short",
    stage: { "zh-CN": "短收", "zh-HK": "短收", en: "Shortage" },
    plannedQty: 120,
    actualQty: 116,
    note: {
      "zh-CN": "实收少 4 箱，已登记月台短收差异单",
      "zh-HK": "實收少 4 箱，已登記月台短收差異單",
      en: "4 cases short on receipt; dock variance ticket logged",
    },
    updatedAt: "2026-11-21 15:15",
  },
  {
    id: "DOCK-SYN-03",
    warehouse: "HK01",
    shipmentRef: "SHP-1012",
    dockBay: "BAY-04",
    stageKey: "damaged",
    stage: { "zh-CN": "破损", "zh-HK": "破損", en: "Damaged" },
    plannedQty: 60,
    actualQty: 58,
    note: {
      "zh-CN": "2 箱外包装受潮破损，已移交隔离区复检",
      "zh-HK": "2 箱外包裝受潮破損，已移交隔離區覆檢",
      en: "2 cartons moisture-damaged; moved to quarantine for QC",
    },
    updatedAt: "2026-11-21 14:22",
  },
  {
    id: "DOCK-SYN-04",
    warehouse: "HK02",
    shipmentRef: "SHP-2001",
    dockBay: "BAY-02",
    stageKey: "signed",
    stage: { "zh-CN": "签收", "zh-HK": "簽收", en: "Signed POD" },
    plannedQty: 36,
    actualQty: 36,
    note: {
      "zh-CN": "客户已回传电子签收单（合成演示记录）",
      "zh-HK": "客戶已回傳電子簽收單（合成示範紀錄）",
      en: "Electronic proof of delivery received (synthetic demo)",
    },
    updatedAt: "2026-11-21 13:05",
  },
];

export function getSyntheticDockMilestones(
  locale: Locale = DEFAULT_LOCALE,
): SyntheticDockMilestone[] {
  return SYNTHETIC_DOCK_MILESTONES_I18N.map((item) => ({
    id: item.id,
    warehouse: item.warehouse,
    shipmentRef: item.shipmentRef,
    dockBay: item.dockBay,
    stageKey: item.stageKey,
    stage: item.stage[locale],
    plannedQty: item.plannedQty,
    actualQty: item.actualQty,
    note: item.note[locale],
    updatedAt: item.updatedAt,
  }));
}

export const SYNTHETIC_DOCK_MILESTONES: readonly SyntheticDockMilestone[] =
  getSyntheticDockMilestones(DEFAULT_LOCALE);

export interface SyntheticContractClause {
  clauseId: string;
  topic: string;
  standardTerm: string;
  proposedTerm: string;
  paymentMilestone: string;
  riskLevel: "normal" | "review";
}

const SYNTHETIC_CONTRACT_CLAUSES_I18N: ReadonlyArray<{
  clauseId: string;
  topic: TrilingualText;
  standardTerm: TrilingualText;
  proposedTerm: TrilingualText;
  paymentMilestone: TrilingualText;
  riskLevel: "normal" | "review";
}> = [
  {
    clauseId: "CL-01",
    topic: {
      "zh-CN": "结算账期与首付款比例",
      "zh-HK": "結算帳期與首付款比例",
      en: "Payment Terms & Deposit Ratio",
    },
    standardTerm: {
      "zh-CN": "验收后 30 天内电汇结算（Net 30）",
      "zh-HK": "驗收後 30 天內電匯結算（Net 30）",
      en: "Wire transfer within 30 days of acceptance (Net 30)",
    },
    proposedTerm: {
      "zh-CN": "签约付 30% 预付款，签收后 45 天结清尾款 70%",
      "zh-HK": "簽約付 30% 預付款，簽收後 45 天結清尾款 70%",
      en: "30% deposit upon signing, 70% balance due Net 45 after POD",
    },
    paymentMilestone: {
      "zh-CN": "M1 预付 30% · M2 签收尾款 70%",
      "zh-HK": "M1 預付 30% · M2 簽收尾款 70%",
      en: "M1 30% Deposit · M2 70% Balance",
    },
    riskLevel: "review",
  },
  {
    clauseId: "CL-02",
    topic: {
      "zh-CN": "合同期限与自动续约",
      "zh-HK": "合約期限與自動續約",
      en: "Contract Term & Auto-Renewal",
    },
    standardTerm: {
      "zh-CN": "12 个月固定期，到期书面确认续签",
      "zh-HK": "12 個月固定期，到期書面確認續簽",
      en: "12-month fixed term; written mutual confirmation to renew",
    },
    proposedTerm: {
      "zh-CN": "18 个月，若未提前 30 天通知则自动顺延 12 个月",
      "zh-HK": "18 個月，若未提前 30 天通知則自動順延 12 個月",
      en: "18 months; auto-renews for 12 months unless 30 days notice given",
    },
    paymentMilestone: {
      "zh-CN": "按季度对账开票",
      "zh-HK": "按季度對帳開票",
      en: "Quarterly reconciliation & billing",
    },
    riskLevel: "review",
  },
  {
    clauseId: "CL-03",
    topic: {
      "zh-CN": "违约赔偿上限",
      "zh-HK": "違約賠償上限",
      en: "Liability Cap",
    },
    standardTerm: {
      "zh-CN": "累计不超过合同年度总额的 100%",
      "zh-HK": "累計不超過合約年度總額的 100%",
      en: "Capped at 100% of annual contract value",
    },
    proposedTerm: {
      "zh-CN": "累计不超过合同年度总额的 100%（与标准一致）",
      "zh-HK": "累計不超過合約年度總額的 100%（與標準一致）",
      en: "Capped at 100% of annual contract value (matches standard)",
    },
    paymentMilestone: {
      "zh-CN": "质保金 5% 满 90 天释放",
      "zh-HK": "質保金 5% 滿 90 天釋放",
      en: "5% retention released after 90 days",
    },
    riskLevel: "normal",
  },
  {
    clauseId: "CL-04",
    topic: {
      "zh-CN": "发票开具与税率条款",
      "zh-HK": "發票開具與稅率條款",
      en: "Invoicing & Tax Terms",
    },
    standardTerm: {
      "zh-CN": "出库核验后 5 个工作日内开具电子商业发票",
      "zh-HK": "出庫核驗後 5 個工作天內開具電子商業發票",
      en: "Issue electronic commercial invoice within 5 business days of dispatch",
    },
    proposedTerm: {
      "zh-CN": "出库核验后 5 个工作日内开具 HKD 商业发票",
      "zh-HK": "出庫核驗後 5 個工作天內開具 HKD 商業發票",
      en: "Issue HKD commercial invoice within 5 business days of dispatch",
    },
    paymentMilestone: {
      "zh-CN": "凭发票与签收单触发对账",
      "zh-HK": "憑發票與簽收單觸發對帳",
      en: "Reconciled upon invoice & signed POD",
    },
    riskLevel: "normal",
  },
];

export function getSyntheticContractClauses(
  locale: Locale = DEFAULT_LOCALE,
): SyntheticContractClause[] {
  return SYNTHETIC_CONTRACT_CLAUSES_I18N.map((item) => ({
    clauseId: item.clauseId,
    topic: item.topic[locale],
    standardTerm: item.standardTerm[locale],
    proposedTerm: item.proposedTerm[locale],
    paymentMilestone: item.paymentMilestone[locale],
    riskLevel: item.riskLevel,
  }));
}

export const SYNTHETIC_CONTRACT_CLAUSES: readonly SyntheticContractClause[] =
  getSyntheticContractClauses(DEFAULT_LOCALE);
