# 工作台协作、同源会话与生产接入

## 数据与权限

继续使用 FastAPI 的已验身份和 PostgreSQL 事务。迁移 `0008_collaboration` 是向前兼容迁移。API 读取资料、历史、排程、审阅与会话；Worker 除原有权限外只可追加通知。每个新表启用强制 RLS。租户范围在事务内设置，资料、Agent 活动和通知另有当前员工边界。参与者范围、关联记录和业务授权由服务层复核。API 进程和 Worker 更新后清理旧进程，再恢复对外写入。

1. 在独立迁移身份执行 `alembic upgrade head`，然后应用 `deploy/platform/postgres-security.sql`。
2. 给 API 和 Worker 使用各自受限的登录。验证 RLS、备份恢复、滚动部署和 ERP 停写恢复。外部密码通过服务端凭据设施与 `*_FILE` 注入。
3. 生产同源边缘只转发固定业务路由。使用 HTTPS；反向代理和访问日志对登录回调路径去掉查询字符串。应用的 systemd 单元已经关闭 Uvicorn access log。
4. 排程锁、资料锁、ACL 锁按用途隔离。会议按参与者稳定顺序拿锁。审批及分派共用提案行锁。写入锁等待有上限。遇 `503 STORAGE_UNAVAILABLE` 按 `Retry-After` 使用原幂等键或相同版本重试。遇 `409` 刷新业务状态后再决策。

## 前端契约

| 能力 | 接口和行为 |
|---|---|
| 本人资料 | `GET/PATCH /v1/profile`；Agent 使用 `/v1/agent-profile`。PATCH 传 `{version,display_name}`，名称为 `null` 时恢复缺省。 `GET/PUT/DELETE {path}/avatar`，写入带 `?version=…`，上传用原始图像字节和 `application/octet-stream`。最大 2 MiB；服务重编码为最多 256 px 的 PNG，移除元数据，拒绝动画。初始版本 0，每次更新换新版本 |
| 同房成员资料 | `GET /v1/chat/rooms/{room_id}/members/{subject}/profile` 及其 `/avatar`。本人和目标都须仍是成员。返回授权范围内的员工资料与 PNG |
| Agent 活动 | 原有 `POST /v1/workbench/turns` 可增加 `client_id` 以保存活动和去重。此模式以 `client_id` 作幂等键。 `GET /v1/workbench/history` 按 `before_at,before_id` 分页，只返回活动 ID 和时间。 `GET /v1/workbench/history/{id}` 用当前授权重取资源数据。并行处理中返回 `409 TURN_IN_PROGRESS`，带 `Retry-After` |
| 待办和提交 | `GET /v1/workbench/tasks?lane=assigned|submitted`，沿用 `after_due,after_id` 游标。共享队列和指定审批人都按实际审批范围计算。已提交队列按当前业务读权过滤 |
| 审批和复审 | 批准继续用 `POST /v1/proposals/{id}/approve` 及本期摘要。退回、拒绝、分派与释放用 `POST /v1/proposals/{id}/review`，传 `{digest,action,reason?,assignee?}`，action 为 `return/reject/assign/release`。仅退回和拒绝要求理由，仅分派要求受信员工目录中的审批人。退回后的旧提案保持终态，纠正源数据后创建新提案。详情的 `review` 展示所分配的审批人和已授权的决定 |
| 内部会议 | `GET/POST /v1/calendar/events`，读带含时区 `start,end`，写带 `client_id,title,starts_at,ends_at,attendees,room_id`。多人会需要共同房间。 `GET/PATCH /v1/calendar/events/{id}`，取消用 `POST /v1/calendar/events/{id}/cancel`。变更带 `revision`。回包时间是 Unix 秒，`source=internal`。冲突只返回「至少一人忙碌」 |
| 通知 | `GET /v1/workbench/notices` 只返回通用标识和阅读状态。 `GET /v1/workbench/notices/{id}` 打开时重新鉴权返回业务类型和引用。 `PUT /v1/workbench/notices/{id}/read` 幂等确认。会议、提案分派/退回/审批和 Worker 终态在各自业务事务里追加站内通知 |
| 今日及周间简报 | `GET /v1/workbench/brief?start=…&end=…`，含时区，最长八天；返回当前有权可见的会议数、待审批快照和期间提交对象的当前状态。它是按需业务汇总，适用于今天或周报入口 |
| 受控预审收件 | 已配置 Assurance 时，用 `GET /v1/assurance/cases?kind=contract\|purchase\|incoming_quality`，按 `after` 翻页。当前仓和案件线授权有效才读。列表只给元数据。正文与字段证据继续用案件详情。可信上游可提供 `submitted_at` 供前端按时间呈现 |

Agent 历史保存明确的业务引用和请求摘要。用户发送原文可留在当前屏幕，会话重开后以业务活动记录呈现。邮件正文和即时反馈只用于本次请求。历史回读会重新执行类型化读取或得到当前提案，审批预览必须仍具备资格。权限改变后，重新获取的历史和通知详情返回通用不可用。模型推理、供应商信息和工具内部请求留在服务端。浏览器使用等待提示和真实提案状态，通过有限轮询更新业务进度。

## 浏览器会话和 Keycloak

- 设置 `AIOS_BROWSER_ORIGIN` 为与浏览器完全一致的可信源，设置 `AIOS_BROWSER_SESSION_KEY` 或 `AIOS_BROWSER_SESSION_KEY_FILE`，内容为 32 字节随机密钥的十六进制表示。生产必须使用 HTTPS，多副本配置同一把服务端密钥。Demo 允许显式配置本机 HTTP。
- 生产配置 `AIOS_BFF_OIDC_CLIENT_ID` 与 `AIOS_BFF_OIDC_CLIENT_SECRET` 时，使用 `GET /v1/session/login` 跳转 Keycloak。将 `{origin}/v1/session/callback` 加入准确的回调白名单。使用机密客户端、授权码及 PKCE S256。登录成功回到 `/inbox`。服务端已有 OIDC 的 BFF 也可以拿已验证访问令牌调用 `POST /v1/session` 交换 Cookie。此请求由服务器发出，并提供配置中的 Origin。
- 浏览器只持有不透明、HttpOnly Cookie。访问令牌加密在服务器侧存储。页面用 `GET /v1/session` 取得 CSRF token，业务写操作发 `X-CSRF-Token`。服务端同时核对 Origin。退出用 `DELETE /v1/session`。会话最多 15 分钟，访问令牌实际有效期取上游规则，每次业务请求都重新验证。默认到期重新登录；已有 OIDC BFF 可更新会话。
- 生产验收需拿目标 Keycloak 的 JWKS、客户端角色映射和撤权/登出实测。当前自动化验证覆盖 PKCE 跳转、错误 state、重放、Cookie 替换、CSRF、服务器侧加密和登出。

## 客户连接器契约

在生产设置 `AIOS_WORKSPACE_SOURCE_URL`、`AIOS_WORKSPACE_SOURCE_TOKEN` 和现有 `AIOS_CONNECTOR_TENANT`。部署方提供固定 HTTPS 业务桥接，入参中的租户和主体由校验后的服务器上下文填入。桥接必须校验来自 AIOS 的凭据并限制为批准的数据源。所有请求为 `POST {base}/workspace/{resource}`，返回 `{"result": …}`。每次调用大小和超时有上界。本站再次检验对象、主体与数据页，目录超时返回通用 503。

| 接口 | 桥接输入和约定 |
|---|---|
| `employee` | `tenant,subject` → `{active,actor}` 或 `null`。actor 含稳定主体、租户、角色、站点和基础授权。用于同房邀请资格和审批分派 |
| `invoice`、`inbox`、`warehouse-summary` | 指定调用者、仓库和对象号或页大小；用 `workbench_tools.py` 定义的带作用域投影。接口只读 |
| `assurance-case`、`assurance-cases` | 按已授权站点和案件类别查询。批量依照案件 ID 唯一升序，服务端拒收错租户、错区域或超范围的整页。配置 `AIOS_ASSURANCE_KEY_FILE` 和 `AIOS_ASSURANCE_ZONE` 才启用生产受控预审 |

客户桥接、真实 ERP 与实际 Keycloak 需要现场配置和签收。内部日历和通知已可使用，外部发信、会议提供方、推送调度与定时报告需要接入相应渠道。受控 Assurance 目前可在确定性工作台配置中使用。独立云规划器与受控案件的客户数据应继续按已批准的数据出口和治理配置隔离运行。
