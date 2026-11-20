# 采购单演示操作手册

[English](demo.md)

## 演示时怎么讲

> 批发团队收来的订单格式不统一。常见的耗时点是确认客户指的是哪个商品、按什么包装下单。这里审核员直接看到 OCR 原位置、争议读数以及两箱如何换算成 48 件。审批之后发生回包丢失，系统仍能核对 ERP 是否已经生成草稿。

- **先看字段证据。** 在输入图上展示字段边框。单据是合成的，OCR 数值与坐标是运行时生成的。[原始样张](../fixtures/harbour-review.png)
- **再处理争议。** 脚本模拟的视觉模型 A 将 2 读成 8，模型 B 与 OCR 读取一致。系统仍要求人工复核。选 8 会触发数量乘单价的金额校验，确认 2 后按主数据换算为 48 件。
- **最后展示恢复。** 一个事务保存审批摘要和待派发命令。Worker 写入沙盒后模拟超时，第二步只读回执，确认已有草稿。

## 走完整条链路

打开 **Quantity conflict**，复核争议字段并审批已保存的预览。推进 Worker 两次。刷新后查看同一收件记录、复核字段和 ERP 核对状态。用 **Upload a purchase order** 上传 `fixtures/harbour-po.png`，点 **Extract fields**。上传单显示在 **Recent intakes**，随后可以审批与核对。

不勾选视觉选项即可无密钥演示。若配置了经批准的视觉服务，勾选 **Use configured vision for disputed crops**。清晰单据使用零次视觉调用，每个请求只发送一个定位裁剪。未知版式、未解矛盾和缺失定位继续复核。

## 重现演示画面

`python scripts/run_demo.py` 输出机器可读证据，用临时库运行 Tesseract、路由、复核、派发和读回。`python scripts/render_run_evidence.py` 生成证据卡片，需安装脚本路径指定的 DejaVu 字体。

使用新状态目录启动 API，安装 `requirements-test.txt`，执行 `python -m playwright install chromium`，再运行 `python scripts/capture_demo.py`。脚本检查正常接单、争议和无效改值、审批入队、超时及最终读回，并保存四张截图。可设置 `CHROMIUM_BIN` 和 `AIOS_CAPTURE_DIR`。GitHub CI 会上传相同的截图产物。

## 实现边界

- **PostgreSQL。** 安装 `requirements-postgres.txt`，配置 `AIOS_POSTGRES_DSN` 到新库，并让 API 和 Worker 使用同一状态目录。[数据库 schema](../sql/schema.sql) 使用 `AIOS_TEST_POSTGRES_DSN` 跑队列测试时须用可丢弃数据库，测试会删建 schema。租约只约束本地结果，派发中断后只读 ERP 回执，仍不明确则升级人工。
- **视觉。** 演示预设脚本无网络。启用真实模型要配置 `AIOS_ENABLE_LIVE_VISION=1` 及服务端 `VISION_BASE_URL`、`VISION_MODEL`、`VISION_API_KEY`。第二读者可用 `VISION_B_*`。适配器只发送裁剪和字段类型，按严格响应格式解析。先用合成样张验证兼容性和数据政策。
- **生产。** 工作台是本地演示。客户应用应部署独立后端、受限身份、原件保留、影像隔离和配额，并验证 ERP 外部单号唯一性、草稿权限、读回与版本控制。真实中英版式的识别覆盖率和错误率通过客户样本评估。[后端架构](platform.md)
- **业务键。** 由法人、买方和买方 PO 号组成。同键摘要不同触发修订异常。客户的编号及改单策略需在试点确认。
