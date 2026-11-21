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

export interface WorkbenchModuleSpec {
  id: WorkbenchModuleId;
  label: string;
  code: string;
  description: string;
  required: boolean;
}

export const ALL_MODULE_SPECS: Record<WorkbenchModuleId, WorkbenchModuleSpec> = {
  queues: {
    id: "queues",
    label: "统一任务队列",
    code: "QUEUES",
    description: "待我处理与已提交单据的统一视图与合并角色视角",
    required: true,
  },
  orders: {
    id: "orders",
    label: "接单",
    code: "ORDERS",
    description: "销售订单进件入口、订单提案队列与历史进件查询",
    required: false,
  },
  approvals: {
    id: "approvals",
    label: "主管审批",
    code: "APPROVALS",
    description: "独立主管审批队列、按需详情核对与批量批准",
    required: false,
  },
  dispatch: {
    id: "dispatch",
    label: "调度",
    code: "DISPATCH",
    description: "实时运单查询、改期提案提交与仓库月台里程碑",
    required: false,
  },
  finance: {
    id: "finance",
    label: "财务",
    code: "FINANCE",
    description: "实时发票查询、合同预审案件与合同条款对比演示",
    required: false,
  },
  assurance: {
    id: "assurance",
    label: "采购 / 质检 / 法务",
    code: "ASSURANCE",
    description: "受控治理预审案件、按岗字段投影与多轨独立决策",
    required: false,
  },
  decision: {
    id: "decision",
    label: "经营只读",
    code: "DECISION",
    description: "跨站点实时仓库汇总指标与服务端权限实时下钻",
    required: false,
  },
};

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
): ConsolidatedHat {
  if (lane === "assigned") {
    const isDirectAssignee =
      item.assigned_to && actorSubject && item.assigned_to === actorSubject;
    return {
      lane: "assigned",
      roleLabel: isDirectAssignee ? "指定审批人" : "站点独立审批",
      subStatus: "待审批",
      reason: isDirectAssignee
        ? "已明确指派给您审批"
        : `待 ${item.warehouse} 独立主管审批`,
      nextStep: "核对差异并批准",
    };
  }

  if (item.state === "PROPOSED") {
    return {
      lane: "submitted",
      roleLabel: "单据发起人",
      subStatus: item.assigned_to ? `等待 ${item.assigned_to} 审批` : "等待主管审批",
      reason: item.assigned_to
        ? `您提交的提案已分派给 ${item.assigned_to}`
        : "您提交的提案正在等待独立主管审批",
      nextStep: "查看提案详情",
    };
  }
  if (item.state === "VERIFIED") {
    return {
      lane: "submitted",
      roleLabel: "单据发起人",
      subStatus: "已核验入账",
      reason: "ERP 回执已核验一致",
      nextStep: "查看 ERP 回执",
    };
  }
  if (item.state === "REJECTED") {
    const returned = item.decision === "returned";
    return {
      lane: "submitted",
      roleLabel: "单据发起人",
      subStatus: returned ? "已退回（终态）" : "已拒绝（终态）",
      reason: returned ? "主管已退回，需按意见重新进件" : "提案已被拒绝或终止",
      nextStep: returned ? "查看退回理由并重新进件" : "查看终止记录",
    };
  }
  if (item.state === "NEEDS_OPERATOR" || item.state === "OUTCOME_UNKNOWN") {
    return {
      lane: "submitted",
      roleLabel: "单据发起人",
      subStatus: item.state === "NEEDS_OPERATOR" ? "需运维核查" : "回执待确认",
      reason:
        item.state === "NEEDS_OPERATOR"
          ? "已达回查上限，等待运维核对 ERP 回执"
          : "系统正在自动回查 ERP 回执结果",
      nextStep: "追踪回执核验",
    };
  }
  return {
    lane: "submitted",
    roleLabel: "单据发起人",
    subStatus: "ERP 执行流转中",
    reason: "提案已批准并进入可靠出站队列",
    nextStep: "追踪执行状态",
  };
}

export function consolidateTaskItems(
  assigned: TaskItem[],
  submitted: TaskItem[],
  actorSubject?: string,
): ConsolidatedTaskRow[] {
  const map = new Map<string, ConsolidatedTaskRow>();

  const upsert = (item: TaskItem, lane: "assigned" | "submitted") => {
    const hat = describeTaskTurn(item, lane, actorSubject);
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

  return Array.from(map.values()).sort((a, b) => a.due - b.due || a.id.localeCompare(b.id));
}

// --- Assurance Metadata & Labels ---

export const ASSURANCE_KIND_META: Record<
  AssuranceKind,
  { label: string; grant: Grant; shortLabel: string }
> = {
  purchase: {
    label: "采购预审 (Purchase)",
    shortLabel: "采购",
    grant: "assurance.purchase",
  },
  incoming_quality: {
    label: "来料质检 (Incoming QA)",
    shortLabel: "质检",
    grant: "assurance.incoming",
  },
  contract: {
    label: "合同法务 (Contract)",
    shortLabel: "法务",
    grant: "assurance.contract",
  },
};

export const ASSURANCE_TRACK_GRANTS: Record<AssuranceTrack, Grant> = {
  procurement: "assurance.procurement",
  finance: "assurance.finance",
  quality: "assurance.quality",
  legal: "assurance.legal",
};

export const ASSURANCE_TRACK_LABELS: Record<AssuranceTrack, string> = {
  procurement: "采购轨 (Procurement)",
  finance: "财务轨 (Finance)",
  quality: "质检轨 (Quality)",
  legal: "法务轨 (Legal)",
};

export const ASSURANCE_INSTRUCTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "", label: "默认标准预审（空指令）" },
  { value: "预审", label: "预审" },
  { value: "审核这条记录", label: "审核这条记录" },
  { value: "precheck", label: "precheck" },
  { value: "review this case", label: "review this case" },
];

export const ASSURANCE_FIELD_LABELS: Record<string, string> = {
  amount_minor: "金额（最小币值单位）",
  currency: "币种",
  quote_count: "比价单份数",
  supplier_approved: "供应商已准入",
  supplier_bank: "供应商收款账户（财务受限字段）",
  sample_size: "抽检样本量",
  defects: "缺陷数量",
  certificate_present: "质检证书完备",
  critical_defect: "致命缺陷标记",
  inspector_contact: "质检员联系方式（质检受限字段）",
  term_months: "合同期限（月）",
  auto_renewal: "自动续约条款",
  standard_template: "标准模板",
  liability_cap_present: "赔偿上限条款",
  counterparty_contact: "对方签约法务联系（法务受限字段）",
};

// --- Clearly Tagged Synthetic Demo Fixtures ---

export interface SyntheticDockMilestone {
  id: string;
  warehouse: string;
  shipmentRef: string;
  dockBay: string;
  stage: "待收待发" | "短收" | "破损" | "签收";
  plannedQty: number;
  actualQty: number;
  note: string;
  updatedAt: string;
}

export const SYNTHETIC_DOCK_MILESTONES: readonly SyntheticDockMilestone[] = [
  {
    id: "DOCK-SYN-01",
    warehouse: "HK01",
    shipmentRef: "SHP-1001",
    dockBay: "BAY-03",
    stage: "待收待发",
    plannedQty: 48,
    actualQty: 48,
    note: "托盘已备货完成，待提货车辆进场",
    updatedAt: "2026-11-21 16:40",
  },
  {
    id: "DOCK-SYN-02",
    warehouse: "HK01",
    shipmentRef: "SHP-1008",
    dockBay: "BAY-01",
    stage: "短收",
    plannedQty: 120,
    actualQty: 116,
    note: "实收少 4 箱，已登记月台短收差异单",
    updatedAt: "2026-11-21 15:15",
  },
  {
    id: "DOCK-SYN-03",
    warehouse: "HK01",
    shipmentRef: "SHP-1012",
    dockBay: "BAY-04",
    stage: "破损",
    plannedQty: 60,
    actualQty: 58,
    note: "2 箱外包装受潮破损，已移交隔离区复检",
    updatedAt: "2026-11-21 14:22",
  },
  {
    id: "DOCK-SYN-04",
    warehouse: "HK02",
    shipmentRef: "SHP-2001",
    dockBay: "BAY-02",
    stage: "签收",
    plannedQty: 36,
    actualQty: 36,
    note: "客户已回传电子签收单（合成演示记录）",
    updatedAt: "2026-11-21 13:05",
  },
];

export interface SyntheticContractClause {
  clauseId: string;
  topic: string;
  standardTerm: string;
  proposedTerm: string;
  paymentMilestone: string;
  riskLevel: "normal" | "review";
}

export const SYNTHETIC_CONTRACT_CLAUSES: readonly SyntheticContractClause[] = [
  {
    clauseId: "CL-01",
    topic: "结算账期与首付款比例",
    standardTerm: "验收后 30 天内电汇结算（Net 30）",
    proposedTerm: "签约付 30% 预付款，签收后 45 天结清尾款 70%",
    paymentMilestone: "M1 预付 30% · M2 签收尾款 70%",
    riskLevel: "review",
  },
  {
    clauseId: "CL-02",
    topic: "合同期限与自动续约",
    standardTerm: "12 个月固定期，到期书面确认续签",
    proposedTerm: "18 个月，若未提前 30 天通知则自动顺延 12 个月",
    paymentMilestone: "按季度对账开票",
    riskLevel: "review",
  },
  {
    clauseId: "CL-03",
    topic: "违约赔偿上限",
    standardTerm: "累计不超过合同年度总额的 100%",
    proposedTerm: "累计不超过合同年度总额的 100%（与标准一致）",
    paymentMilestone: "质保金 5% 满 90 天释放",
    riskLevel: "normal",
  },
  {
    clauseId: "CL-04",
    topic: "发票开具与税率条款",
    standardTerm: "出库核验后 5 个工作日内开具电子商业发票",
    proposedTerm: "出库核验后 5 个工作日内开具 HKD 商业发票",
    paymentMilestone: "凭发票与签收单触发对账",
    riskLevel: "normal",
  },
];
