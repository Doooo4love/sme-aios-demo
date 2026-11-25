# Office／PDF 文档与工作报告

管理员在现有员工权限页的「Agent 文档与报告」模块分别开启「解析 Office/PDF」和「下载工作报告」，也可设置到期时间。仓库报告同时要求该仓库的经营汇总读取权限。员工在聊天的「添加上下文」菜单选择文件、或输入报告命令。

| 用途 | 使用方式 |
|---|---|
| 查 Office／PDF 附件 | 选择授权格式后输入 `/find 交货日期`，命中附有页码、段落、幻灯片或工作表行号。 |
| 导出本人工作日报 | `/report mine pdf`。按香港当天统计本人会议、待审批和已提交提案状态。 |
| 导出仓库运营汇总 | `/report HK01 xlsx`。按已授权仓库提取数据源的未结运单和快照日期。 |
| 更换输出格式 | `pdf`、`docx`、`xlsx`、`csv`。CSV 带 UTF-8 BOM，XLSX 数值保留数值类型。 |

## 开源工具取舍

| 项目 | 本场景的用法 |
|---|---|
| [python-docx](https://python-docx.readthedocs.io/en/latest/user/quickstart.html) 与 [python-pptx](https://python-pptx.readthedocs.io/en/latest/user/text.html) | 读取 Word 段落、表格和 PowerPoint 幻灯片文字；用 python-docx 生成可编辑 Word 报告。 |
| [openpyxl](https://openpyxl.readthedocs.io/en/stable/tutorial.html) | 只读读取可见工作表、读取 Excel 已缓存的公式值，生成可编辑报告；解析不会重算公式。 |
| [pypdfium2](https://pypdfium2.readthedocs.io/en/stable/python_api.html) 与 [Tesseract](https://github.com/tesseract-ocr/tesseract) | PDF 往往有可直接读取的文本层。对没有文本层的页，可本地渲染后交给已配置的 Tesseract。 |
| [fpdf2](https://py-pdf.github.io/fpdf2/Unicode.html) | 从受控数据与固定模板生成 PDF，嵌入中文字体子集。 |
| [MarkItDown](https://github.com/microsoft/markitdown) 与 [Docling](https://docling-project.github.io/docling/usage/supported_formats/) | 后续可用来提升复杂 PDF 的版面、表格和文档转换覆盖。当前直接用小型解析库以减少转换层及部署依赖。 |
| [Gotenberg](https://gotenberg.dev/docs/about) | 适用于后续的高保真 Office 转 PDF 和大量通用转换；需要单独布置受限的转换服务。 |

## 启用和边界

在 Linux 工作台 API 的虚拟环境中安装 `requirements-platform-documents.txt`，并设置 `AIOS_DOCUMENT_TOOLS_ENABLED=1`。默认不启用。解析、报告下载分别使用现有逐员工权限与审计记录，无数据库迁移。上线前确认真实仓库数据源和配置。

- PDF 导出默认寻找 Linux 的 Noto Sans CJK 字体集，建议随部署安装 `fonts-noto-cjk`。可指定 `AIOS_REPORT_FONT` 及字体集中的 `AIOS_REPORT_FONT_INDEX`；无可用字体时，其他三个格式继续可用。
- 启用扫描页 OCR 需安装 Tesseract 及对应语言包，设置 `AIOS_DOCUMENT_OCR_LANGUAGES=eng+chi_sim+chi_tra`。当前回归包括英文扫描页；中英文混扫准确率需用客户文件单独验收。本流程优先读取现有文本层，对图片型页面最多 OCR 5 页。
- PDF、DOCX、XLSX、PPTX 原文件最多 5 MB，提取文字最多 120,000 字符，PDF/幻灯片最多处理 60 页。解析产物用于这次附件会话，原件、提取文字和报告二进制不写入数据库；权限审计仅记录事件和格式。
- OOXML 文件检查压缩项数量、解压上限、文件类型及宏和嵌入对象。解析器使用清理过的环境、临时目录、资源限制和 17 秒超时，在独立子进程运行。当前子进程仍使用 API 服务账号，正式接受外部大量文件时应给解析进程独立账号、文件系统和网络隔离。
- 当前导出覆盖个人日报与授权仓库汇总。PDF 导入侧提取可搜索文字，复杂版面、图表、扫描表格重建及旧式 DOC/XLS/PPT 文件需另行支持。对缺失缓存公式、截断和无文字页会返回提示。

## 验收

```bash
python -m pip install -r requirements-test.txt
python -m unittest discover -s tests -p test_documents_and_reports.py -v
pnpm --dir web typecheck
pnpm --dir web build
```
