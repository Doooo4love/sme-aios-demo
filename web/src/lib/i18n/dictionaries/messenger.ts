import type { TrilingualText } from "@/lib/i18n/types";

export const MESSENGER_DICTIONARY = {
  // === LoginView ===
  "login.initializing": {
    "zh-CN": "正在初始化登录视图…",
    "zh-HK": "正在初始化登入檢視…",
    en: "Loading sign-in…",
  },
  "login.heading": {
    "zh-CN": "登录企业工作台",
    "zh-HK": "登入企業工作台",
    en: "Sign in to Workspace",
  },
  "login.subtitle": {
    "zh-CN": "使用企业账号进入个人业务助手与协作空间",
    "zh-HK": "使用企業帳號進入個人業務助手與協作空間",
    en: "Access your Personal Agent and team workspace",
  },
  "login.accountLabel": {
    "zh-CN": "企业账号",
    "zh-HK": "企業帳號",
    en: "Corporate Account",
  },
  "login.accountPlaceholder": {
    "zh-CN": "例如 operator@harbour.demo 或 manager",
    "zh-HK": "例如 operator@harbour.demo 或 manager",
    en: "e.g. operator@harbour.demo or manager",
  },
  "login.passwordLabel": {
    "zh-CN": "登录密码",
    "zh-HK": "登入密碼",
    en: "Password",
  },
  "login.passwordPlaceholder": {
    "zh-CN": "请输入登录密码",
    "zh-HK": "請輸入登入密碼",
    en: "Enter your password",
  },
  "login.showPasswordAria": {
    "zh-CN": "显示密码",
    "zh-HK": "顯示密碼",
    en: "Show password",
  },
  "login.hidePasswordAria": {
    "zh-CN": "隐藏密码",
    "zh-HK": "隱藏密碼",
    en: "Hide password",
  },
  "login.submitIdle": {
    "zh-CN": "登录工作台",
    "zh-HK": "登入工作台",
    en: "Sign In",
  },
  "login.submitLoading": {
    "zh-CN": "正在验证身份…",
    "zh-HK": "正在驗證身份…",
    en: "Verifying credentials…",
  },
  "login.orDivider": {
    "zh-CN": "或",
    "zh-HK": "或",
    en: "or",
  },
  "login.oidcButton": {
    "zh-CN": "使用企业单点登录 (OIDC)",
    "zh-HK": "使用企業單一登入 (OIDC)",
    en: "Continue with Enterprise SSO (OIDC)",
  },
  "login.demoHelperToggle": {
    "zh-CN": "测试演示账号快速填入",
    "zh-HK": "測試示範帳號快速填入",
    en: "Demo Accounts Quick Sign-In",
  },
  "login.demoRoleCount": {
    "zh-CN": "{count} 角色",
    "zh-HK": "{count} 角色",
    en: "{count} roles",
  },
  "login.unconfigured": {
    "zh-CN": "当前环境尚未配置企业 OIDC 或受控本地演示登录。",
    "zh-HK": "目前環境尚未設定企業 OIDC 或受控本地示範登入。",
    en: "Neither Enterprise OIDC nor local demo login is configured in this environment.",
  },
  "login.recheckConfig": {
    "zh-CN": "重新检查登录配置",
    "zh-HK": "重新檢查登入設定",
    en: "Re-check Sign-In Config",
  },
  "login.footer": {
    "zh-CN": "企业账号登录 · 会话受仓库权限保护",
    "zh-HK": "企業帳號登入 · 工作階段受倉庫權限保護",
    en: "Corporate sign-in · Warehouse-scoped session",
  },
  "login.footerSso": {
    "zh-CN": "企业单点登录 · 会话受仓库权限保护",
    "zh-HK": "企業單一登入 · 工作階段受倉庫權限保護",
    en: "Enterprise SSO · Warehouse-scoped session",
  },
  "login.errorMissingFields": {
    "zh-CN": "请输入企业账号与登录密码。",
    "zh-HK": "請輸入企業帳號與登入密碼。",
    en: "Please enter both your corporate account and password.",
  },
  "login.errorSessionVerify": {
    "zh-CN": "会话校验未通过，请确认后端服务已启动并重试。",
    "zh-HK": "工作階段校驗未通過，請確認後端服務已啟動並重試。",
    en: "Session verification failed. Ensure the API server is running and retry.",
  },
  "login.errorGeneric": {
    "zh-CN": "登录失败，请稍后重试。",
    "zh-HK": "登入失敗，請稍後重試。",
    en: "Sign in failed. Please try again.",
  },

  // === ArchitecturalRelayCanvas (3D Login Showcase — 1:1 Aligned Glossary) ===
  "login.canvas.headerTitle": {
    "zh-CN": "企业安全边界与核验架构",
    "zh-HK": "企業安全邊界與核驗架構",
    en: "Security Boundary & Receipt Architecture",
  },
  "login.canvas.headerBadge": {
    "zh-CN": "四层隔离 · 实时校验",
    "zh-HK": "四層隔離 · 即時校驗",
    en: "4-Layer Isolation · Live Checks",
  },
  "login.canvas.tablistAria": {
    "zh-CN": "AIOS 安全与执行架构层级",
    "zh-HK": "AIOS 安全與執行架構層級",
    en: "AIOS security and execution architecture layers",
  },
  "login.canvas.stratum0.tab": {
    "zh-CN": "租户隔离",
    "zh-HK": "租戶隔離",
    en: "Tenant Isolation",
  },
  "login.canvas.stratum0.title": {
    "zh-CN": "租户与仓库隔离层",
    "zh-HK": "租戶與倉庫隔離層",
    en: "Tenant & Warehouse Isolation",
  },
  "login.canvas.stratum0.caption": {
    "zh-CN": "RLS · HK01 / HK02",
    "zh-HK": "RLS · HK01 / HK02",
    en: "RLS · HK01 / HK02",
  },
  "login.canvas.stratum0.detail": {
    "zh-CN": "租户级行级隔离与仓库边界在每一次鉴权和查询中强制生效，跨租户与跨仓记录统一不可见。",
    "zh-HK": "租戶級資料列隔離與倉庫邊界於每次鑑權及查詢強制生效，跨租戶與跨倉紀錄一律不可見。",
    en: "Row-level tenant isolation and warehouse boundaries are enforced on every query; out-of-scope records remain invisible.",
  },
  "login.canvas.stratum1.tab": {
    "zh-CN": "策略闸门",
    "zh-HK": "策略閘門",
    en: "Policy Gate",
  },
  "login.canvas.stratum1.title": {
    "zh-CN": "策略与模块准入闸门",
    "zh-HK": "策略與模組准入閘門",
    en: "Policy & Module Access Gate",
  },
  "login.canvas.stratum1.caption": {
    "zh-CN": "ACL ∩ OPA · 摘要锁定",
    "zh-HK": "ACL ∩ OPA · 摘要鎖定",
    en: "ACL ∩ OPA · Digest Lock",
  },
  "login.canvas.stratum1.detail": {
    "zh-CN": "身份授权、模块动态配置与摘要锁定三重交集校验，所有写入前均需独立主管复核确认。",
    "zh-HK": "身份授權、模組動態設定與摘要鎖定三重交集校驗，所有寫入前均須獨立主管覆核確認。",
    en: "Identity grants, dynamic module rules, and digest locks intersect on every write; independent manager sign-off is required.",
  },
  "login.canvas.stratum2.tab": {
    "zh-CN": "个人业务助手",
    "zh-HK": "個人業務助手",
    en: "Personal Agent",
  },
  "login.canvas.stratum2.title": {
    "zh-CN": "个人业务助手工作台",
    "zh-HK": "個人業務助手工作台",
    en: "Personal Agent Workbench",
  },
  "login.canvas.stratum2.caption": {
    "zh-CN": "受控工具 · 最小权限执行",
    "zh-HK": "受控工具 · 最小權限執行",
    en: "Typed Tools · Scoped Execution",
  },
  "login.canvas.stratum2.detail": {
    "zh-CN": "受类型化工具边界约束的个人工作台，仅输出可核验业务视图与正式提案。",
    "zh-HK": "受型別化工具邊界約束的個人工作台，僅輸出可核驗業務檢視與正式提案。",
    en: "Constrained to typed tool contracts, producing only verifiable business views and formal write proposals.",
  },
  "login.canvas.stratum3.tab": {
    "zh-CN": "ERP 核验",
    "zh-HK": "ERP 核驗",
    en: "ERP Ledger",
  },
  "login.canvas.stratum3.title": {
    "zh-CN": "已核验 ERP 账本",
    "zh-HK": "已核驗 ERP 帳本",
    en: "Verified ERP Ledger",
  },
  "login.canvas.stratum3.caption": {
    "zh-CN": "幂等派发 · 回执核验",
    "zh-HK": "冪等派發 · 回執核驗",
    en: "Idempotent Dispatch · Readback",
  },
  "login.canvas.stratum3.detail": {
    "zh-CN": "幂等队列派发与 ERP 只读回查核验，每条已核验单据均绑定不可伪造的摘要回执。",
    "zh-HK": "冪等佇列派發與 ERP 唯讀回查核驗，每筆已核驗單據均綁定不可偽造的摘要回執。",
    en: "Idempotent queue dispatch paired with read-only ERP verification binds every posted record to a tamper-evident receipt.",
  },
  "login.canvas.slab.gateLeft.title": {
    "zh-CN": "ACL 权限边界",
    "zh-HK": "ACL 權限邊界",
    en: "ACL Boundary",
  },
  "login.canvas.slab.gateLeft.short": {
    "zh-CN": "ACL 边界",
    "zh-HK": "ACL 邊界",
    en: "ACL Gate",
  },
  "login.canvas.slab.gateLeft.sub": {
    "zh-CN": "角色 · 授权 · 仓库",
    "zh-HK": "角色 · 授權 · 倉庫",
    en: "Role · Grants · Warehouse",
  },
  "login.canvas.slab.gateRight.title": {
    "zh-CN": "策略与摘要锁",
    "zh-HK": "策略與摘要鎖",
    en: "Policy & Digest Lock",
  },
  "login.canvas.slab.gateRight.short": {
    "zh-CN": "策略闸门",
    "zh-HK": "策略閘門",
    en: "Policy Gate",
  },
  "login.canvas.slab.gateRight.sub": {
    "zh-CN": "策略闸门 · 摘要锁定",
    "zh-HK": "策略閘門 · 摘要鎖定",
    en: "OPA Gate · Digest Lock",
  },
  "login.canvas.slab.workbench.title": {
    "zh-CN": "个人业务助手",
    "zh-HK": "個人業務助手",
    en: "Personal Agent",
  },
  "login.canvas.slab.workbench.short": {
    "zh-CN": "个人业务助手",
    "zh-HK": "個人業務助手",
    en: "Personal Agent",
  },
  "login.canvas.slab.workbench.sub": {
    "zh-CN": "受控工具 · 实时鉴权",
    "zh-HK": "受控工具 · 即時鑑權",
    en: "Typed Tools · Live Auth",
  },
  "login.canvas.slab.ledger.title": {
    "zh-CN": "已核验 ERP 账本",
    "zh-HK": "已核驗 ERP 帳本",
    en: "Verified ERP Ledger",
  },
  "login.canvas.slab.ledger.short": {
    "zh-CN": "ERP 核验账本",
    "zh-HK": "ERP 核驗帳本",
    en: "ERP Ledger",
  },
  "login.canvas.slab.ledger.sub": {
    "zh-CN": "幂等派发 · 回执核验",
    "zh-HK": "冪等派發 · 回執核驗",
    en: "Idempotent · Receipt Check",
  },
  "login.canvas.conduit.identity": {
    "zh-CN": "身份校验",
    "zh-HK": "身份校驗",
    en: "Identity",
  },
  "login.canvas.conduit.siteBoundary": {
    "zh-CN": "仓库边界",
    "zh-HK": "倉庫邊界",
    en: "Warehouse Scope",
  },
  "login.canvas.conduit.grantIntersection": {
    "zh-CN": "授权交集",
    "zh-HK": "授權交集",
    en: "Grant ∩ Module",
  },
  "login.canvas.conduit.digestPreview": {
    "zh-CN": "变更预览",
    "zh-HK": "變更預覽",
    en: "Plan Preview",
  },
  "login.canvas.conduit.idempotentQueue": {
    "zh-CN": "幂等队列",
    "zh-HK": "冪等佇列",
    en: "Idempotent Queue",
  },
  "login.canvas.conduit.receiptReadback": {
    "zh-CN": "回执核查",
    "zh-HK": "回執核查",
    en: "Receipt Readback",
  },

  // === InboxShell (Messenger Sidebar & Dock) ===
  "inbox.title": {
    "zh-CN": "消息",
    "zh-HK": "訊息",
    en: "Messages",
  },
  "inbox.searchPlaceholder": {
    "zh-CN": "搜索会话、同事姓名或部门…",
    "zh-HK": "搜尋對話、同事姓名或部門…",
    en: "Search chats, colleagues, or teams…",
  },
  "inbox.contactsButton": {
    "zh-CN": "企业通讯录",
    "zh-HK": "企業聯絡人",
    en: "Directory",
  },
  "inbox.newRoomButton": {
    "zh-CN": "新建协作会话",
    "zh-HK": "新增協作對話",
    en: "New Chat",
  },
  "inbox.pinnedAgentLabel": {
    "zh-CN": "置顶 · 个人业务助手",
    "zh-HK": "釘選 · 個人業務助手",
    en: "Pinned · Personal Agent",
  },
  "inbox.pinnedAgentFallbackSnippet": {
    "zh-CN": "随时查询运单、发票、生成提案或预约 Zoom 会议",
    "zh-HK": "隨時查詢運單、發票、產生提案或預約 Zoom 會議",
    en: "Check shipments, invoices, draft proposals, or book Zoom calls",
  },
  "inbox.teamThreadsHeader": {
    "zh-CN": "团队与私聊会话",
    "zh-HK": "團隊與私訊對話",
    en: "Direct & Team Chats",
  },
  "inbox.colleagueSearchHeader": {
    "zh-CN": "企业同事（当前租户）",
    "zh-HK": "企業同事（目前租戶）",
    en: "Colleagues (Current Tenant)",
  },
  "inbox.chatDisabledTitle": {
    "zh-CN": "当前账号未启用团队会话",
    "zh-HK": "目前帳號未啟用團隊對話",
    en: "Team Chat Disabled",
  },
  "inbox.chatDisabledHint": {
    "zh-CN": "仍可使用个人业务助手与授权工作台模块",
    "zh-HK": "仍可使用個人業務助手與授權工作台模組",
    en: "Your Personal Agent and authorized workbench modules remain available",
  },
  "inbox.emptyRooms": {
    "zh-CN": "暂无协作会话，可从通讯录发起私聊或新建群组",
    "zh-HK": "暫無協作對話，可從聯絡人發起私訊或新增群組",
    en: "No chats yet. Start a direct chat from the directory or create a room.",
  },
  "inbox.loadMoreRooms": {
    "zh-CN": "加载更多会话",
    "zh-HK": "載入更多對話",
    en: "Load more chats",
  },
  "inbox.enterWorkbench": {
    "zh-CN": "进入工作台",
    "zh-HK": "進入工作台",
    en: "Workbench",
  },
  "inbox.openCalendar": {
    "zh-CN": "日历",
    "zh-HK": "日曆",
    en: "Calendar",
  },
  "inbox.directChatPrefix": {
    "zh-CN": "私聊 · ",
    "zh-HK": "私訊 · ",
    en: "DM · ",
  },
  "inbox.createRoom.title": {
    "zh-CN": "新建企业协作会话",
    "zh-HK": "新增企業協作對話",
    en: "Create Team Chat",
  },
  "inbox.createRoom.subtitle": {
    "zh-CN": "仅同租户成员受邀后可见，支持实时消息与一键排会",
    "zh-HK": "僅同租戶成員受邀後可見，支援即時訊息與一鍵排程會議",
    en: "Visible only to invited same-tenant members with built-in meeting scheduling",
  },
  "inbox.createRoom.nameLabel": {
    "zh-CN": "会话名称",
    "zh-HK": "對話名稱",
    en: "Room Title",
  },
  "inbox.createRoom.namePlaceholder": {
    "zh-CN": "例如：HK01 今日排期协调",
    "zh-HK": "例如：HK01 今日排期協調",
    en: "e.g. HK01 Dispatch Sync",
  },
  "inbox.createRoom.submit": {
    "zh-CN": "创建会话",
    "zh-HK": "建立對話",
    en: "Create Room",
  },

  // === ContactsDirectoryModal ===
  "contacts.title": {
    "zh-CN": "企业通讯录",
    "zh-HK": "企業聯絡人",
    en: "Company Directory",
  },
  "contacts.subtitle": {
    "zh-CN": "按租户行级边界隔离，仅展示同租户在职同事",
    "zh-HK": "按租戶資料列邊界隔離，僅顯示同租戶在職同事",
    en: "Tenant-isolated directory showing colleagues in your organization",
  },
  "contacts.searchPlaceholder": {
    "zh-CN": "按姓名、部门、岗位或账号搜索…",
    "zh-HK": "按姓名、部門、職位或帳號搜尋…",
    en: "Filter by name, team, role, or account…",
  },
  "contacts.allDepartments": {
    "zh-CN": "全部部门",
    "zh-HK": "全部部門",
    en: "All Teams",
  },
  "contacts.startChat": {
    "zh-CN": "发起私聊",
    "zh-HK": "發起私訊",
    en: "Message",
  },
  "contacts.openChat": {
    "zh-CN": "继续私聊",
    "zh-HK": "繼續私訊",
    en: "Open Chat",
  },
  "contacts.empty": {
    "zh-CN": "未找到匹配的同租户同事",
    "zh-HK": "找不到符合條件的同租戶同事",
    en: "No matching colleagues found in this tenant",
  },

  // === AssistantWorkspace ===
  "assistant.greetingTitle": {
    "zh-CN": "你好，{name}",
    "zh-HK": "你好，{name}",
    en: "Hi, {name}",
  },
  "assistant.greetingSubtitle": {
    "zh-CN": "我已绑定你的企业身份与授权仓库，可以直接查询业务数据、准备变更提案或预约会议。",
    "zh-HK": "我已綁定你的企業身份與授權倉庫，可直接查詢業務資料、準備變更提案或預約會議。",
    en: "Bound to your corporate identity and warehouse scope — query live data, draft proposals, or book meetings.",
  },
  "assistant.composerPlaceholder": {
    "zh-CN": "输入业务指令，或例如「帮我约明天下午 3 点和陈志远开 30 分钟 Zoom 会」…",
    "zh-HK": "輸入業務指令，或例如「幫我約明天下午 3 點和陳志遠開 30 分鐘 Zoom 會」…",
    en: "Ask anything — check shipments, draft proposals, or book a Zoom call…",
  },
  "assistant.sendAria": {
    "zh-CN": "发送指令",
    "zh-HK": "傳送指令",
    en: "Send message",
  },
  "assistant.addContext": {
    "zh-CN": "添加上下文与工具",
    "zh-HK": "加入上下文與工具",
    en: "Add Context & Tools",
  },
  "assistant.action.brief": {
    "zh-CN": "今日简报",
    "zh-HK": "今日簡報",
    en: "Daily Brief",
  },
  "assistant.action.history": {
    "zh-CN": "历史会话",
    "zh-HK": "歷史紀錄",
    en: "History",
  },
  "assistant.action.structuredTool": {
    "zh-CN": "结构化业务工具",
    "zh-HK": "結構化業務工具",
    en: "Structured Tool",
  },
  "assistant.action.newOrder": {
    "zh-CN": "新订单进件",
    "zh-HK": "新訂單進件",
    en: "New Order Intake",
  },
  "assistant.action.bookZoom": {
    "zh-CN": "预约 Zoom 会议",
    "zh-HK": "預約 Zoom 會議",
    en: "Book Zoom Meeting",
  },
  "assistant.action.openWorkbench": {
    "zh-CN": "打开工作台",
    "zh-HK": "開啟工作台",
    en: "Workbench",
  },
  "assistant.history.title": {
    "zh-CN": "个人业务助手历史记录",
    "zh-HK": "個人業務助手歷史紀錄",
    en: "Personal Agent History",
  },
  "assistant.history.empty": {
    "zh-CN": "暂无历史交互记录",
    "zh-HK": "暫無歷史互動紀錄",
    en: "No past turns yet",
  },
  "assistant.brief.title": {
    "zh-CN": "运营简报",
    "zh-HK": "營運簡報",
    en: "Operations Brief",
  },
  "assistant.brief.meetings": {
    "zh-CN": "日程会议",
    "zh-HK": "行程會議",
    en: "Meetings",
  },
  "assistant.brief.pendingApprovals": {
    "zh-CN": "待我审批",
    "zh-HK": "待我審批",
    en: "Pending Approvals",
  },
  "assistant.brief.submittedStates": {
    "zh-CN": "已提交单据分布",
    "zh-HK": "已提交單據分佈",
    en: "Submitted Proposals",
  },

  // === TurnResultCard ===
  "turnCard.resultBadge": {
    "zh-CN": "实时只读查询",
    "zh-HK": "即時唯讀查詢",
    en: "Live Read Query",
  },
  "turnCard.proposalBadge": {
    "zh-CN": "正式变更提案",
    "zh-HK": "正式變更提案",
    en: "Write Proposal",
  },
  "turnCard.approvalPreviewBadge": {
    "zh-CN": "审批预览（未写入）",
    "zh-HK": "審批預覽（未寫入）",
    en: "Approval Preview",
  },
  "turnCard.clarificationBadge": {
    "zh-CN": "需补充信息",
    "zh-HK": "須補充資訊",
    en: "Clarification",
  },
  "turnCard.inspectInDrawer": {
    "zh-CN": "在侧边面板核对",
    "zh-HK": "於側邊面板核對",
    en: "Inspect in Drawer",
  },
  "turnCard.openDetailPage": {
    "zh-CN": "打开单据详情页",
    "zh-HK": "開啟單據詳情頁",
    en: "Open Full Page",
  },

  // === ZoomBookingCard ===
  "zoom.previewTitle": {
    "zh-CN": "会议预约草案 · 请确认后创建",
    "zh-HK": "會議預約草案 · 請確認後建立",
    en: "Meeting Draft · Confirm to Book",
  },
  "zoom.confirmedTitle": {
    "zh-CN": "会议已预约成功",
    "zh-HK": "會議已預約成功",
    en: "Meeting Booked",
  },
  "zoom.meetingTitleLabel": {
    "zh-CN": "会议主题",
    "zh-HK": "會議主題",
    en: "Title",
  },
  "zoom.timeLabel": {
    "zh-CN": "会议时间",
    "zh-HK": "會議時間",
    en: "Time",
  },
  "zoom.attendeesLabel": {
    "zh-CN": "参会同事",
    "zh-HK": "與會同事",
    en: "Attendees",
  },
  "zoom.calendarSyncLabel": {
    "zh-CN": "同步外部日历",
    "zh-HK": "同步外部日曆",
    en: "External Calendars",
  },
  "zoom.confirmButton": {
    "zh-CN": "确认预约并生成 Zoom 链接",
    "zh-HK": "確認預約並產生 Zoom 連結",
    en: "Confirm & Create Zoom Link",
  },
  "zoom.joinMeeting": {
    "zh-CN": "加入 Zoom 会议",
    "zh-HK": "加入 Zoom 會議",
    en: "Join Zoom Meeting",
  },
  "zoom.downloadIcs": {
    "zh-CN": "下载 .ics 日历文件",
    "zh-HK": "下載 .ics 日曆檔案",
    en: "Download .ics",
  },
  "zoom.openCalendar": {
    "zh-CN": "查看企业日历",
    "zh-HK": "檢視企業日曆",
    en: "View Calendar",
  },

  // === ChatRoomWorkspace, MeetingDraftModal, RoomMembersPanel ===
  "chat.composerPlaceholder": {
    "zh-CN": "输入消息，Enter 发送，Shift+Enter 换行…",
    "zh-HK": "輸入訊息，Enter 傳送，Shift+Enter 換行…",
    en: "Write a message (Enter to send, Shift+Enter for newline)…",
  },
  "chat.membersButton": {
    "zh-CN": "成员",
    "zh-HK": "成員",
    en: "Members",
  },
  "chat.scheduleMeeting": {
    "zh-CN": "预约会议",
    "zh-HK": "預約會議",
    en: "Schedule",
  },
  "chat.emptyMessages": {
    "zh-CN": "会话已就绪，发送第一条消息开始协作。",
    "zh-HK": "對話已就緒，傳送第一則訊息開始協作。",
    en: "Chat ready. Send the first message to start collaborating.",
  },
  "chat.members.title": {
    "zh-CN": "会话成员管理",
    "zh-HK": "對話成員管理",
    en: "Room Members",
  },
  "chat.members.addPlaceholder": {
    "zh-CN": "输入同租户账号，如 manager",
    "zh-HK": "輸入同租戶帳號，如 manager",
    en: "Enter tenant account, e.g. manager",
  },
  "chat.members.addButton": {
    "zh-CN": "邀请加入",
    "zh-HK": "邀請加入",
    en: "Add Member",
  },
  "chat.members.removeButton": {
    "zh-CN": "移除",
    "zh-HK": "移除",
    en: "Remove",
  },
  "chat.members.ownerBadge": {
    "zh-CN": "创建者",
    "zh-HK": "建立者",
    en: "Owner",
  },
  "chat.meetingModal.title": {
    "zh-CN": "在会话中预约会议",
    "zh-HK": "於對話中預約會議",
    en: "Schedule Room Meeting",
  },

  // === CalendarWorkspace, McpCalendarConnectorsPanel, CalendarEventDrawer, CreateEventModal ===
  "calendar.title": {
    "zh-CN": "企业日历与会议",
    "zh-HK": "企業日曆與會議",
    en: "Calendar & Meetings",
  },
  "calendar.newEvent": {
    "zh-CN": "新建日程",
    "zh-HK": "新增行程",
    en: "New Event",
  },
  "calendar.exportIcs": {
    "zh-CN": "导出 .ics",
    "zh-HK": "匯出 .ics",
    en: "Export .ics",
  },
  "calendar.syncNow": {
    "zh-CN": "立即同步外部日历",
    "zh-HK": "立即同步外部日曆",
    en: "Sync Calendars",
  },
  "calendar.connectorsTitle": {
    "zh-CN": "MCP 会议与外部日历连接器",
    "zh-HK": "MCP 會議與外部日曆連接器",
    en: "MCP Meeting & Calendar Connectors",
  },
  "calendar.view.today": {
    "zh-CN": "今天",
    "zh-HK": "今天",
    en: "Today",
  },
  "calendar.view.week": {
    "zh-CN": "周视图",
    "zh-HK": "週檢視",
    en: "Week",
  },
  "calendar.view.agenda": {
    "zh-CN": "议程列表",
    "zh-HK": "議程清單",
    en: "Agenda",
  },
  "calendar.emptyEvents": {
    "zh-CN": "当前时间范围内暂无日程安排",
    "zh-HK": "目前時間範圍內暫無行程安排",
    en: "No events scheduled in this range",
  },
  "calendar.event.organizer": {
    "zh-CN": "组织者",
    "zh-HK": "組織者",
    en: "Organizer",
  },
  "calendar.event.attendees": {
    "zh-CN": "参会人",
    "zh-HK": "與會者",
    en: "Attendees",
  },
  "calendar.event.cancel": {
    "zh-CN": "取消会议",
    "zh-HK": "取消會議",
    en: "Cancel Event",
  },

  // === ProfileSettingsView ===
  "settings.userTitle": {
    "zh-CN": "个人资料设置",
    "zh-HK": "個人資料設定",
    en: "Profile Settings",
  },
  "settings.agentTitle": {
    "zh-CN": "个人业务助手资料",
    "zh-HK": "個人業務助手資料",
    en: "Personal Agent Profile",
  },
  "settings.displayNameLabel": {
    "zh-CN": "显示名称",
    "zh-HK": "顯示名稱",
    en: "Display Name",
  },
  "settings.avatarLabel": {
    "zh-CN": "头像",
    "zh-HK": "頭像",
    en: "Avatar",
  },
  "settings.uploadAvatar": {
    "zh-CN": "上传新头像",
    "zh-HK": "上傳新頭像",
    en: "Upload Avatar",
  },
  "settings.removeAvatar": {
    "zh-CN": "移除头像",
    "zh-HK": "移除頭像",
    en: "Remove Avatar",
  },
  "settings.saveChanges": {
    "zh-CN": "保存修改",
    "zh-HK": "儲存變更",
    en: "Save Changes",
  },
  "settings.savedSuccess": {
    "zh-CN": "资料已保存并同步生效。",
    "zh-HK": "資料已儲存並同步生效。",
    en: "Profile saved.",
  },
  "settings.versionConflict": {
    "zh-CN": "资料已在其他窗口被更新，请刷新最新版本号后再保存。",
    "zh-HK": "資料已於其他視窗更新，請重新整理最新版本號後再儲存。",
    en: "Profile was updated elsewhere. Reload the latest version before saving.",
  },
} as const satisfies Record<string, TrilingualText>;
