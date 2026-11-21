import type { AssuranceKind, AssuranceTrack } from "@/lib/types";
import type { TrilingualText } from "@/lib/i18n/types";

export const WORKBENCH_DICTIONARY = {
  // === WorkbenchView: 4 Permission Tiers ===
  "workbench.title": {
    "zh-CN": "企业运营工作台",
    "zh-HK": "企業營運工作台",
    en: "Operations Workbench",
  },
  "workbench.tier.execution.label": {
    "zh-CN": "执行与进件层",
    "zh-HK": "執行與進件層",
    en: "Execution & Intake",
  },
  "workbench.tier.execution.subtitle": {
    "zh-CN": "统一任务队列、销售订单进件与运单调度",
    "zh-HK": "統一任務佇列、銷售訂單進件與運單調度",
    en: "Unified queues, sales order intake, and shipment dispatch",
  },
  "workbench.tier.specialist.label": {
    "zh-CN": "专业复核层",
    "zh-HK": "專業覆核層",
    en: "Specialist Review",
  },
  "workbench.tier.specialist.subtitle": {
    "zh-CN": "财务发票合同审阅与采购、质检、法务多轨预审",
    "zh-HK": "財務發票合約審閱與採購、質檢、法務多軌預審",
    en: "Finance invoices, contracts, and multi-track assurance reviews",
  },
  "workbench.tier.approval_decision.label": {
    "zh-CN": "审批与经营层",
    "zh-HK": "審批與營運層",
    en: "Approvals & Insights",
  },
  "workbench.tier.approval_decision.subtitle": {
    "zh-CN": "主管独立审批队列与跨仓经营只读汇总",
    "zh-HK": "主管獨立審批佇列與跨倉營運唯讀摘要",
    en: "Independent manager approvals and cross-site read-only insights",
  },
  "workbench.tier.governance.label": {
    "zh-CN": "管理与治理层",
    "zh-HK": "管理與治理層",
    en: "Governance & Ops",
  },
  "workbench.tier.governance.subtitle": {
    "zh-CN": "按真实治理权限展示员工模块授权与运维异常监控",
    "zh-HK": "按真實治理權限顯示員工模組授權與維運異常監控",
    en: "Employee module access governance and platform operations",
  },

  // === Workbench Modules ===
  "workbench.module.queues.label": {
    "zh-CN": "统一任务队列",
    "zh-HK": "統一任務佇列",
    en: "Task Queues",
  },
  "workbench.module.queues.short": {
    "zh-CN": "任务队列",
    "zh-HK": "任務佇列",
    en: "Queues",
  },
  "workbench.module.orders.label": {
    "zh-CN": "接单进件",
    "zh-HK": "接單進件",
    en: "Order Intake",
  },
  "workbench.module.orders.short": {
    "zh-CN": "接单",
    "zh-HK": "接單",
    en: "Orders",
  },
  "workbench.module.dispatch.label": {
    "zh-CN": "运单调度",
    "zh-HK": "運單調度",
    en: "Dispatch",
  },
  "workbench.module.dispatch.short": {
    "zh-CN": "调度",
    "zh-HK": "調度",
    en: "Dispatch",
  },
  "workbench.module.finance.label": {
    "zh-CN": "财务与合同",
    "zh-HK": "財務與合約",
    en: "Finance & Contracts",
  },
  "workbench.module.finance.short": {
    "zh-CN": "财务",
    "zh-HK": "財務",
    en: "Finance",
  },
  "workbench.module.assurance.label": {
    "zh-CN": "采购 / 质检 / 法务",
    "zh-HK": "採購 / 質檢 / 法務",
    en: "Assurance",
  },
  "workbench.module.assurance.short": {
    "zh-CN": "多轨预审",
    "zh-HK": "多軌預審",
    en: "Assurance",
  },
  "workbench.module.approvals.label": {
    "zh-CN": "主管审批",
    "zh-HK": "主管審批",
    en: "Approvals",
  },
  "workbench.module.approvals.short": {
    "zh-CN": "审批队列",
    "zh-HK": "審批佇列",
    en: "Approvals",
  },
  "workbench.module.decision.label": {
    "zh-CN": "经营只读",
    "zh-HK": "營運唯讀",
    en: "Insights",
  },
  "workbench.module.decision.short": {
    "zh-CN": "经营汇总",
    "zh-HK": "營運摘要",
    en: "Insights",
  },

  // === UnifiedQueuesPanel ===
  "queues.lane.assigned": {
    "zh-CN": "待我处理",
    "zh-HK": "待我處理",
    en: "Assigned to Me",
  },
  "queues.lane.submitted": {
    "zh-CN": "我提交的",
    "zh-HK": "我提交的",
    en: "Submitted",
  },
  "queues.lane.consolidated": {
    "zh-CN": "合并视角",
    "zh-HK": "合併檢視",
    en: "Consolidated",
  },
  "queues.empty": {
    "zh-CN": "当前队列暂无单据",
    "zh-HK": "目前佇列暫無單據",
    en: "No proposals in this queue",
  },

  // === ApprovalsModule ===
  "approvals.title": {
    "zh-CN": "独立主管审批队列",
    "zh-HK": "獨立主管審批佇列",
    en: "Manager Approval Queue",
  },
  "approvals.approveSelected": {
    "zh-CN": "批量批准所选 ({count})",
    "zh-HK": "批次批准所選 ({count})",
    en: "Approve Selected ({count})",
  },
  "approvals.approveSingle": {
    "zh-CN": "核验摘要并批准",
    "zh-HK": "核驗摘要並批准",
    en: "Verify & Approve",
  },
  "approvals.returnSingle": {
    "zh-CN": "退回修改",
    "zh-HK": "退回修改",
    en: "Return",
  },
  "approvals.rejectSingle": {
    "zh-CN": "拒绝提案",
    "zh-HK": "拒絕提案",
    en: "Reject",
  },
  "approvals.empty": {
    "zh-CN": "当前授权站点暂无待审批提案",
    "zh-HK": "目前授權倉庫暫無待審批提案",
    en: "No proposals awaiting approval",
  },

  // === OrdersModule, OrderIntakeWorkspace, OcrEvidenceViewer ===
  "orders.title": {
    "zh-CN": "销售订单进件",
    "zh-HK": "銷售訂單進件",
    en: "Sales Order Intake",
  },
  "orders.mode.structured": {
    "zh-CN": "结构化单据",
    "zh-HK": "結構化單據",
    en: "Structured PO",
  },
  "orders.mode.image": {
    "zh-CN": "图片 OCR 进件",
    "zh-HK": "圖片 OCR 進件",
    en: "Image OCR",
  },
  "orders.mode.batch": {
    "zh-CN": "批量进件",
    "zh-HK": "批次進件",
    en: "Batch Intake",
  },
  "orders.prefillDemo": {
    "zh-CN": "填入示例 PO",
    "zh-HK": "填入示範 PO",
    en: "Prefill Sample PO",
  },
  "orders.submitIntake": {
    "zh-CN": "提交进件并生成草稿提案",
    "zh-HK": "提交進件並產生草稿提案",
    en: "Submit & Prepare Draft",
  },
  "orders.ocr.readyForPreview": {
    "zh-CN": "识别完整 · 可生成草案",
    "zh-HK": "辨識完整 · 可產生草案",
    en: "Ready for Preview",
  },
  "orders.ocr.needsReview": {
    "zh-CN": "存在待复核字段",
    "zh-HK": "存在待覆核欄位",
    en: "Needs Field Review",
  },
  "orders.ocr.confirmFields": {
    "zh-CN": "确认 OCR 字段并生成提案",
    "zh-HK": "確認 OCR 欄位並產生提案",
    en: "Confirm Fields & Draft",
  },

  // === DispatchModule ===
  "dispatch.title": {
    "zh-CN": "运单查询与改期调度",
    "zh-HK": "運單查詢與改期調度",
    en: "Shipment Dispatch",
  },
  "dispatch.queryButton": {
    "zh-CN": "查询运单",
    "zh-HK": "查詢運單",
    en: "Look Up",
  },
  "dispatch.rescheduleButton": {
    "zh-CN": "发起改期提案",
    "zh-HK": "發起改期提案",
    en: "Propose Reschedule",
  },
  "dispatch.dockMilestones": {
    "zh-CN": "月台收发状态",
    "zh-HK": "月台收發狀態",
    en: "Dock Milestones",
  },

  // === FinanceModule ===
  "finance.title": {
    "zh-CN": "财务发票与合同条款核对",
    "zh-HK": "財務發票與合約條款核對",
    en: "Finance & Contract Review",
  },
  "finance.invoiceQuery": {
    "zh-CN": "查询发票",
    "zh-HK": "查詢發票",
    en: "Look Up Invoice",
  },
  "finance.contractComparison": {
    "zh-CN": "标准合同条款差异核对",
    "zh-HK": "標準合約條款差異核對",
    en: "Standard Clause Comparison",
  },

  // === AssurancePanel ===
  "assurance.title": {
    "zh-CN": "受控治理多轨预审",
    "zh-HK": "受控治理多軌預審",
    en: "Multi-Track Assurance",
  },
  "assurance.startReview": {
    "zh-CN": "发起受控预审",
    "zh-HK": "發起受控預審",
    en: "Start Review",
  },
  "assurance.ruleFindings": {
    "zh-CN": "硬规则核查项",
    "zh-HK": "硬規則核查項",
    en: "Rule Findings",
  },
  "assurance.modelFindings": {
    "zh-CN": "辅助模型提示",
    "zh-HK": "輔助模型提示",
    en: "Model Findings",
  },
  "assurance.trackApprove": {
    "zh-CN": "批准该轨",
    "zh-HK": "批准該軌",
    en: "Approve Track",
  },
  "assurance.trackReject": {
    "zh-CN": "否决该轨",
    "zh-HK": "否決該軌",
    en: "Reject Track",
  },
  "assurance.staleWarning": {
    "zh-CN": "源案件快照已变更，需刷新后重新预审",
    "zh-HK": "源案件快照已變更，須重新整理後重新預審",
    en: "Source case snapshot changed; refresh and re-run review",
  },
  "assurance.expiredWarning": {
    "zh-CN": "预审记录已过期",
    "zh-HK": "預審紀錄已過期",
    en: "Review expired",
  },

  // === DecisionModule ===
  "decision.title": {
    "zh-CN": "跨站点经营只读汇总",
    "zh-HK": "跨倉庫營運唯讀摘要",
    en: "Cross-Site Executive Summary",
  },
  "decision.openShipments": {
    "zh-CN": "在途开放运单",
    "zh-HK": "在途開放運單",
    en: "Open Shipments",
  },

  // === ProposalInspectorPanel, ProposalDiffView, WorkbenchDrawerSlot ===
  "proposal.diff.title": {
    "zh-CN": "拟变更字段比对",
    "zh-HK": "擬變更欄位比對",
    en: "Proposed Field Diff",
  },
  "proposal.diff.fullscreenBtn": {
    "zh-CN": "全屏对比",
    "zh-HK": "全螢幕比對",
    en: "Fullscreen Diff",
  },
  "proposal.diff.changedBadge": {
    "zh-CN": "变更",
    "zh-HK": "變更",
    en: "Changed",
  },
  "proposal.diff.colField": {
    "zh-CN": "字段",
    "zh-HK": "欄位",
    en: "Field",
  },
  "proposal.diff.colBefore": {
    "zh-CN": "原值",
    "zh-HK": "原值",
    en: "Before",
  },
  "proposal.diff.colAfter": {
    "zh-CN": "拟写入值",
    "zh-HK": "擬寫入值",
    en: "Proposed Value",
  },
  "proposal.diff.lineItemsTitle": {
    "zh-CN": "订单明细行换算（源单据 → ERP 标准单位）",
    "zh-HK": "訂單明細列換算（源單據 → ERP 標準單位）",
    en: "Line Item Mapping (Source → ERP UOM)",
  },
  "proposal.diff.field.shipmentId": {
    "zh-CN": "运单编号",
    "zh-HK": "運單編號",
    en: "Shipment ID",
  },
  "proposal.diff.field.warehouse": {
    "zh-CN": "仓库站点",
    "zh-HK": "倉庫站點",
    en: "Warehouse",
  },
  "proposal.diff.field.status": {
    "zh-CN": "当前状态",
    "zh-HK": "目前狀態",
    en: "Status",
  },
  "proposal.diff.field.expectedVersion": {
    "zh-CN": "版本锁",
    "zh-HK": "版本鎖",
    en: "Version Lock",
  },
  "proposal.diff.field.deliveryDate": {
    "zh-CN": "预计交付日期",
    "zh-HK": "預計交付日期",
    en: "Delivery Date",
  },
  "proposal.diff.field.legalEntity": {
    "zh-CN": "法人实体 / 站点",
    "zh-HK": "法人實體 / 倉庫",
    en: "Legal Entity / Site",
  },
  "proposal.diff.field.po": {
    "zh-CN": "客户采购单号 (PO)",
    "zh-HK": "客戶採購單號 (PO)",
    en: "Purchase Order (PO)",
  },
  "proposal.diff.field.newDraft": {
    "zh-CN": "新建草稿",
    "zh-HK": "新增草稿",
    en: "New draft",
  },
  "proposal.diff.field.buyer": {
    "zh-CN": "买方编码",
    "zh-HK": "買方編號",
    en: "Buyer Code",
  },
  "proposal.diff.field.total": {
    "zh-CN": "订单总额",
    "zh-HK": "訂單總額",
    en: "Order Total",
  },
  "proposal.diff.field.intakeId": {
    "zh-CN": "来源进件编号",
    "zh-HK": "來源進件編號",
    en: "Source Intake ID",
  },
  "proposal.diff.field.sourceSha": {
    "zh-CN": "源证据摘要",
    "zh-HK": "源憑證摘要",
    en: "Source Evidence SHA",
  },
  "proposal.timeline.title": {
    "zh-CN": "审计事件时间线",
    "zh-HK": "稽核事件時間線",
    en: "Audit Timeline",
  },
  "proposal.receipt.title": {
    "zh-CN": "ERP 已核验回执",
    "zh-HK": "ERP 已核驗回執",
    en: "Verified ERP Receipt",
  },
  "drawer.title": {
    "zh-CN": "侧边核对面板",
    "zh-HK": "側邊核對面板",
    en: "Business Inspector",
  },
  "drawer.tab.assigned": {
    "zh-CN": "待审批",
    "zh-HK": "待審批",
    en: "Assigned",
  },
  "drawer.tab.submitted": {
    "zh-CN": "已提交",
    "zh-HK": "已提交",
    en: "Submitted",
  },
  "drawer.tab.current": {
    "zh-CN": "当前对象",
    "zh-HK": "目前物件",
    en: "Current",
  },
} as const satisfies Record<string, TrilingualText>;

// ============================================================================
// Structured Workbench Runtime Lookups (Assurance & Audit Timeline Events)
// ============================================================================

export const ASSURANCE_KIND_LABELS_I18N: Readonly<
  Record<AssuranceKind, { label: TrilingualText; shortLabel: TrilingualText }>
> = {
  purchase: {
    label: { "zh-CN": "采购预审", "zh-HK": "採購預審", en: "Purchase Review" },
    shortLabel: { "zh-CN": "采购", "zh-HK": "採購", en: "Purchase" },
  },
  incoming_quality: {
    label: { "zh-CN": "来料质检", "zh-HK": "來料質檢", en: "Incoming Quality" },
    shortLabel: { "zh-CN": "质检", "zh-HK": "質檢", en: "Quality" },
  },
  contract: {
    label: { "zh-CN": "合同法务", "zh-HK": "合約法務", en: "Contract Review" },
    shortLabel: { "zh-CN": "法务", "zh-HK": "法務", en: "Legal" },
  },
};

export const ASSURANCE_TRACK_LABELS_I18N: Readonly<
  Record<AssuranceTrack, TrilingualText>
> = {
  procurement: { "zh-CN": "采购轨", "zh-HK": "採購軌", en: "Procurement Track" },
  finance: { "zh-CN": "财务轨", "zh-HK": "財務軌", en: "Finance Track" },
  quality: { "zh-CN": "质检轨", "zh-HK": "質檢軌", en: "Quality Track" },
  legal: { "zh-CN": "法务轨", "zh-HK": "法務軌", en: "Legal Track" },
};

export const ASSURANCE_FIELD_LABELS_I18N: Readonly<
  Record<string, TrilingualText>
> = {
  amount_minor: { "zh-CN": "金额", "zh-HK": "金額", en: "Amount" },
  currency: { "zh-CN": "币种", "zh-HK": "幣別", en: "Currency" },
  quote_count: { "zh-CN": "比价单份数", "zh-HK": "比價單份數", en: "Quotes Count" },
  supplier_approved: {
    "zh-CN": "供应商已准入",
    "zh-HK": "供應商已准入",
    en: "Approved Supplier",
  },
  supplier_bank: {
    "zh-CN": "供应商收款账户",
    "zh-HK": "供應商收款帳戶",
    en: "Supplier Bank Account",
  },
  sample_size: { "zh-CN": "抽检样本量", "zh-HK": "抽檢樣本量", en: "Sample Size" },
  defects: { "zh-CN": "缺陷数量", "zh-HK": "缺陷數量", en: "Defect Count" },
  certificate_present: {
    "zh-CN": "质检证书完备",
    "zh-HK": "質檢證書完備",
    en: "COA / Certificate",
  },
  critical_defect: {
    "zh-CN": "致命缺陷标记",
    "zh-HK": "重大缺陷標記",
    en: "Critical Defect",
  },
  inspector_contact: {
    "zh-CN": "质检员联系方式",
    "zh-HK": "質檢員聯絡方式",
    en: "Inspector Contact",
  },
  term_months: {
    "zh-CN": "合同期限（月）",
    "zh-HK": "合約期限（月）",
    en: "Term (Months)",
  },
  auto_renewal: {
    "zh-CN": "自动续约条款",
    "zh-HK": "自動續約條款",
    en: "Auto-Renewal",
  },
  standard_template: {
    "zh-CN": "标准模板",
    "zh-HK": "標準範本",
    en: "Standard Template",
  },
  liability_cap_present: {
    "zh-CN": "赔偿上限条款",
    "zh-HK": "賠償上限條款",
    en: "Liability Cap",
  },
  counterparty_contact: {
    "zh-CN": "对方签约法务联系",
    "zh-HK": "對方簽約法務聯絡",
    en: "Counterparty Legal",
  },
};

export interface TimelineEventI18nEntry {
  labels: TrilingualText;
  tone: "neutral" | "emerald" | "amber" | "crimson";
}

export const TIMELINE_EVENT_LABELS_I18N: Readonly<
  Record<string, TimelineEventI18nEntry>
> = {
  PROPOSED: {
    labels: { "zh-CN": "已提交提案", "zh-HK": "已提交提案", en: "Proposal submitted" },
    tone: "neutral",
  },
  APPROVAL_DENIED: {
    labels: { "zh-CN": "自审批已拦截", "zh-HK": "自審批已攔截", en: "Self-approval blocked" },
    tone: "amber",
  },
  SELF_APPROVAL_DENIED: {
    labels: { "zh-CN": "自审批已拦截", "zh-HK": "自審批已攔截", en: "Self-approval blocked" },
    tone: "amber",
  },
  APPROVED_AND_QUEUED: {
    labels: {
      "zh-CN": "独立主管已批准并入队",
      "zh-HK": "獨立主管已批准並入隊",
      en: "Approved & queued by manager",
    },
    tone: "neutral",
  },
  APPROVED: {
    labels: {
      "zh-CN": "独立主管已批准",
      "zh-HK": "獨立主管已批准",
      en: "Approved by manager",
    },
    tone: "neutral",
  },
  QUEUED: {
    labels: {
      "zh-CN": "已进入出站队列",
      "zh-HK": "已進入出站佇列",
      en: "Queued for ERP dispatch",
    },
    tone: "neutral",
  },
  SENDING: {
    labels: { "zh-CN": "正在写入 ERP", "zh-HK": "正在寫入 ERP", en: "Writing to ERP" },
    tone: "neutral",
  },
  VERIFYING: {
    labels: { "zh-CN": "正在核验回执", "zh-HK": "正在核驗回執", en: "Verifying ERP receipt" },
    tone: "neutral",
  },
  CHECKING: {
    labels: { "zh-CN": "回执复核中", "zh-HK": "回執覆核中", en: "Re-checking receipt" },
    tone: "amber",
  },
  OUTCOME_UNKNOWN: {
    labels: {
      "zh-CN": "传输结果待确认",
      "zh-HK": "傳輸結果待確認",
      en: "Dispatch outcome pending",
    },
    tone: "amber",
  },
  VERIFIED: {
    labels: { "zh-CN": "已核验入账", "zh-HK": "已核驗入帳", en: "Receipt verified & posted" },
    tone: "emerald",
  },
  REVIEW_ASSIGNED: {
    labels: { "zh-CN": "已分派审批人", "zh-HK": "已分派審批人", en: "Reviewer assigned" },
    tone: "neutral",
  },
  REVIEW_RELEASED: {
    labels: { "zh-CN": "已释放审批分派", "zh-HK": "已釋放審批分派", en: "Assignment released" },
    tone: "neutral",
  },
  REVIEW_RETURNED: {
    labels: { "zh-CN": "已退回修改", "zh-HK": "已退回修改", en: "Returned for revision" },
    tone: "amber",
  },
  RETURNED: {
    labels: { "zh-CN": "已退回修改", "zh-HK": "已退回修改", en: "Returned for revision" },
    tone: "amber",
  },
  REVIEW_REJECTED: {
    labels: { "zh-CN": "已拒绝", "zh-HK": "已拒絕", en: "Proposal rejected" },
    tone: "crimson",
  },
  REJECTED: {
    labels: { "zh-CN": "已拒绝", "zh-HK": "已拒絕", en: "Proposal rejected" },
    tone: "crimson",
  },
  WRITES_PAUSED_BEFORE_SEND: {
    labels: {
      "zh-CN": "ERP 写入暂停，保持排队",
      "zh-HK": "ERP 寫入暫停，保持排隊",
      en: "ERP writes paused; kept queued",
    },
    tone: "amber",
  },
  LEASE_EXPIRED_VERIFY_ONLY: {
    labels: {
      "zh-CN": "租约超时，切换为只读核验",
      "zh-HK": "租約逾時，切換為唯讀核驗",
      en: "Lease expired; read-only verification",
    },
    tone: "amber",
  },
  REOPEN_VERIFICATION: {
    labels: {
      "zh-CN": "运维重新发起回执核验",
      "zh-HK": "維運重新發起回執核驗",
      en: "Verification reopened by ops",
    },
    tone: "amber",
  },
  NEEDS_OPERATOR: {
    labels: {
      "zh-CN": "需运维人工核查",
      "zh-HK": "須維運人工核查",
      en: "Escalated for operator review",
    },
    tone: "crimson",
  },
  ACCESS_SUSPENDED_BEFORE_SEND: {
    labels: {
      "zh-CN": "账号已停权，阻断出站",
      "zh-HK": "帳號已停權，阻斷出站",
      en: "Blocked before send: account suspended",
    },
    tone: "crimson",
  },
  APPROVAL_EXPIRED_BEFORE_SEND: {
    labels: {
      "zh-CN": "审批已过期，阻断出站",
      "zh-HK": "審批已過期，阻斷出站",
      en: "Blocked before send: approval expired",
    },
    tone: "crimson",
  },
  MODULE_ACCESS_REVOKED_BEFORE_SEND: {
    labels: {
      "zh-CN": "模块权限已撤销，阻断出站",
      "zh-HK": "模組權限已撤銷，阻斷出站",
      en: "Blocked before send: module revoked",
    },
    tone: "crimson",
  },
  ERP_PRE_WRITE_REJECTION: {
    labels: {
      "zh-CN": "ERP 写入前拒绝",
      "zh-HK": "ERP 寫入前拒絕",
      en: "Rejected by ERP pre-write validation",
    },
    tone: "crimson",
  },
  ERP_RECEIPT_MISMATCH: {
    labels: {
      "zh-CN": "ERP 回执摘要不一致",
      "zh-HK": "ERP 回執摘要不一致",
      en: "ERP receipt digest mismatch",
    },
    tone: "crimson",
  },
  READBACK_LIMIT_REACHED: {
    labels: {
      "zh-CN": "达到回查次数上限",
      "zh-HK": "達到回查次數上限",
      en: "Readback verification limit reached",
    },
    tone: "crimson",
  },
  INVALID_STORED_PLAN: {
    labels: {
      "zh-CN": "提案计划校验失败",
      "zh-HK": "提案計劃校驗失敗",
      en: "Stored proposal plan invalid",
    },
    tone: "crimson",
  },
  PLAN_DIGEST_OR_TENANT_MISMATCH: {
    labels: {
      "zh-CN": "摘要或租户边界不匹配",
      "zh-HK": "摘要或租戶邊界不相符",
      en: "Plan digest or tenant mismatch",
    },
    tone: "crimson",
  },
};
