# Agent 工具与权限

员工可直接输入斜杠命令，或从工作台打开后端返回的快捷指令。管理员从员工权限页开启工具和设置到期时间。模型工具描述、参数验证与执行共用一份工具目录。每次读取企业数据前和回包前校验权限。

| 能力 | 入口 | 数据与执行边界 |
|---|---|---|
| 十进制计算、IANA 时区换算 | `/calc (804 + 120) / 2` · `/time Asia/Hong_Kong 2026-07-01T12:00:00Z` | 登录即可使用，进程内执行。除法采用 38 位 Decimal 精度，时间换算接收包含时区偏移的时间。 |
| 附件查找、CSV 与 TSV 检查 | 添加上下文后 `/find 交货日期` · `/csv` | 登录即可使用。浏览器接受至多 256 KB UTF-8 TXT、Markdown、CSV、TSV。文件仅随这两项指令传给自有后端。查找返回最多 5 个带行号的摘录。CSV 校验行、列与缺失值，最多 64 列及 10,000 个数据行。 |
| 公开网页搜索 | `/web 香港冷链物流公开供应商` | 「Agent 公开搜索」的 `agent.web_search`。租户还需启用搜索供应商、许可策略和配额。只向配置好的搜索服务发送校验后的检索词。 |
| 本人内部日历与已提交提案 | `/agenda 2026-11-25` · `/submitted 5` | 「Agent 协作读取」下分别开启 `agent.calendar_read`、`agent.tasks_read`。日历按本人参与关系取数，提案按提交人和原有提案范围查询。日期指令采用香港时间。 |
| 内部知识检索 | `/knowledge HK01 冷链` | 「Agent 内部知识」的 `agent.knowledge_read` 加上仓库范围。返回来源编号、章节与摘录。数据源需可用，响应再次校验租户、员工、仓库及每条命中记录的范围。 |
| ERP、发票、邮件摘要与经营汇总 | 已有工作台及工具指令 | 复用现有授权与数据源。ERP 变更经过提案、独立审批和派发校验。邮件发送和会议创建沿用确认与幂等路径。 |

仓库授权与已验证的身份仓库取交集。显式模块配置优先于身份默认权限。撤销后保留空授权，避免回退到身份默认值。员工级授权只适用于该员工的 Agent，人工日历、提案界面仍由其既有访问规则决定。新增工具卡内容不会自动进入后续模型上下文，活动记录保存哈希和状态。

## 企业知识数据源

演示提供 HK01 与 HK02 的合成 SOP。生产需在已有按租户固定的 `WorkspaceSource` 上配置 `AIOS_WORKSPACE_KNOWLEDGE=1` 并在客户连接器实现 `POST /workspace/knowledge-search`。请求只含 `tenant`、`subject`、`warehouse`、`query` 和 `limit`，沿用现有连接器鉴权。响应形状如下。

```json
{
  "result": {
    "tenant": "harbour",
    "subject": "operator",
    "warehouse": "HK01",
    "hits": [
      {
        "tenant": "harbour",
        "warehouse": "HK01",
        "source_id": "SOP-HK01-01",
        "title": "冷链交接",
        "section": "温度复核",
        "excerpt": "交接前需要复核温度记录。"
      }
    ]
  }
}
```

客户索引需在排序前按调用人、仓库和文档 ACL 过滤。AIOS 还会校验返回数量及范围，查询在途时撤权会丢弃结果。正式知识源需用客户索引和真实凭证验收。

## 开源组件取舍

| 技术 | 适配结论 |
|---|---|
| [Pydantic AI Toolsets](https://pydantic.dev/docs/ai/tools-toolsets/toolsets/) | 支持类型化工具发现、过滤和审批包装。当前直接复用现有 Pydantic、鉴权、工具预算和审批账本。 |
| [MCP Tools](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/server/tools.mdx) | 后续可用来接 GitHub 或团队知识平台，先固定可信服务器和可调用工具，再映射逐员工授权。 |
| [MarkItDown](https://github.com/microsoft/markitdown) · [Docling](https://docling-project.github.io/docling/usage/supported_formats/) | 仓库已有可选桌面适配。云端正式引入 PDF/Office 时建议复用隔离的转换进程，限制文件、宏和资源。 |
| [OpenFGA](https://github.com/openfga/openfga.dev/blob/docs-next/docs-site/modeling/roles-and-permissions.mdx) | 适合多团队、项目和文档的关系型权限。当前员工与仓库范围继续由现有数据库规则执行。 |
| [Temporal](https://docs.temporal.io/durable-execution) | 适合跨进程暂停和恢复的批处理长任务。写入活动仍需幂等键，普通读取继续走同步接口。 |
| [OpenTelemetry](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/execute-tool.md) | 可追踪工具名、时延与结果码。输入内容、查询和文档摘录应排除在默认追踪属性外。 |

尚需集成真实企业知识索引、复杂版面的高保真转换，以及客户指定的 CRM、工单或共享盘。每个连接器都需明确权限映射与沙盒验收。

## 验证

```bash
python -m unittest discover -s tests -p test_harness_tools.py -v
pnpm --dir web typecheck
pnpm --dir web build
```
