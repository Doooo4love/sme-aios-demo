# SME AIOS 生产加固与验收

[English](production-readiness.en.md)

代码覆盖一条物流和一条批发主链，以及复用它们的执行、审批、身份和 ERP 连接边界。下表按工程证据区分本轮可复现结果和首客上线验收。

| 环节 | 本轮可验证的能力 | 首客上线必验 |
|---|---|---|
| 租户隔离 | PostgreSQL 强制 RLS，API 和 Worker 分开。生产启动检查角色、表所有权、RLS 与关键权限 | 用实际 Keycloak 角色、有效期、仓库映射和撤权同步验收。验证租户网络隔离及数据库事故演练 |
| 写入控制 | 主管审批与受限 Worker。租户停写、账户暂停、请求去重、失联读回、只读重查 | 和 ERP 管理员做停写与恢复演练。ERP bridge 需原子验证权限、版本和幂等回执。连接到真实沙盒后才能评估 |
| 迁移 | Alembic 管理基线、安全控制及异常队列索引。测试已存在数据可升级，重复执行能通过 | 备份恢复演练、回滚窗口、服务账户和上游连接器的生产配置 |
| 模型与资料 | 模型输出只能成为结构化意图。租户每分钟预算、上传限制、无模型本地样例 | 模型测试数据、供应商协议与出站范围。验证香港客户单据和语言覆盖、错误率、费用与延迟 |
| 观测 | API 请求计数与耗时、受保护的 metrics、就绪检查、请求 ID 和业务审计 | 按实际 P95、积压、租约回收和未知回执建立 SLO。备份与灾备 RTO/RPO 通过恢复测量 |

## 升级步骤

服务迁移和常态运行使用不同数据库身份。给 migration owner 配置 `AIOS_MIGRATION_DATABASE_URL_FILE`，文件内放 SQLAlchemy 可读取的 URL。生产地址示例为 `postgresql://migration_user:...@db.example/aios?sslmode=verify-full`。当前迁移创建缺少的表与索引并更新版本状态，原有数据保留。部署先升级数据库和授予权限，再启动新 API 和 Worker。

```bash
python -m pip install -r requirements-platform.txt
python -m alembic upgrade head
python -m alembic current
```

接着由 migration owner 执行 [PostgreSQL 安全脚本](../deploy/platform/postgres-security.sql)。在 PostgreSQL 中预先建立专用、非 owner 和非超级用户账户 `aios_api` 与 `aios_worker`。应用生产启动会检查是否启用强制 RLS、是否使用对应角色，以及审计和回执权限是否符合分工。将二者的 DSN 分别装入 [systemd 单元](../deploy/platform/) 指定的凭据路径。复用连接时租户上下文必须限制在单事务内。目前服务按事务创建连接；当连接数有实测压力时，可将 PgBouncer 放在事务边界并验 SET LOCAL。参考 [Alembic migration 教程](https://alembic.sqlalchemy.org/en/latest/tutorial.html) · [PostgreSQL RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)

## 运行与应急

- `PUT /v1/operations/write-control`（tenant admin）提交 `{"paused":true}`。新写入暂停，已发送的请求继续查回执。停写无法撤回已经跨过最后检查、在 ERP 处理中或已落库的操作。严重事件还应冻结 ERP 写身份，并核对在途单。
- `PUT /v1/operations/subjects/{subject}/suspension`（tenant admin）可冻结其他账号的 AIOS 会话与待发送审批。已排队操作在发送前会复查请求人和审批人。平台停权与 Keycloak 账户生命周期需要接同步。恢复账号权限时，已拒绝的提案须重新提交和审批。
- `POST /v1/proposals/{id}/reconcile` 允许仓库主管把 `NEEDS_OPERATOR` 转回只读回执查询，有限重查到阈值再次交人工。只有 ERP 回执的 tenant、操作 ID、摘要和目标都一致时，结果才转到 `VERIFIED`。
- 在 `POST /v1/actions` 的变更提案附 `Idempotency-Key`。允许 1–128 个 ASCII 字母、数字和 `._:-`，以租户、主体为命名空间。同键同请求返回原提案的当前状态，同键异内容返回 409。并发 JSON 请求验证不会产生两张提案。幂等记录跟随提案保留，后续清理必须和审计留存约定一致。
- `AIOS_PLANNER_CALLS_PER_MINUTE` 默认每租户 60 次。请求消耗按同一个 PostgreSQL 分钟窗口扣除，命中已保存幂等键的重放直接返回。结构化请求采用 64 KiB 上限，影像上限 8 MB。两种请求读取均限制在 15 秒内。外部网关仍应按客户并发与带宽加连接上限和速率控制。

- `GET /v1/operations/exceptions` 提供按仓库隔离的待核对队列和最近的处理原因。批量来单、审批及客服验收见[试点自动化指南](pilot-automation.zh-CN.md)。

## 指标与工具选择

`/healthz` 只测进程。`/readyz` 检查数据库访问且不发送 ERP 请求。配置专用 `AIOS_METRICS_TOKEN_FILE` 后才发布 `/metrics`，该接口需要对应 Bearer token。日志可用 `aios.platform` logger，按服务器生成的请求 ID 关联访问。Prometheus 只使用 HTTP 方法、路由模板和状态码作为标签。租户 ID、运单号、请求文本、令牌和模型内容都不导出。运维侧应告警 5xx、429、P95、队列老化、未知结果和需要人工接管的单。参考 [Prometheus 指标类型](https://prometheus.github.io/client_python/instrumenting/) · [OpenTelemetry 数据处理](https://opentelemetry.io/docs/security/handling-sensitive-data/)

- **现在使用** Alembic 管理 schema、Prometheus 客户端提供基础指标、Keycloak/OIDC 负责身份、PostgreSQL 做事务和租户数据边界。OPA 仍可按客户的授权复杂度启用。
- **达到部署条件后使用** pgBackRest 做 PostgreSQL 全量/增量与 PITR 演练。OpenTelemetry Collector 接统一日志和 trace，按允许列表保留字段。OpenBao 用于在多环境集中轮换凭据。Temporal 适合长时间、多网络步骤的人审工作流，但 ERP 事务和幂等合同仍必须独立验收。
- **生产签收标准** 每次 CI 扫描生产 Python 依赖的已知漏洞。首客上线采用 OWASP ASVS 作验证维度，并执行独立安全测试和容量测试。接入企业样本之前只输出合成数据实跑结果。参考 [OWASP ASVS](https://asvs.owasp.org/) · [pgBackRest 使用指南](https://pgbackrest.org/user-guide.html) · [Temporal Activity 幂等](https://docs.temporal.io/activity-definition)

以上不构成客户生产环境的安全认证。首客试点需就真实 ERP 读写、身份撤权、网络隔离、审计留存、告警和从备份复原逐项签收。
