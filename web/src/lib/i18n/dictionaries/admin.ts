import type { Grant } from "@/lib/types";
import type { TrilingualText } from "@/lib/i18n/types";

export const ADMIN_DICTIONARY = {
  // === AdminOpsOverview ===
  "admin.ops.title": {
    "zh-CN": "平台运维与安全治理总览",
    "zh-HK": "平台維運與安全治理總覽",
    en: "Platform Operations & Safety",
  },
  "admin.ops.subtitle": {
    "zh-CN": "实时探针、ERP 写入断路器、全链路单据状态分布与审计检查点",
    "zh-HK": "即時探針、ERP 寫入斷路器、全鏈路單據狀態分佈與稽核檢查點",
    en: "Live probes, ERP write circuit breaker, proposal pipeline telemetry, and audit checkpoints",
  },
  "admin.ops.probesTitle": {
    "zh-CN": "服务探针",
    "zh-HK": "服務探針",
    en: "Service Probes",
  },
  "admin.ops.liveness": {
    "zh-CN": "存活探针 (/healthz)",
    "zh-HK": "存活探針 (/healthz)",
    en: "Liveness (/healthz)",
  },
  "admin.ops.readiness": {
    "zh-CN": "就绪探针 (/readyz)",
    "zh-HK": "就緒探針 (/readyz)",
    en: "Readiness (/readyz)",
  },
  "admin.ops.circuitBreakerTitle": {
    "zh-CN": "ERP 写入闸门（断路器）",
    "zh-HK": "ERP 寫入閘門（斷路器）",
    en: "ERP Write Circuit Breaker",
  },
  "admin.ops.pauseWrites": {
    "zh-CN": "暂停 ERP 写入",
    "zh-HK": "暫停 ERP 寫入",
    en: "Pause ERP Writes",
  },
  "admin.ops.resumeWrites": {
    "zh-CN": "恢复 ERP 写入",
    "zh-HK": "恢復 ERP 寫入",
    en: "Resume ERP Writes",
  },
  "admin.ops.stateSummary.pending": {
    "zh-CN": "待审批与流转中",
    "zh-HK": "待審批與流轉中",
    en: "Pending & In-Flight",
  },
  "admin.ops.stateSummary.exceptions": {
    "zh-CN": "异常待核查",
    "zh-HK": "異常待核查",
    en: "Needs Attention",
  },
  "admin.ops.stateSummary.verified": {
    "zh-CN": "已核验入账",
    "zh-HK": "已核驗入帳",
    en: "Verified & Posted",
  },
  "admin.ops.workerTickTitle": {
    "zh-CN": "出站 Worker 手动步进",
    "zh-HK": "出站 Worker 手動步進",
    en: "Outbound Worker Tick",
  },
  "admin.ops.runWorkerTick": {
    "zh-CN": "触发一次步进",
    "zh-HK": "觸發一次步進",
    en: "Run Worker Tick",
  },
  "admin.ops.suspensionTitle": {
    "zh-CN": "员工紧急停权 / 恢复",
    "zh-HK": "員工緊急停權 / 恢復",
    en: "Account Suspension",
  },
  "admin.ops.suspendBtn": {
    "zh-CN": "紧急停权",
    "zh-HK": "緊急停權",
    en: "Suspend Access",
  },
  "admin.ops.restoreBtn": {
    "zh-CN": "恢复权限",
    "zh-HK": "恢復權限",
    en: "Restore Access",
  },
  "admin.ops.checkpointTitle": {
    "zh-CN": "审计签名检查点",
    "zh-HK": "稽核簽章檢查點",
    en: "Signed Audit Checkpoint",
  },
  "admin.ops.openExceptions": {
    "zh-CN": "打开异常处置台",
    "zh-HK": "開啟異常處置台",
    en: "Exceptions Console",
  },
  "admin.ops.openPeople": {
    "zh-CN": "员工模块授权管理",
    "zh-HK": "員工模組授權管理",
    en: "Employee Access",
  },

  // === ExceptionsConsoleView ===
  "admin.exceptions.title": {
    "zh-CN": "异常与回执核查台",
    "zh-HK": "異常與回執核查台",
    en: "Exceptions Console",
  },
  "admin.exceptions.subtitle": {
    "zh-CN": "集中处理传输结果待确认与达到回查上限的单据，支持只读重新核验",
    "zh-HK": "集中處理傳輸結果待確認與達到回查上限的單據，支援唯讀重新核驗",
    en: "Resolve unknown outcomes and operator-escalated proposals via safe read-only verification",
  },
  "admin.exceptions.reconcileBtn": {
    "zh-CN": "重新发起只读核验",
    "zh-HK": "重新發起唯讀核驗",
    en: "Reopen Verification",
  },
  "admin.exceptions.empty": {
    "zh-CN": "当前无待处置异常单据",
    "zh-HK": "目前無待處置異常單據",
    en: "No exceptions requiring action",
  },

  // === PeopleDirectoryView & EmployeeAccessDetailView ===
  "admin.people.title": {
    "zh-CN": "员工权限与模块治理",
    "zh-HK": "員工權限與模組治理",
    en: "Employee Module Access",
  },
  "admin.people.subtitle": {
    "zh-CN": "按员工独立配置工作台模块授权、仓库范围与到期时间，即时生效并写入审计日志",
    "zh-HK": "按員工獨立設定工作台模組授權、倉庫範圍與到期時間，即時生效並寫入稽核紀錄",
    en: "Configure per-employee workbench modules, warehouse scopes, and expiration with audit logging",
  },
  "admin.people.searchPlaceholder": {
    "zh-CN": "搜索员工账号…",
    "zh-HK": "搜尋員工帳號…",
    en: "Search employee account…",
  },
  "admin.people.manageAccess": {
    "zh-CN": "管理模块权限",
    "zh-HK": "管理模組權限",
    en: "Manage Access",
  },
  "admin.people.selfManagedNotice": {
    "zh-CN": "管理员不可修改本人模块授权，如需调整请由其他权限管理员操作。",
    "zh-HK": "管理員不可修改本人模組授權，如需調整請由其他權限管理員操作。",
    en: "Administrators cannot edit their own module access. Ask another access admin.",
  },
  "admin.people.saveModule": {
    "zh-CN": "保存模块授权",
    "zh-HK": "儲存模組授權",
    en: "Save Assignment",
  },
  "admin.people.revokeModule": {
    "zh-CN": "撤销该模块",
    "zh-HK": "撤銷此模組",
    en: "Revoke Module",
  },
  "admin.people.resetInherited": {
    "zh-CN": "恢复继承默认",
    "zh-HK": "恢復繼承預設",
    en: "Reset to Inherited",
  },
  "admin.people.expiryLabel": {
    "zh-CN": "授权到期时间（选填）",
    "zh-HK": "授權到期時間（選填）",
    en: "Expiration (Optional)",
  },
  "admin.people.expiryPreset.7d": {
    "zh-CN": "+7 天",
    "zh-HK": "+7 天",
    en: "+7d",
  },
  "admin.people.expiryPreset.30d": {
    "zh-CN": "+30 天",
    "zh-HK": "+30 天",
    en: "+30d",
  },
  "admin.people.expiryPreset.90d": {
    "zh-CN": "+90 天",
    "zh-HK": "+90 天",
    en: "+90d",
  },
  "admin.people.expiryPreset.clear": {
    "zh-CN": "永久有效",
    "zh-HK": "永久有效",
    en: "No expiry",
  },
  "admin.people.warehousesLabel": {
    "zh-CN": "授权仓库范围",
    "zh-HK": "授權倉庫範圍",
    en: "Authorized Warehouses",
  },
  "admin.people.grantsLabel": {
    "zh-CN": "细粒度操作权限",
    "zh-HK": "細粒度操作權限",
    en: "Module Grants",
  },
  "admin.people.state.inherited.label": {
    "zh-CN": "继承身份权限",
    "zh-HK": "繼承身份權限",
    en: "Inherited",
  },
  "admin.people.state.inherited.summary": {
    "zh-CN": "尚未单独配置，当前沿用员工默认权限。",
    "zh-HK": "尚未單獨設定，目前沿用員工預設權限。",
    en: "No explicit override; using employee's default identity grants.",
  },
  "admin.people.state.active.label": {
    "zh-CN": "已显式配置",
    "zh-HK": "已明確設定",
    en: "Explicit Override",
  },
  "admin.people.state.active.summary": {
    "zh-CN": "独立授权规则生效中，实际访问范围将与员工身份已验证仓库取交集。",
    "zh-HK": "獨立授權規則生效中，實際存取範圍將與員工身份已驗證倉庫取交集。",
    en: "Explicit grant active; effective scope intersects with verified identity warehouses.",
  },
  "admin.people.state.revoked.label": {
    "zh-CN": "已撤销",
    "zh-HK": "已撤銷",
    en: "Revoked",
  },
  "admin.people.state.revoked.summary": {
    "zh-CN": "已撤销此模块授权，相关查询与待派发提案已阻断。",
    "zh-HK": "已撤銷此模組授權，相關查詢與待派發提案已阻斷。",
    en: "Module access revoked; queries and queued proposals are blocked.",
  },
  "admin.people.state.expired.label": {
    "zh-CN": "已到期",
    "zh-HK": "已到期",
    en: "Expired",
  },
  "admin.people.state.expired.summary": {
    "zh-CN": "该授权已超过设定到期时间，当前不再开放此模块。",
    "zh-HK": "該授權已超過設定到期時間，目前不再開放此模組。",
    en: "Assignment passed its expiration timestamp and is no longer active.",
  },
} as const satisfies Record<string, TrilingualText>;

// ============================================================================
// Structured Module Access & Grant Metadata (All 5 Modules + All 8 Grants)
// ============================================================================

export const MODULE_ACCESS_META_I18N: Readonly<
  Record<
    string,
    { index: string; title: TrilingualText; description: TrilingualText }
  >
> = {
  orders: {
    index: "01",
    title: { "zh-CN": "订单", "zh-HK": "訂單", en: "Orders" },
    description: {
      "zh-CN": "查看销售订单进件与草稿，或创建并提交销售订单草稿提案。",
      "zh-HK": "檢視銷售訂單進件與草稿，或建立並提交銷售訂單草稿提案。",
      en: "Inspect sales order intakes and drafts, or create and submit sales order proposals.",
    },
  },
  dispatch: {
    index: "02",
    title: { "zh-CN": "调度", "zh-HK": "調度", en: "Dispatch" },
    description: {
      "zh-CN": "查看仓内运单排期，或发起运单交期改期提案。",
      "zh-HK": "檢視倉內運單排期，或發起運單交期改期提案。",
      en: "View warehouse shipment schedules or submit delivery date reschedule proposals.",
    },
  },
  "invoice-review": {
    index: "03",
    title: { "zh-CN": "发票审阅", "zh-HK": "發票審閱", en: "Invoice Review" },
    description: {
      "zh-CN": "按授权仓库范围查询财务发票金额、币种与结算状态。",
      "zh-HK": "按授權倉庫範圍查詢財務發票金額、幣別與結算狀態。",
      en: "Inspect invoice totals, currency, and settlement status within authorized sites.",
    },
  },
  "warehouse-insights": {
    index: "04",
    title: { "zh-CN": "仓库概览", "zh-HK": "倉庫概覽", en: "Warehouse Insights" },
    description: {
      "zh-CN": "查看授权仓库的开放运单统计与经营汇总快照。",
      "zh-HK": "檢視授權倉庫的開放運單統計與營運摘要快照。",
      en: "View open shipment counts and operational summary snapshots per warehouse.",
    },
  },
  "agent-web": {
    index: "06",
    title: { "zh-CN": "Agent 公开搜索", "zh-HK": "Agent 公開搜尋", en: "Agent web search" },
    description: {
      "zh-CN": "允许员工通过 Agent 查询公开业务资料。",
      "zh-HK": "允許員工透過 Agent 搜尋公開業務資料。",
      en: "Allow the employee to search public business sources.",
    },
  },
  "agent-collaboration": {
    index: "07",
    title: { "zh-CN": "Agent 协作读取", "zh-HK": "Agent 協作讀取", en: "Agent collaboration" },
    description: {
      "zh-CN": "分别开放员工本人日历和已提交提案。",
      "zh-HK": "分別開放員工自己的行事曆及已提交提案。",
      en: "Give the Agent separate access to the employee's calendar and submitted proposals.",
    },
  },
  "agent-knowledge": {
    index: "08",
    title: { "zh-CN": "Agent 内部知识", "zh-HK": "Agent 內部知識", en: "Agent internal knowledge" },
    description: {
      "zh-CN": "查询被授权仓库的企业知识来源与摘录。",
      "zh-HK": "搜尋獲授權倉庫的企業知識來源及摘錄。",
      en: "Read cited knowledge excerpts within authorized warehouses.",
    },
  },
  "agent-documents": {
    index: "09",
    title: { "zh-CN": "Agent 文档与报告", "zh-HK": "Agent 文件與報告", en: "Agent documents & reports" },
    description: {
      "zh-CN": "分别开放 Office/PDF 附件解析与工作报告下载。",
      "zh-HK": "分別開放 Office/PDF 附件解析與工作報告下載。",
      en: "Grant Office/PDF attachment parsing and report downloads independently.",
    },
  },
  approvals: {
    index: "05",
    title: { "zh-CN": "审批", "zh-HK": "審批", en: "Approvals" },
    description: {
      "zh-CN": "独立审批订单草稿与运单改期提案（仅主管或管理员角色生效）。",
      "zh-HK": "獨立審批訂單草稿與運單改期提案（僅主管或管理員角色生效）。",
      en: "Independently approve sales order drafts and shipment reschedules (manager/admin only).",
    },
  },
};

export const GRANT_LABELS_I18N: Readonly<
  Partial<Record<Grant, TrilingualText>>
> = {
  "order.read": {
    "zh-CN": "读取订单进件与草稿",
    "zh-HK": "讀取訂單進件與草稿",
    en: "Read order intakes & drafts",
  },
  "order.work": {
    "zh-CN": "上传进件与创建订单草稿",
    "zh-HK": "上傳進件與建立訂單草稿",
    en: "Upload intakes & prepare drafts",
  },
  "shipment.read": {
    "zh-CN": "读取运单排期",
    "zh-HK": "讀取運單排期",
    en: "Read shipment schedules",
  },
  "shipment.reschedule": {
    "zh-CN": "发起运单改期提案",
    "zh-HK": "發起運單改期提案",
    en: "Propose shipment reschedules",
  },
  "finance.read": {
    "zh-CN": "读取财务发票",
    "zh-HK": "讀取財務發票",
    en: "Read financial invoices",
  },
  "decision.read": {
    "zh-CN": "读取仓库经营汇总",
    "zh-HK": "讀取倉庫營運摘要",
    en: "Read warehouse insights",
  },
  "agent.web_search": { "zh-CN": "查询公开网页", "zh-HK": "搜尋公開網頁", en: "Search the public web" },
  "agent.calendar_read": { "zh-CN": "读取本人日历", "zh-HK": "讀取本人行事曆", en: "Read own calendar" },
  "agent.tasks_read": { "zh-CN": "读取本人已提交提案", "zh-HK": "讀取本人已提交提案", en: "Read own submitted proposals" },
  "agent.documents_parse": { "zh-CN": "解析 Office/PDF", "zh-HK": "解析 Office/PDF", en: "Parse Office/PDF" },
  "agent.report_export": { "zh-CN": "下载工作报告", "zh-HK": "下載工作報告", en: "Download work reports" },
  "agent.knowledge_read": { "zh-CN": "读取仓库知识库", "zh-HK": "讀取倉庫知識庫", en: "Search warehouse knowledge" },
  "workbench.approve.orders": {
    "zh-CN": "审批销售订单草稿",
    "zh-HK": "審批銷售訂單草稿",
    en: "Approve sales order drafts",
  },
  "workbench.approve.shipments": {
    "zh-CN": "审批运单改期提案",
    "zh-HK": "審批運單改期提案",
    en: "Approve shipment reschedules",
  },
};

export const TIMEZONE_LABELS_I18N: Readonly<Record<string, TrilingualText>> = {
  "Asia/Hong_Kong": {
    "zh-CN": "香港时间",
    "zh-HK": "香港時間",
    en: "Hong Kong Time",
  },
  "Asia/Shanghai": {
    "zh-CN": "北京时间",
    "zh-HK": "北京時間",
    en: "China Standard Time",
  },
  "Asia/Taipei": {
    "zh-CN": "台北时间",
    "zh-HK": "台北時間",
    en: "Taipei Time",
  },
  "Asia/Singapore": {
    "zh-CN": "新加坡时间",
    "zh-HK": "新加坡時間",
    en: "Singapore Time",
  },
  "Asia/Tokyo": {
    "zh-CN": "东京时间",
    "zh-HK": "東京時間",
    en: "Japan Standard Time",
  },
  UTC: {
    "zh-CN": "协调世界时",
    "zh-HK": "協調世界時",
    en: "UTC",
  },
};
