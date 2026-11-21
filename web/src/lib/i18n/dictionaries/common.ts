import type {
  DemoPersonaId,
  DemoPersonaMeta,
  NoticeKind,
  ProposalAction,
  ProposalState,
  Role,
} from "@/lib/types";
import type { Locale, LocalizedPersonaInfo, TrilingualText } from "@/lib/i18n/types";

export const COMMON_DICTIONARY = {
  // Brand & Document Metadata
  "brand.name": {
    "zh-CN": "SME AIOS",
    "zh-HK": "SME AIOS",
    en: "SME AIOS",
  },
  "brand.title": {
    "zh-CN": "SME AIOS · 企业运营工作台",
    "zh-HK": "SME AIOS · 企業營運工作台",
    en: "SME AIOS · Enterprise Operations Workbench",
  },
  "brand.description": {
    "zh-CN": "基于同源企业身份、最小权限边界与可核验回执的企业 AI 运营工作台",
    "zh-HK": "基於同源企業身份、最小權限邊界與可核驗回執的企業 AI 營運工作台",
    en: "Enterprise AI operations workbench with unified identity, least-privilege boundaries, and verifiable receipts",
  },
  "brand.tagline": {
    "zh-CN": "企业智能运营工作台",
    "zh-HK": "企業智能營運工作台",
    en: "Enterprise Operations Workbench",
  },
  "brand.defaultAgentName": {
    "zh-CN": "个人业务助手",
    "zh-HK": "個人業務助手",
    en: "Personal Agent",
  },

  // Preferences Controls (Language & Theme)
  "prefs.languageAria": {
    "zh-CN": "切换界面语言",
    "zh-HK": "切換介面語言",
    en: "Switch language",
  },
  "prefs.languageLabel": {
    "zh-CN": "界面语言",
    "zh-HK": "介面語言",
    en: "Language",
  },
  "prefs.themeLabel": {
    "zh-CN": "外观主题",
    "zh-HK": "外觀主題",
    en: "Appearance",
  },
  "prefs.themeLight": {
    "zh-CN": "浅色",
    "zh-HK": "淺色",
    en: "Light",
  },
  "prefs.themeDark": {
    "zh-CN": "深色",
    "zh-HK": "深色",
    en: "Dark",
  },
  "prefs.switchToDark": {
    "zh-CN": "切换至深色模式",
    "zh-HK": "切換至深色模式",
    en: "Switch to dark mode",
  },
  "prefs.switchToLight": {
    "zh-CN": "切换至浅色模式",
    "zh-HK": "切換至淺色模式",
    en: "Switch to light mode",
  },

  // AppShell Navigation & Session States
  "shell.verifyingSession": {
    "zh-CN": "正在核验企业会话…",
    "zh-HK": "正在核驗企業工作階段…",
    en: "Verifying session…",
  },
  "shell.redirectingLogin": {
    "zh-CN": "正在跳转至登录页…",
    "zh-HK": "正在跳轉至登入頁…",
    en: "Redirecting to sign in…",
  },
  "shell.backToInbox": {
    "zh-CN": "返回会话",
    "zh-HK": "返回訊息",
    en: "Messages",
  },
  "shell.mainNavAria": {
    "zh-CN": "主导航",
    "zh-HK": "主導覽",
    en: "Main navigation",
  },
  "shell.mobileNavAria": {
    "zh-CN": "移动端主导航",
    "zh-HK": "行動端主導覽",
    en: "Mobile navigation",
  },
  "shell.nav.work": {
    "zh-CN": "待办与进件",
    "zh-HK": "待辦與進件",
    en: "Workbench",
  },
  "shell.nav.workShort": {
    "zh-CN": "工作台",
    "zh-HK": "工作台",
    en: "Work",
  },
  "shell.nav.calendar": {
    "zh-CN": "日历与会议",
    "zh-HK": "日曆與會議",
    en: "Calendar",
  },
  "shell.nav.calendarShort": {
    "zh-CN": "日历",
    "zh-HK": "日曆",
    en: "Calendar",
  },
  "shell.nav.people": {
    "zh-CN": "员工权限",
    "zh-HK": "員工權限",
    en: "Access",
  },
  "shell.nav.peopleShort": {
    "zh-CN": "权限",
    "zh-HK": "權限",
    en: "Access",
  },
  "shell.nav.admin": {
    "zh-CN": "运维监控",
    "zh-HK": "維運監控",
    en: "Ops",
  },
  "shell.nav.adminShort": {
    "zh-CN": "监控",
    "zh-HK": "監控",
    en: "Ops",
  },
  "shell.toggleDrawerAria": {
    "zh-CN": "切换右侧业务面板",
    "zh-HK": "切換右側業務面板",
    en: "Toggle inspector drawer",
  },
  "shell.toggleDrawerTitle": {
    "zh-CN": "侧边核对 (⌘.)",
    "zh-HK": "側邊核對 (⌘.)",
    en: "Inspector (⌘.)",
  },
  "shell.accountMenuAria": {
    "zh-CN": "账号与资料菜单",
    "zh-HK": "帳號與資料選單",
    en: "Account menu",
  },
  "shell.noWarehouse": {
    "zh-CN": "无仓库",
    "zh-HK": "無倉庫",
    en: "No warehouse",
  },
  "shell.menu.profile": {
    "zh-CN": "个人资料",
    "zh-HK": "個人資料",
    en: "Profile",
  },
  "shell.menu.agentProfile": {
    "zh-CN": "个人业务助手资料（{name}）",
    "zh-HK": "個人業務助手資料（{name}）",
    en: "Personal Agent Profile ({name})",
  },
  "shell.menu.logout": {
    "zh-CN": "退出登录",
    "zh-HK": "登出",
    en: "Sign out",
  },
  "shell.closeAccessBannerAria": {
    "zh-CN": "关闭权限变更提示",
    "zh-HK": "關閉權限變更提示",
    en: "Dismiss access notice",
  },
  "shell.accessChangedBanner": {
    "zh-CN": "访问权限已变更，界面能力已同步刷新。",
    "zh-HK": "存取權限已變更，介面功能已同步重新整理。",
    en: "Permissions updated. Available capabilities have been refreshed.",
  },

  // Demo Persona Switcher
  "demo.switcherAria": {
    "zh-CN": "切换本地演示身份",
    "zh-HK": "切換本地示範身份",
    en: "Switch demo persona",
  },
  "demo.switcherTitle": {
    "zh-CN": "本地演示身份切换",
    "zh-HK": "本地示範身份切換",
    en: "Demo Identity Switcher",
  },
  "demo.switcherSubtitle": {
    "zh-CN": "切换时自动清空会话缓存、草稿与在途请求",
    "zh-HK": "切換時自動清除工作階段快取、草稿與在途請求",
    en: "Clears in-memory cache, drafts, and in-flight requests on switch",
  },
  "demo.switchFailed": {
    "zh-CN": "切换身份失败，请重试",
    "zh-HK": "切換身份失敗，請重試",
    en: "Failed to switch identity. Try again.",
  },
  "demo.group.core": {
    "zh-CN": "核心演示岗位",
    "zh-HK": "核心示範職位",
    en: "Core Roles",
  },
  "demo.group.specialist": {
    "zh-CN": "专岗与只读视图",
    "zh-HK": "專職與唯讀檢視",
    en: "Specialist & Read-Only",
  },
  "demo.group.isolation": {
    "zh-CN": "跨仓 / 跨租户隔离验证",
    "zh-HK": "跨倉 / 跨租戶隔離驗證",
    en: "Warehouse & Tenant Isolation",
  },
  "demo.group.coreShort": {
    "zh-CN": "核心岗位",
    "zh-HK": "核心職位",
    en: "Core Roles",
  },
  "demo.group.specialistShort": {
    "zh-CN": "专岗只读",
    "zh-HK": "專職唯讀",
    en: "Specialists",
  },
  "demo.group.isolationShort": {
    "zh-CN": "跨仓与跨租户隔离",
    "zh-HK": "跨倉與跨租戶隔離",
    en: "Isolation Test",
  },

  // Notices Popover
  "notices.label": {
    "zh-CN": "通知",
    "zh-HK": "通知",
    en: "Notifications",
  },
  "notices.unreadAria": {
    "zh-CN": "通知（{count} 条未读）",
    "zh-HK": "通知（{count} 則未讀）",
    en: "Notifications ({count} unread)",
  },
  "notices.title": {
    "zh-CN": "站内通知",
    "zh-HK": "站內通知",
    en: "Notifications",
  },
  "notices.refreshAria": {
    "zh-CN": "刷新通知",
    "zh-HK": "重新整理通知",
    en: "Refresh notifications",
  },
  "notices.loading": {
    "zh-CN": "正在加载通知…",
    "zh-HK": "正在載入通知…",
    en: "Loading notifications…",
  },
  "notices.empty": {
    "zh-CN": "暂无工作台通知",
    "zh-HK": "暫無工作台通知",
    en: "No notifications yet",
  },
  "notices.unreadBadge": {
    "zh-CN": "未读",
    "zh-HK": "未讀",
    en: "New",
  },
  "notices.verifying": {
    "zh-CN": "核验中…",
    "zh-HK": "核驗中…",
    en: "Checking…",
  },
  "notices.view": {
    "zh-CN": "查看",
    "zh-HK": "檢視",
    en: "Open",
  },
  "notices.openFailed": {
    "zh-CN": "暂时无法打开该通知，请稍后重试。",
    "zh-HK": "暫時無法開啟該通知，請稍後重試。",
    en: "Unable to open this notification right now.",
  },
  "notices.footer": {
    "zh-CN": "点击通知时将按当前权限实时核验目标记录",
    "zh-HK": "點擊通知時將按目前權限即時核驗目標紀錄",
    en: "Target records are verified against live permissions when opened",
  },

  // Common Buttons & Dialog Actions
  "common.confirm": {
    "zh-CN": "确认",
    "zh-HK": "確認",
    en: "Confirm",
  },
  "common.confirmExecute": {
    "zh-CN": "确认执行",
    "zh-HK": "確認執行",
    en: "Confirm",
  },
  "common.cancel": {
    "zh-CN": "取消",
    "zh-HK": "取消",
    en: "Cancel",
  },
  "common.save": {
    "zh-CN": "保存",
    "zh-HK": "儲存",
    en: "Save",
  },
  "common.delete": {
    "zh-CN": "删除",
    "zh-HK": "刪除",
    en: "Delete",
  },
  "common.close": {
    "zh-CN": "关闭",
    "zh-HK": "關閉",
    en: "Close",
  },
  "common.closeWindow": {
    "zh-CN": "关闭窗口",
    "zh-HK": "關閉視窗",
    en: "Close dialog",
  },
  "common.expandFullscreen": {
    "zh-CN": "全屏展开",
    "zh-HK": "全螢幕展開",
    en: "Expand fullscreen",
  },
  "common.restoreWindowSize": {
    "zh-CN": "还原窗口尺寸",
    "zh-HK": "還原視窗尺寸",
    en: "Restore size",
  },
  "common.refresh": {
    "zh-CN": "刷新",
    "zh-HK": "重新整理",
    en: "Refresh",
  },
  "common.retry": {
    "zh-CN": "重新尝试",
    "zh-HK": "重試",
    en: "Try again",
  },
  "common.loading": {
    "zh-CN": "加载中…",
    "zh-HK": "載入中…",
    en: "Loading…",
  },
  "common.copy": {
    "zh-CN": "复制",
    "zh-HK": "複製",
    en: "Copy",
  },
  "common.copied": {
    "zh-CN": "已复制",
    "zh-HK": "已複製",
    en: "Copied",
  },
  "common.search": {
    "zh-CN": "搜索",
    "zh-HK": "搜尋",
    en: "Search",
  },
  "common.all": {
    "zh-CN": "全部",
    "zh-HK": "全部",
    en: "All",
  },
  "common.yes": {
    "zh-CN": "是",
    "zh-HK": "是",
    en: "Yes",
  },
  "common.no": {
    "zh-CN": "否",
    "zh-HK": "否",
    en: "No",
  },
  "common.backToWorkbench": {
    "zh-CN": "返回工作台",
    "zh-HK": "返回工作台",
    en: "Back to Workbench",
  },
  "common.viewDetails": {
    "zh-CN": "查看详情",
    "zh-HK": "檢視詳情",
    en: "View details",
  },
  "common.impactScope": {
    "zh-CN": "影响范围：",
    "zh-HK": "影響範圍：",
    en: "Scope: ",
  },
  "common.requestId": {
    "zh-CN": "跟踪编号",
    "zh-HK": "追蹤編號",
    en: "Request ID",
  },
  "common.runId": {
    "zh-CN": "运行编号",
    "zh-HK": "執行編號",
    en: "Run ID",
  },
  "common.yesterday": {
    "zh-CN": "昨天",
    "zh-HK": "昨天",
    en: "Yesterday",
  },
  "common.expired": {
    "zh-CN": "已过期",
    "zh-HK": "已過期",
    en: "Expired",
  },
  "common.expiresInMinutes": {
    "zh-CN": "{minutes} 分钟后到期",
    "zh-HK": "{minutes} 分鐘後到期",
    en: "Expires in {minutes}m",
  },

  // Access Notice Card & Standard Error Notices
  "notice.recordUnavailable.title": {
    "zh-CN": "记录不可访问",
    "zh-HK": "紀錄無法存取",
    en: "Record Unavailable",
  },
  "notice.recordUnavailable.message": {
    "zh-CN": "当前账号无法访问这条记录。",
    "zh-HK": "目前帳號無法存取這筆紀錄。",
    en: "This record is unavailable for your account.",
  },
  "notice.accessRestricted.title": {
    "zh-CN": "访问范围受限",
    "zh-HK": "存取範圍受限",
    en: "Access Restricted",
  },
  "notice.accessRestricted.message": {
    "zh-CN": "当前账号无权执行此操作或访问该仓库范围。",
    "zh-HK": "目前帳號無權執行此操作或存取該倉庫範圍。",
    en: "Your account does not have permission for this action or warehouse scope.",
  },
  "notice.actionNotAllowed.title": {
    "zh-CN": "当前账号不可执行该动作",
    "zh-HK": "目前帳號不可執行該操作",
    en: "Action Not Permitted",
  },
  "notice.actionNotAllowed.message": {
    "zh-CN": "该操作需要独立审批授权或更高级别范围，您可以只读查看单据详情。",
    "zh-HK": "該操作需要獨立審批授權或更進階範圍，您可唯讀檢視單據詳情。",
    en: "This action requires independent approval authority. You may inspect the record read-only.",
  },
  "notice.accessChanged.title": {
    "zh-CN": "访问权限已变更",
    "zh-HK": "存取權限已變更",
    en: "Permissions Updated",
  },
  "notice.accessChanged.message": {
    "zh-CN": "访问权限已变更，已清除旧视图并同步刷新可用能力。",
    "zh-HK": "存取權限已變更，已清除舊檢視並同步重新整理可用功能。",
    en: "Permissions changed. Stale views were cleared and capabilities refreshed.",
  },
  "notice.conflict.title": {
    "zh-CN": "数据快照已更新",
    "zh-HK": "資料快照已更新",
    en: "Snapshot Updated",
  },
  "notice.conflict.message": {
    "zh-CN": "数据已更新，请刷新并核对最新快照后再确认。",
    "zh-HK": "資料已更新，請重新整理並核對最新快照後再確認。",
    en: "This record changed elsewhere. Reload the latest snapshot before confirming.",
  },
  "notice.retryLater.title": {
    "zh-CN": "服务繁忙或上游连接暂不可用",
    "zh-HK": "服務繁忙或上游連線暫時無法使用",
    en: "Service Busy or Unavailable",
  },
  "notice.retryLater.countdown": {
    "zh-CN": "服务繁忙或连接器暂不可用，请在 {seconds} 秒后重试。",
    "zh-HK": "服務繁忙或連接器暫時無法使用，請於 {seconds} 秒後重試。",
    en: "Upstream service is temporarily unavailable. Retry in {seconds}s.",
  },
  "notice.retryLater.ready": {
    "zh-CN": "服务繁忙或连接器暂不可用，请保留当前输入后点击重试。",
    "zh-HK": "服務繁忙或連接器暫時無法使用，請保留目前輸入後點擊重試。",
    en: "Upstream service is temporarily unavailable. Keep your input and try again.",
  },
  "notice.authorizedWarehouses": {
    "zh-CN": "当前已授权仓库：",
    "zh-HK": "目前已授權倉庫：",
    en: "Authorized warehouses:",
  },
  "notice.switchWarehouse": {
    "zh-CN": "切换至 {warehouse}",
    "zh-HK": "切換至 {warehouse}",
    en: "Switch to {warehouse}",
  },
  "notice.viewProposalDetail": {
    "zh-CN": "查看单据详情",
    "zh-HK": "檢視單據詳情",
    en: "View Proposal",
  },
  "notice.waitSeconds": {
    "zh-CN": "请等待 {seconds}s",
    "zh-HK": "請稍候 {seconds}s",
    en: "Wait {seconds}s",
  },
  "notice.refreshSnapshot": {
    "zh-CN": "刷新最新快照",
    "zh-HK": "重新整理最新快照",
    en: "Reload Snapshot",
  },

  // Kinetic: BriefProgressChain, StatePulseBeacon, ExecutionTopologyRibbon
  "kinetic.processingRequest": {
    "zh-CN": "正在处理请求…",
    "zh-HK": "正在處理請求…",
    en: "Processing request…",
  },
  "kinetic.queuedRetry": {
    "zh-CN": "请求正在排队处理（{seconds}s 后复查）",
    "zh-HK": "請求正在排隊處理（{seconds}s 後複查）",
    en: "Request queued (checking in {seconds}s)",
  },
  "kinetic.serverCheckFailed": {
    "zh-CN": "服务端校验未通过",
    "zh-HK": "伺服器端校驗未通過",
    en: "Server verification failed",
  },
  "kinetic.completed": {
    "zh-CN": "已完成",
    "zh-HK": "已完成",
    en: "Completed",
  },
  "kinetic.completedGenericStep": {
    "zh-CN": "已校验身份并完成服务端处理",
    "zh-HK": "已校驗身份並完成伺服器端處理",
    en: "Identity verified and request completed",
  },
  "kinetic.completedSteps": {
    "zh-CN": "已完成 · {count} 步业务核验",
    "zh-HK": "已完成 · {count} 步業務核驗",
    en: "Done · {count} verified steps",
  },
  "kinetic.currentScope": {
    "zh-CN": "当前授权范围",
    "zh-HK": "目前授權範圍",
    en: "Authorized scope",
  },
  "kinetic.currentTenant": {
    "zh-CN": "当前租户",
    "zh-HK": "目前租戶",
    en: "Current tenant",
  },
  "kinetic.result.summary": {
    "zh-CN": "已完成 · 3 步业务核验",
    "zh-HK": "已完成 · 3 步業務核驗",
    en: "Done · 3 verification steps",
  },
  "kinetic.result.stepScope": {
    "zh-CN": "身份与仓库范围核验（{tenant} · {warehouse}）",
    "zh-HK": "身份與倉庫範圍核驗（{tenant} · {warehouse}）",
    en: "Identity & warehouse scope verified ({tenant} · {warehouse})",
  },
  "kinetic.result.stepTool": {
    "zh-CN": "受控工具实时读取（{tool} · 来源 {source}）",
    "zh-HK": "受控工具即時讀取（{tool} · 來源 {source}）",
    en: "Typed tool query ({tool} · {source})",
  },
  "kinetic.result.stepOutput": {
    "zh-CN": "已输出实时只读视图",
    "zh-HK": "已輸出即時唯讀檢視",
    en: "Live read-only view rendered",
  },
  "kinetic.proposal.summaryVerified": {
    "zh-CN": "已核验入账 · 3 步核验",
    "zh-HK": "已核驗入帳 · 3 步核驗",
    en: "Verified & posted · 3 steps",
  },
  "kinetic.proposal.summaryProposed": {
    "zh-CN": "已生成待审批提案 · 3 步核验",
    "zh-HK": "已產生待審批提案 · 3 步核驗",
    en: "Proposal ready · 3 steps",
  },
  "kinetic.proposal.stepScope": {
    "zh-CN": "身份与发起权限核验（{warehouse}）",
    "zh-HK": "身份與發起權限核驗（{warehouse}）",
    en: "Requester & warehouse scope verified ({warehouse})",
  },
  "kinetic.proposal.stepDigest": {
    "zh-CN": "已生成变更方案并锁定摘要",
    "zh-HK": "已產生變更方案並鎖定摘要",
    en: "Change plan created & digest locked",
  },
  "kinetic.proposal.stepAwaitingApproval": {
    "zh-CN": "等待独立主管确认",
    "zh-HK": "等待獨立主管確認",
    en: "Awaiting independent manager approval",
  },
  "kinetic.proposal.stepState": {
    "zh-CN": "当前状态：{state}",
    "zh-HK": "目前狀態：{state}",
    en: "Current state: {state}",
  },
  "kinetic.approvalPreview.summary": {
    "zh-CN": "已生成审批预览 · 2 步核验",
    "zh-HK": "已產生審批預覽 · 2 步核驗",
    en: "Approval preview · 2 steps",
  },
  "kinetic.approvalPreview.stepSnapshot": {
    "zh-CN": "已核对单据最新状态与摘要（{warehouse}）",
    "zh-HK": "已核對單據最新狀態與摘要（{warehouse}）",
    en: "Latest proposal state & digest verified ({warehouse})",
  },
  "kinetic.approvalPreview.stepConfirm": {
    "zh-CN": "需在单据详情或右侧面板显式确认",
    "zh-HK": "須於單據詳情或右側面板明確確認",
    en: "Requires explicit confirmation in inspector",
  },
  "kinetic.clarify.summary": {
    "zh-CN": "待补充查询要素 · 2 步核验",
    "zh-HK": "待補充查詢條件 · 2 步核驗",
    en: "Needs details · 2 steps",
  },
  "kinetic.clarify.stepCaps": {
    "zh-CN": "已核对账号可用业务工具范围（{tenant}）",
    "zh-HK": "已核對帳號可用業務工具範圍（{tenant}）",
    en: "Authorized tool boundaries verified ({tenant})",
  },
  "kinetic.clarify.stepWait": {
    "zh-CN": "等待补充必要参数后继续执行",
    "zh-HK": "等待補充必要參數後繼續執行",
    en: "Awaiting required parameters to proceed",
  },
  "kinetic.beacon.queued": {
    "zh-CN": "已批准 · 等待执行",
    "zh-HK": "已批准 · 等待執行",
    en: "Approved · Queued",
  },
  "kinetic.beacon.sending": {
    "zh-CN": "正在提交 ERP",
    "zh-HK": "正在提交 ERP",
    en: "Writing to ERP",
  },
  "kinetic.beacon.verifying": {
    "zh-CN": "正在核对回执",
    "zh-HK": "正在核對回執",
    en: "Verifying receipt",
  },
  "kinetic.beacon.unknown": {
    "zh-CN": "结果待确认",
    "zh-HK": "結果待確認",
    en: "Outcome pending",
  },
  "kinetic.beacon.operatorNeeded": {
    "zh-CN": "需人工核查",
    "zh-HK": "須人工核查",
    en: "Needs operator",
  },
  "kinetic.beacon.verified": {
    "zh-CN": "已核验入账",
    "zh-HK": "已核驗入帳",
    en: "Verified",
  },
  "kinetic.beacon.rejected": {
    "zh-CN": "已拒绝 / 终止",
    "zh-HK": "已拒絕 / 終止",
    en: "Rejected",
  },
  "kinetic.topology.title": {
    "zh-CN": "单据执行进度",
    "zh-HK": "單據執行進度",
    en: "Execution Progress",
  },
  "kinetic.topology.checks": {
    "zh-CN": "核验轮次 {checks}/3",
    "zh-HK": "核驗輪次 {checks}/3",
    en: "Check {checks}/3",
  },
  "kinetic.topology.step.proposed": {
    "zh-CN": "待审批",
    "zh-HK": "待審批",
    en: "Proposed",
  },
  "kinetic.topology.step.queued": {
    "zh-CN": "已批准",
    "zh-HK": "已批准",
    en: "Approved",
  },
  "kinetic.topology.step.sending": {
    "zh-CN": "ERP 写入",
    "zh-HK": "ERP 寫入",
    en: "ERP Write",
  },
  "kinetic.topology.step.verifying": {
    "zh-CN": "回执核验",
    "zh-HK": "回執核驗",
    en: "Verifying",
  },
  "kinetic.topology.step.verified": {
    "zh-CN": "已入账",
    "zh-HK": "已入帳",
    en: "Verified",
  },
  "kinetic.topology.branch.unknown": {
    "zh-CN": "结果待确认 · 等待回查",
    "zh-HK": "結果待確認 · 等待回查",
    en: "Outcome unknown · Awaiting readback",
  },
  "kinetic.topology.branch.operator": {
    "zh-CN": "需人工核查回执",
    "zh-HK": "須人工核查回執",
    en: "Manual receipt verification required",
  },
  "kinetic.topology.branch.rejected": {
    "zh-CN": "已退回 / 已拒绝 / 终止",
    "zh-HK": "已退回 / 已拒絕 / 終止",
    en: "Returned / Rejected / Stopped",
  },
} as const satisfies Record<string, TrilingualText>;

// ============================================================================
// Structured Runtime Lookup Tables (Statuses, Roles, Actions, Sources, Errors, Personas)
// ============================================================================

export const ROLE_LABELS_I18N: Readonly<Record<Role, TrilingualText>> = {
  viewer: { "zh-CN": "只读", "zh-HK": "唯讀", en: "Viewer" },
  operator: { "zh-CN": "经办", "zh-HK": "經辦", en: "Operator" },
  manager: { "zh-CN": "主管", "zh-HK": "主管", en: "Manager" },
  admin: { "zh-CN": "管理员", "zh-HK": "管理員", en: "Admin" },
};

export const PROPOSAL_ACTION_LABELS_I18N: Readonly<
  Record<ProposalAction, TrilingualText>
> = {
  "sales_order.create_draft": {
    "zh-CN": "销售订单草稿",
    "zh-HK": "銷售訂單草稿",
    en: "Sales Order Draft",
  },
  "shipment.reschedule": {
    "zh-CN": "运单改期",
    "zh-HK": "運單改期",
    en: "Shipment Reschedule",
  },
};

export const TOOL_LABELS_I18N: Readonly<Record<string, TrilingualText>> = {
  "shipment.read": {
    "zh-CN": "运单查询",
    "zh-HK": "運單查詢",
    en: "Shipment Lookup",
  },
  "shipment.reschedule": {
    "zh-CN": "运单改期提案",
    "zh-HK": "運單改期提案",
    en: "Shipment Reschedule",
  },
  "order.draft.prepare": {
    "zh-CN": "销售订单草稿",
    "zh-HK": "銷售訂單草稿",
    en: "Sales Order Draft",
  },
  "finance.invoice.read": {
    "zh-CN": "财务发票核对",
    "zh-HK": "財務發票核對",
    en: "Invoice Lookup",
  },
  "mail.inbox.read": {
    "zh-CN": "企业邮箱读取",
    "zh-HK": "企業電郵讀取",
    en: "Corporate Mail",
  },
  "decision.warehouse.summary": {
    "zh-CN": "仓库经营汇总",
    "zh-HK": "倉庫營運摘要",
    en: "Warehouse Summary",
  },
};

export const SOURCE_LABELS_I18N: Readonly<Record<string, TrilingualText>> = {
  erp: { "zh-CN": "ERP", "zh-HK": "ERP", en: "ERP" },
  synthetic: { "zh-CN": "合成数据", "zh-HK": "合成資料", en: "Synthetic" },
  finance: { "zh-CN": "财务系统", "zh-HK": "財務系統", en: "Finance" },
  mail: { "zh-CN": "企业邮箱", "zh-HK": "企業電郵", en: "Mail" },
  decision: { "zh-CN": "经营汇总", "zh-HK": "營運摘要", en: "Insights" },
  internal: { "zh-CN": "站内记录", "zh-HK": "站內紀錄", en: "Internal" },
  mcp: { "zh-CN": "MCP 实时", "zh-HK": "MCP 即時", en: "Live MCP" },
  unconfigured: { "zh-CN": "未配置", "zh-HK": "未設定", en: "Unconfigured" },
};

export const STATUS_LABELS_I18N: Readonly<Record<string, TrilingualText>> = {
  // 9 Canonical Proposal States
  PROPOSED: { "zh-CN": "待审批", "zh-HK": "待審批", en: "Pending Approval" },
  QUEUED: { "zh-CN": "已批准 · 待派发", "zh-HK": "已批准 · 待派發", en: "Approved · Queued" },
  SENDING: { "zh-CN": "ERP 写入中", "zh-HK": "ERP 寫入中", en: "Writing to ERP" },
  VERIFYING: { "zh-CN": "回执核验中", "zh-HK": "回執核驗中", en: "Verifying Receipt" },
  CHECKING: { "zh-CN": "回执复核中", "zh-HK": "回執覆核中", en: "Re-checking Receipt" },
  OUTCOME_UNKNOWN: { "zh-CN": "结果待确认", "zh-HK": "結果待確認", en: "Outcome Unknown" },
  VERIFIED: { "zh-CN": "已核验入账", "zh-HK": "已核驗入帳", en: "Verified" },
  REJECTED: { "zh-CN": "已拒绝 / 终止", "zh-HK": "已拒絕 / 終止", en: "Rejected" },
  NEEDS_OPERATOR: { "zh-CN": "需人工核查", "zh-HK": "須人工核查", en: "Needs Operator" },
  returned: { "zh-CN": "已退回修改", "zh-HK": "已退回修改", en: "Returned" },

  // Assurance States
  PENDING: { "zh-CN": "待审阅", "zh-HK": "待審閱", en: "Pending" },
  HELD: { "zh-CN": "硬性留置", "zh-HK": "強制留置", en: "Held" },
  APPROVED: { "zh-CN": "已批准", "zh-HK": "已批准", en: "Approved" },

  // Module Access States
  inherited: { "zh-CN": "继承身份默认", "zh-HK": "繼承身份預設", en: "Inherited" },
  active: { "zh-CN": "已显式授权", "zh-HK": "已明確授權", en: "Explicit" },
  revoked: { "zh-CN": "已撤销", "zh-HK": "已撤銷", en: "Revoked" },
  expired: { "zh-CN": "已到期", "zh-HK": "已到期", en: "Expired" },

  // System Health / Connectors / Domain Records
  healthy: { "zh-CN": "运行正常", "zh-HK": "運作正常", en: "Healthy" },
  paused: { "zh-CN": "写入已暂停", "zh-HK": "寫入已暫停", en: "Writes Paused" },
  unavailable: { "zh-CN": "服务暂不可用", "zh-HK": "服務暫時無法使用", en: "Unavailable" },
  connected: { "zh-CN": "已连接", "zh-HK": "已連線", en: "Connected" },
  sandbox_ready: { "zh-CN": "待接入凭证", "zh-HK": "待接入憑證", en: "Sandbox Ready" },
  OPEN: { "zh-CN": "未结", "zh-HK": "未結", en: "Open" },
  CLOSED: { "zh-CN": "已关闭", "zh-HK": "已關閉", en: "Closed" },
  PAID: { "zh-CN": "已结算", "zh-HK": "已結算", en: "Paid" },
  VOID: { "zh-CN": "已作废", "zh-HK": "已作廢", en: "Void" },
  cancelled: { "zh-CN": "已取消", "zh-HK": "已取消", en: "Cancelled" },
};

export const COMPACT_PROPOSAL_STATE_LABELS_I18N: Readonly<
  Record<ProposalState, TrilingualText>
> = {
  PROPOSED: { "zh-CN": "待审批", "zh-HK": "待審批", en: "Proposed" },
  QUEUED: { "zh-CN": "已批准", "zh-HK": "已批准", en: "Queued" },
  SENDING: { "zh-CN": "写入中", "zh-HK": "寫入中", en: "Sending" },
  VERIFYING: { "zh-CN": "核验中", "zh-HK": "核驗中", en: "Verifying" },
  CHECKING: { "zh-CN": "复核中", "zh-HK": "覆核中", en: "Checking" },
  OUTCOME_UNKNOWN: { "zh-CN": "待确认", "zh-HK": "待確認", en: "Unknown" },
  NEEDS_OPERATOR: { "zh-CN": "需人工", "zh-HK": "須人工", en: "Operator" },
  VERIFIED: { "zh-CN": "已入账", "zh-HK": "已入帳", en: "Verified" },
  REJECTED: { "zh-CN": "已拒绝", "zh-HK": "已拒絕", en: "Rejected" },
};

export const NOTICE_KIND_LABELS_I18N: Readonly<
  Record<NoticeKind, TrilingualText>
> = {
  meeting_created: {
    "zh-CN": "新会议通知",
    "zh-HK": "新會議通知",
    en: "Meeting scheduled",
  },
  meeting_changed: {
    "zh-CN": "会议时间变更",
    "zh-HK": "會議時間變更",
    en: "Meeting updated",
  },
  meeting_cancelled: {
    "zh-CN": "会议已取消",
    "zh-HK": "會議已取消",
    en: "Meeting cancelled",
  },
  proposal_assigned: {
    "zh-CN": "单据已分派给你审批",
    "zh-HK": "單據已分派予您審批",
    en: "Proposal assigned for approval",
  },
  proposal_returned: {
    "zh-CN": "提案已退回修改",
    "zh-HK": "提案已退回修改",
    en: "Proposal returned for revision",
  },
  proposal_rejected: {
    "zh-CN": "提案已被拒绝",
    "zh-HK": "提案已被拒絕",
    en: "Proposal rejected",
  },
  proposal_approved: {
    "zh-CN": "提案已批准入队",
    "zh-HK": "提案已批准入隊",
    en: "Proposal approved & queued",
  },
  proposal_verified: {
    "zh-CN": "ERP 回执已核验",
    "zh-HK": "ERP 回執已核驗",
    en: "ERP receipt verified",
  },
  proposal_needs_operator: {
    "zh-CN": "提案需人工核查",
    "zh-HK": "提案須人工核查",
    en: "Proposal requires operator review",
  },
};

export const ERROR_CODE_MESSAGES_I18N: Readonly<Record<string, TrilingualText>> = {
  RECORD_UNAVAILABLE: {
    "zh-CN": "当前账号无法访问这条记录。",
    "zh-HK": "目前帳號無法存取這筆紀錄。",
    en: "This record is unavailable for your account.",
  },
  UNAUTHORIZED: {
    "zh-CN": "登录状态已失效，请重新登录。",
    "zh-HK": "登入狀態已失效，請重新登入。",
    en: "Your session has expired. Please sign in again.",
  },
  SESSION_CSRF_MISSING: {
    "zh-CN": "无法获取会话校验令牌，请重新登录。",
    "zh-HK": "無法取得工作階段校驗憑證，請重新登入。",
    en: "Could not obtain a session security token. Please sign in again.",
  },
  INVALID_CREDENTIALS: {
    "zh-CN": "账号或密码不正确，请检查后重试。",
    "zh-HK": "帳號或密碼不正確，請檢查後重試。",
    en: "Incorrect account or password. Please try again.",
  },
  INVALID_REQUEST: {
    "zh-CN": "请求参数格式无效，请检查后重试。",
    "zh-HK": "請求參數格式無效，請檢查後重試。",
    en: "Invalid request parameters. Please check your input and try again.",
  },
  INVALID_TIME_RANGE: {
    "zh-CN": "会议时间范围无效，结束时间须晚于开始时间且不超过 24 小时。",
    "zh-HK": "會議時間範圍無效，結束時間須晚於開始時間且不可超過 24 小時。",
    en: "Invalid meeting time range. End time must be after start time and within 24 hours.",
  },
  INVALID_ATTENDEE: {
    "zh-CN": "所选参会人不在当前租户通讯录中。",
    "zh-HK": "所選與會者不在目前租戶聯絡人清單中。",
    en: "One or more attendees were not found in your organization directory.",
  },
  CHAT_REQUIRED: {
    "zh-CN": "邀请同事参会需要协作会话权限。",
    "zh-HK": "邀請同事與會需要協作對話權限。",
    en: "Team chat permission is required to invite colleagues to a meeting.",
  },
  INVALID_PERSONA: {
    "zh-CN": "所选演示角色无效，请刷新页面后重试。",
    "zh-HK": "所選示範角色無效，請重新整理頁面後重試。",
    en: "Invalid demo role selected. Refresh the page and try again.",
  },
  DEMO_AUTH_DISABLED: {
    "zh-CN": "当前环境未启用本地演示登录。",
    "zh-HK": "目前環境未啟用本地示範登入。",
    en: "Local demo sign-in is disabled in this environment.",
  },
  PASSWORD_LOGIN_UNAVAILABLE: {
    "zh-CN": "当前环境未开启账号密码登录，请使用企业单点登录。",
    "zh-HK": "目前環境未啟用帳號密碼登入，請使用企業單一登入。",
    en: "Password sign-in is unavailable here. Please use Enterprise SSO.",
  },
  LOGIN_RATE_LIMITED: {
    "zh-CN": "尝试登录次数过多，请稍后再试。",
    "zh-HK": "登入嘗試次數過多，請稍後再試。",
    en: "Too many sign-in attempts. Please wait a few minutes and try again.",
  },
  PAYLOAD_TOO_LARGE: {
    "zh-CN": "上传内容超过大小限制，请精简后重试。",
    "zh-HK": "上傳內容超出大小限制，請精簡後重試。",
    en: "Upload exceeds the maximum allowed size. Please reduce it and try again.",
  },
  METHOD_NOT_ALLOWED: {
    "zh-CN": "当前接口不支持该请求方式。",
    "zh-HK": "目前介面不支援該請求方式。",
    en: "This request method is not supported.",
  },
  CONNECTOR_UNAVAILABLE: {
    "zh-CN": "外部连接器暂不可用，请稍后重试。",
    "zh-HK": "外部連接器暫時無法使用，請稍後重試。",
    en: "External connector is temporarily unavailable. Please try again later.",
  },
  PLANNER_UNAVAILABLE: {
    "zh-CN": "个人业务助手服务暂不可用，请稍后重试。",
    "zh-HK": "個人業務助手服務暫時無法使用，請稍後重試。",
    en: "Personal Agent service is temporarily unavailable. Please try again.",
  },
  OCR_UNAVAILABLE: {
    "zh-CN": "单据 OCR 识别服务暂不可用，请稍后重试。",
    "zh-HK": "單據 OCR 辨識服務暫時無法使用，請稍後重試。",
    en: "Document OCR service is temporarily unavailable. Please try again.",
  },
  CHAT_UNAVAILABLE: {
    "zh-CN": "协作会话服务暂不可用，请稍后重试。",
    "zh-HK": "協作對話服務暫時無法使用，請稍後重試。",
    en: "Team chat service is temporarily unavailable. Please try again.",
  },
  ASSURANCE_UNCONFIGURED: {
    "zh-CN": "受控预审服务尚未配置或暂未启用。",
    "zh-HK": "受控預審服務尚未設定或暫未啟用。",
    en: "Assurance review service is not configured in this environment.",
  },
  ORIGIN_REJECTED: {
    "zh-CN": "请求来源未获授权。",
    "zh-HK": "請求來源未獲授權。",
    en: "Request origin is not authorized.",
  },
  CSRF_REJECTED: {
    "zh-CN": "安全校验令牌已失效，请重试。",
    "zh-HK": "安全校驗憑證已失效，請重試。",
    en: "Security token expired. Please try again.",
  },
  ACCESS_RESTRICTED: {
    "zh-CN": "当前账号无权执行此操作或访问该仓库范围。",
    "zh-HK": "目前帳號無權執行此操作或存取該倉庫範圍。",
    en: "Your account is not authorized for this action or warehouse scope.",
  },
  ACTION_NOT_ALLOWED: {
    "zh-CN": "当前账号无权批准该提案，可切换为只读查看详情。",
    "zh-HK": "目前帳號無權批准該提案，可切換為唯讀檢視詳情。",
    en: "Your account cannot approve this proposal. You may inspect it read-only.",
  },
  ACCESS_CHANGED: {
    "zh-CN": "访问权限已变更，界面能力已同步刷新。",
    "zh-HK": "存取權限已變更，介面功能已同步重新整理。",
    en: "Permissions updated. Available capabilities have been refreshed.",
  },
  SUSPENDED: {
    "zh-CN": "当前账号访问已被停用。",
    "zh-HK": "目前帳號存取已被停用。",
    en: "Access for this account is currently suspended.",
  },
  TURN_IN_PROGRESS: {
    "zh-CN": "该指令仍在处理中，请稍候自动同步结果。",
    "zh-HK": "該指令仍在處理中，請稍候自動同步結果。",
    en: "This turn is still in progress. Results will sync automatically.",
  },
  REVIEW_IN_PROGRESS: {
    "zh-CN": "受控预审正在执行中，请稍候重试。",
    "zh-HK": "受控預審正在執行中，請稍後重試。",
    en: "Assurance review is already in progress. Try again shortly.",
  },
  REVIEW_SNAPSHOT_CONFLICT: {
    "zh-CN": "源数据快照已变更，请刷新最新记录后重新确认。",
    "zh-HK": "源資料快照已變更，請重新整理最新紀錄後再確認。",
    en: "Source snapshot changed. Reload the latest record before confirming.",
  },
  REVIEW_SOURCE_CHANGED: {
    "zh-CN": "源数据快照已变更，请刷新最新记录后重新确认。",
    "zh-HK": "源資料快照已變更，請重新整理最新紀錄後再確認。",
    en: "Source record changed. Reload the latest snapshot before confirming.",
  },
  REVIEW_EXPIRED: {
    "zh-CN": "该预审记录已过期，请重新发起预审。",
    "zh-HK": "該預審紀錄已過期，請重新發起預審。",
    en: "This review has expired. Start a new review.",
  },
  MODEL_BUDGET_EXHAUSTED: {
    "zh-CN": "当前租户请求额度已达上限，请稍后再试。",
    "zh-HK": "目前租戶請求額度已達上限，請稍後再試。",
    en: "Tenant request budget reached. Please try again later.",
  },
  RATE_LIMITED: {
    "zh-CN": "当前租户请求额度已达上限，请稍后再试。",
    "zh-HK": "目前租戶請求額度已達上限，請稍後再試。",
    en: "Too many requests. Please try again shortly.",
  },
  STORAGE_UNAVAILABLE: {
    "zh-CN": "服务繁忙或上游连接暂不可用，请稍后重试。",
    "zh-HK": "服務繁忙或上游連線暫時無法使用，請稍後重試。",
    en: "Storage service is temporarily unavailable. Please try again.",
  },
  DIRECTORY_UNAVAILABLE: {
    "zh-CN": "服务繁忙或上游连接暂不可用，请稍后重试。",
    "zh-HK": "服務繁忙或上游連線暫時無法使用，請稍後重試。",
    en: "Directory service is temporarily unavailable. Please try again.",
  },
  ASSURANCE_OVERLOADED: {
    "zh-CN": "服务繁忙或上游连接暂不可用，请稍后重试。",
    "zh-HK": "服務繁忙或上游連線暫時無法使用，請稍後重試。",
    en: "Assurance service is busy. Please try again shortly.",
  },
  AVATAR_BUSY: {
    "zh-CN": "服务繁忙或上游连接暂不可用，请稍后重试。",
    "zh-HK": "服務繁忙或上游連線暫時無法使用，請稍後重試。",
    en: "Avatar service is busy. Please try again shortly.",
  },
  UPSTREAM_UNAVAILABLE: {
    "zh-CN": "服务繁忙或上游连接暂不可用，请稍后重试。",
    "zh-HK": "服務繁忙或上游連線暫時無法使用，請稍後重試。",
    en: "Upstream service is temporarily unavailable. Please try again.",
  },
  VALIDATION_ERROR: {
    "zh-CN": "请检查表单输入格式后重试。",
    "zh-HK": "請檢查表單輸入格式後重試。",
    en: "Please check your input format and try again.",
  },
  CONFLICT: {
    "zh-CN": "数据状态已发生变更，请刷新后核对再试。",
    "zh-HK": "資料狀態已發生變更，請重新整理核對後再試。",
    en: "Record state changed. Reload and verify before trying again.",
  },
  HTTP_401: {
    "zh-CN": "登录状态已失效，请重新登录。",
    "zh-HK": "登入狀態已失效，請重新登入。",
    en: "Your session has expired. Please sign in again.",
  },
  HTTP_403: {
    "zh-CN": "当前账号无权执行此操作。",
    "zh-HK": "目前帳號無權執行此操作。",
    en: "Your account does not have permission for this action.",
  },
  HTTP_404: {
    "zh-CN": "当前账号无法访问这条记录。",
    "zh-HK": "目前帳號無法存取這筆紀錄。",
    en: "This record is unavailable for your account.",
  },
  HTTP_409: {
    "zh-CN": "数据状态已发生变更，请刷新后核对再试。",
    "zh-HK": "資料狀態已發生變更，請重新整理核對後再試。",
    en: "Record state changed. Reload and verify before trying again.",
  },
  HTTP_422: {
    "zh-CN": "请检查表单输入格式后重试。",
    "zh-HK": "請檢查表單輸入格式後重試。",
    en: "Please check your input format and try again.",
  },
  HTTP_429: {
    "zh-CN": "请求过于频繁，请稍后重试。",
    "zh-HK": "請求過於頻繁，請稍後重試。",
    en: "Too many requests. Please wait and try again.",
  },
  HTTP_503: {
    "zh-CN": "服务暂不可用，请稍后重试。",
    "zh-HK": "服務暫時無法使用，請稍後重試。",
    en: "Service temporarily unavailable. Please try again.",
  },
  DEFAULT_ERROR: {
    "zh-CN": "请求未能完成，请稍后重试。",
    "zh-HK": "請求未能完成，請稍後重試。",
    en: "Request could not be completed. Please try again.",
  },
};

export const RAW_DETAIL_TRANSLATIONS_I18N: Readonly<
  Record<string, TrilingualText>
> = {
  "AIOS access is suspended": {
    "zh-CN": "当前账号访问已被停用。",
    "zh-HK": "目前帳號存取已被停用。",
    en: "Access for this account is suspended.",
  },
  "Tenant planner budget exhausted": {
    "zh-CN": "当前租户规划请求额度已达上限，请稍后重试。",
    "zh-HK": "目前租戶規劃請求額度已達上限，請稍後重試。",
    en: "Tenant planner request budget exhausted. Please try again later.",
  },
  "Assignment changed. Reload and review before saving.": {
    "zh-CN": "该模块授权已在其他会话中变更，已刷新最新快照，请核对后重新保存。",
    "zh-HK": "該模組授權已於其他工作階段變更，已重新整理最新快照，請核對後再儲存。",
    en: "Module assignment changed elsewhere. Reloaded latest snapshot — review and save again.",
  },
  "Profile version changed": {
    "zh-CN": "资料版本已更新，请刷新最新内容后再保存。",
    "zh-HK": "資料版本已更新，請重新整理最新內容後再儲存。",
    en: "Profile version changed. Refresh before saving.",
  },
  "At least one attendee is busy": {
    "zh-CN": "所选时间段内至少有一位参会人时间冲突，请调整时间。",
    "zh-HK": "所選時段內至少有一位與會者時間衝突，請調整時間。",
    en: "At least one attendee has a schedule conflict. Pick another slot.",
  },
  "Meeting has changed": {
    "zh-CN": "会议信息已被更新，请刷新后重试。",
    "zh-HK": "會議資訊已更新，請重新整理後重試。",
    en: "Meeting details changed elsewhere. Refresh and try again.",
  },
  "An administrator must manage another employee": {
    "zh-CN": "管理员不可修改本人模块授权。",
    "zh-HK": "管理員不可修改本人模組授權。",
    en: "Administrators cannot modify their own module access.",
  },
  "Preview digest changed": {
    "zh-CN": "提案摘要已变更，请核对最新差异后再确认。",
    "zh-HK": "提案摘要已變更，請核對最新差異後再確認。",
    en: "Proposal digest changed. Review the updated diff before confirming.",
  },
};

// All 11 Demo Personas — Complete Trilingual Profiles
export const PERSONA_LOCALIZATIONS: Readonly<
  Record<DemoPersonaId, Record<Locale, LocalizedPersonaInfo>>
> = {
  operator: {
    "zh-CN": {
      displayName: "林明哲",
      label: "接单 / 运单经办",
      summary: "HK01 订单进件、运单改期提案与预审发起（不可自批）",
      department: "HK01 仓储运营部",
    },
    "zh-HK": {
      displayName: "林明哲",
      label: "接單 / 運單經辦",
      summary: "HK01 訂單進件、運單改期提案與預審發起（不可自批）",
      department: "HK01 倉儲營運部",
    },
    en: {
      displayName: "Mingzhe Lin",
      label: "Orders & Dispatch Operator",
      summary: "HK01 order intake, shipment reschedule proposals & prechecks (no self-approval)",
      department: "HK01 Warehouse Ops",
    },
  },
  manager: {
    "zh-CN": {
      displayName: "陈志远",
      label: "独立主管审批",
      summary: "HK01 审批队列、采购预审轨与异常复核",
      department: "HK01 仓储运营部",
    },
    "zh-HK": {
      displayName: "陳志遠",
      label: "獨立主管審批",
      summary: "HK01 審批佇列、採購預審軌與異常覆核",
      department: "HK01 倉儲營運部",
    },
    en: {
      displayName: "Zhiyuan Chen",
      label: "Independent Manager",
      summary: "HK01 approvals queue, procurement review track & exception review",
      department: "HK01 Warehouse Ops",
    },
  },
  finance: {
    "zh-CN": {
      displayName: "周婉清",
      label: "财务审阅",
      summary: "HK01 发票核对（INV-100）与财务预审轨（含银行字段）",
      department: "财务核算部",
    },
    "zh-HK": {
      displayName: "周婉清",
      label: "財務審閱",
      summary: "HK01 發票核對（INV-100）與財務預審軌（含銀行欄位）",
      department: "財務核算部",
    },
    en: {
      displayName: "Wanqing Zhou",
      label: "Finance Reviewer",
      summary: "HK01 invoice checks (INV-100) & finance track (including banking fields)",
      department: "Finance & Accounting",
    },
  },
  "access-admin": {
    "zh-CN": {
      displayName: "许嘉豪",
      label: "全仓库权限管理员",
      summary: "管理员工模块授权与仓库范围（HK01 / HK02）",
      department: "身份与权限治理部",
    },
    "zh-HK": {
      displayName: "許嘉豪",
      label: "全倉庫權限管理員",
      summary: "管理員工模組授權與倉庫範圍（HK01 / HK02）",
      department: "身份與權限治理部",
    },
    en: {
      displayName: "Jiahao Xu",
      label: "Access Governance Admin",
      summary: "Manages employee module grants & warehouse scopes (HK01 / HK02)",
      department: "Identity & Access",
    },
  },
  admin: {
    "zh-CN": {
      displayName: "郑启帆",
      label: "运维管理员",
      summary: "ERP 写入闸门、停权控制、Worker 步进与审计检查点",
      department: "平台运维部",
    },
    "zh-HK": {
      displayName: "鄭啟帆",
      label: "維運管理員",
      summary: "ERP 寫入閘門、停權控制、Worker 步進與稽核檢查點",
      department: "平台維運部",
    },
    en: {
      displayName: "Qifan Zheng",
      label: "Operations Admin",
      summary: "ERP write circuit breaker, suspension, worker tick & audit checkpoints",
      department: "Platform Operations",
    },
  },
  quality: {
    "zh-CN": {
      displayName: "梁思琪",
      label: "来料质检复核",
      summary: "HK01 质检预审案件（QA-200）与质量轨裁决",
      department: "品质保障部",
    },
    "zh-HK": {
      displayName: "梁思琪",
      label: "來料質檢覆核",
      summary: "HK01 質檢預審案件（QA-200）與品質軌裁決",
      department: "品質保證部",
    },
    en: {
      displayName: "Siqi Liang",
      label: "Incoming Quality Lead",
      summary: "HK01 quality inspection cases (QA-200) & quality track verdicts",
      department: "Quality Assurance",
    },
  },
  legal: {
    "zh-CN": {
      displayName: "何咏琳",
      label: "法务合同审阅",
      summary: "HK01 合同预审案件（CT-300）与法务轨裁决",
      department: "法务合规部",
    },
    "zh-HK": {
      displayName: "何詠琳",
      label: "法務合約審閱",
      summary: "HK01 合約預審案件（CT-300）與法務軌裁決",
      department: "法務合規部",
    },
    en: {
      displayName: "Winglam Ho",
      label: "Legal Counsel",
      summary: "HK01 contract review cases (CT-300) & legal track verdicts",
      department: "Legal & Compliance",
    },
  },
  executive: {
    "zh-CN": {
      displayName: "顾承泽",
      label: "跨仓经营视图",
      summary: "HK01 / HK02 经营汇总只读视图（默认无审批模块授权）",
      department: "经营管理层",
    },
    "zh-HK": {
      displayName: "顧承澤",
      label: "跨倉營運檢視",
      summary: "HK01 / HK02 營運摘要唯讀檢視（預設無審批模組授權）",
      department: "營運管理層",
    },
    en: {
      displayName: "Chengze Gu",
      label: "Executive Insights",
      summary: "Read-only HK01 / HK02 operational summary (no approval grants by default)",
      department: "Executive Leadership",
    },
  },
  viewer: {
    "zh-CN": {
      displayName: "苏文静",
      label: "只读运单查询",
      summary: "HK01 只读运单查询，无任何提交或改期权限",
      department: "客户支持部",
    },
    "zh-HK": {
      displayName: "蘇文靜",
      label: "唯讀運單查詢",
      summary: "HK01 唯讀運單查詢，無任何提交或改期權限",
      department: "客戶支援部",
    },
    en: {
      displayName: "Wenjing Su",
      label: "Read-Only Viewer",
      summary: "Read-only HK01 shipment queries with no write or proposal permissions",
      department: "Customer Support",
    },
  },
  "other-manager": {
    "zh-CN": {
      displayName: "方峻熙",
      label: "HK02 跨仓隔离主管",
      summary: "同租户 HK02 独立主管，无法访问 HK01 单据与运单",
      department: "HK02 仓储运营部",
    },
    "zh-HK": {
      displayName: "方峻熙",
      label: "HK02 跨倉隔離主管",
      summary: "同租戶 HK02 獨立主管，無法存取 HK01 單據與運單",
      department: "HK02 倉儲營運部",
    },
    en: {
      displayName: "Junxi Fang",
      label: "HK02 Isolated Manager",
      summary: "Same-tenant HK02 manager isolated from HK01 orders and shipments",
      department: "HK02 Warehouse Ops",
    },
  },
  "island-manager": {
    "zh-CN": {
      displayName: "陆景行",
      label: "Island 跨租户隔离",
      summary: "第二租户 island（HK01），验证跨租户完全隔离",
      department: "Island 运营部",
    },
    "zh-HK": {
      displayName: "陸景行",
      label: "Island 跨租戶隔離",
      summary: "第二租戶 island（HK01），驗證跨租戶完全隔離",
      department: "Island 營運部",
    },
    en: {
      displayName: "Jingxing Lu",
      label: "Island Tenant Manager",
      summary: "Secondary tenant island (HK01) for full cross-tenant RLS isolation",
      department: "Island Operations",
    },
  },
};

export function resolveLocalizedPersona(
  subject: string,
  locale: Locale,
  fallback?: Partial<DemoPersonaMeta>,
): LocalizedPersonaInfo {
  const known = PERSONA_LOCALIZATIONS[subject as DemoPersonaId];
  if (known) {
    return known[locale];
  }
  return {
    displayName: fallback?.display_name || subject,
    label: fallback?.label || subject,
    summary: fallback?.summary || "",
    department: fallback?.department || "",
  };
}
