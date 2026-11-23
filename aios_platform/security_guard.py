"""Deterministic input normalization, prompt/tool guardrails, and output leakage filtering."""
from __future__ import annotations

from pathlib import Path
import re
from typing import Literal
import unicodedata

from .contracts import Actor, Strict
from .providers import action_sites, approval_sites, order_read_sites

Category = Literal[
    "SKILL_TAMPER_ATTEMPT",
    "PROMPT_TAMPER_ATTEMPT",
    "DESTRUCTIVE_ACTION_ATTEMPT",
    "FILESYSTEM_ESCAPE_ATTEMPT",
    "PROMPT_INJECTION_ATTEMPT",
    "SECRET_EXFILTRATION_ATTEMPT",
    "PRIVILEGE_ESCALATION_ATTEMPT",
    "CROSS_SCOPE_ACCESS_ATTEMPT",
    "UNAUTHORIZED_MODULE_QUERY",
    "EMAIL_POLICY_VIOLATION",
]

_PEM_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.IGNORECASE,
)
_SK_RE = re.compile(r"(?<![A-Za-z0-9_-])sk-[A-Za-z0-9._-]{6,}(?![A-Za-z0-9_-])")
_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{6,}")
_PASSCODE_RE = re.compile(r"(?i)\b(?:THEODIC-DEMO|THEODIC-TEAM|CCMF27)-[A-Za-z0-9_-]{3,}\b")
_HEX_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9])[0-9a-fA-F]{48,}(?![A-Za-z0-9])")
_COOKIE_RE = re.compile(r"(?i)\b(?:__Host-aios_session|__Host-aios_gate|aios_demo_session|aios_demo_oauth)=[^\s;,'\"]+")
_ASSIGN_SECRET_RE = re.compile(
    r"(?i)(\b(?:password|passwd|pwd|api[_-]?key|secret[_-]?key|secret|signing[_-]?key|"
    r"private[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|"
    r"deepseek_api_key|aios_llm_api_key|aios_demo_secret|aios_browser_session_key|"
    r"gate_secret|client_secret)\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
)
_ZH_PASSWORD_RE = re.compile(r"((?:密码|密碼|密钥|密鑰|口令)\s*[:：=]\s*)([^\s,;，；]+)")


class GuardVerdict(Strict):
    allowed: bool
    category: str | None = None
    severity: Literal["info", "medium", "high", "critical"] = "info"
    module: str | None = None
    action_attempted: str | None = None
    decision: Literal["allowed", "blocked", "denied", "flagged", "escalated"] = "allowed"
    refusal_zh: str = ""
    refusal_hk: str = ""
    refusal_en: str = ""
    matched_rule: str | None = None

    def localized_refusal(self, locale: str = "zh-CN") -> str:
        if locale == "zh-HK":
            return self.refusal_hk or self.refusal_zh or self.refusal_en
        if locale == "en":
            return self.refusal_en or self.refusal_zh or self.refusal_hk
        return self.refusal_zh or self.refusal_hk or self.refusal_en


def _allow() -> GuardVerdict:
    return GuardVerdict(allowed=True, severity="info", decision="allowed")


def _deny(
    *,
    category: Category,
    severity: Literal["medium", "high", "critical"],
    decision: Literal["blocked", "denied", "flagged", "escalated"],
    matched_rule: str,
    refusal_zh: str,
    refusal_hk: str,
    refusal_en: str,
    module: str | None = None,
    action_attempted: str | None = None,
) -> GuardVerdict:
    return GuardVerdict(
        allowed=False,
        category=category,
        severity=severity,
        module=module,
        action_attempted=action_attempted,
        decision=decision,
        refusal_zh=refusal_zh,
        refusal_hk=refusal_hk,
        refusal_en=refusal_en,
        matched_rule=matched_rule,
    )


def scrub_secrets(text: str) -> str:
    if not text:
        return ""
    cleaned = _PEM_RE.sub("[REDACTED_PRIVATE_KEY]", text)
    cleaned = _PASSCODE_RE.sub("[REDACTED_PASSCODE]", cleaned)
    cleaned = _SK_RE.sub("[REDACTED_KEY]", cleaned)
    cleaned = _BEARER_RE.sub("Bearer [REDACTED]", cleaned)
    cleaned = _COOKIE_RE.sub("[REDACTED_COOKIE]", cleaned)
    cleaned = _ASSIGN_SECRET_RE.sub(r"\1[REDACTED]", cleaned)
    cleaned = _ZH_PASSWORD_RE.sub(r"\1[REDACTED]", cleaned)
    cleaned = _HEX_TOKEN_RE.sub("[REDACTED_HEX]", cleaned)
    return cleaned


_UNICODE_DASHES_RE = re.compile(r"[\u2010-\u2015\u2212]")


def normalize_user_text(text: str) -> tuple[str, str]:
    """Return (nfkc_no_cf, compact_single_line) after NFKC and Cf zero-width stripping."""
    nfkc = unicodedata.normalize("NFKC", text or "")
    stripped = "".join(
        ch for ch in nfkc
        if unicodedata.category(ch) != "Cf" and (ord(ch) >= 32 or ch in "\t\n\r")
    )
    stripped = _UNICODE_DASHES_RE.sub("-", stripped)
    compact = re.sub(r"\s+", " ", stripped).strip()
    return stripped, compact


# --- Compiled rule sets for adversarial & policy detection ---

_SKILL_TAMPER_PATTERNS = (
    ("skill_md_file", re.compile(r"(?i)(?:\bskill\.md\b|\.claude/|\.codex/|\.cursor/|\.gemini/|/skills/)")),
    ("skill_plugin_modify_en", re.compile(
        r"(?i)\b(?:add|create|install|edit|modify|update|write|overwrite|delete|remove|register|inject|patch|replace)\b"
        r".{0,45}\b(?:skill|skills|plugin|plugins|mcp\s+server|tool\s+schema|agent\s+config|"
        r"agent\s+code|your\s+(?:code|tools?))\b"
    )),
    ("self_modify_en", re.compile(
        r"(?i)\b(?:modify|change|update|edit|rewrite|override)\s+(?:yourself|your\s+own\s+(?:code|skills?|tools?))\b"
    )),
    ("skill_tamper_zh", re.compile(
        r"(?:新增|添加|创建|建立|安装|安裝|修改|编辑|編輯|更改|改动|改動|重写|重寫|删除|刪除|覆盖|覆蓋|注册|註冊|植入|注入)"
        r".{0,25}(?:技能|skill|插件|plugin|MCP|工具配置|工具定义|工具定義|智能体配置|智能體配置|Agent配置|"
        r"自身代码|自身代碼|自我修改)"
    )),
    ("self_modify_zh", re.compile(
        r"(?:修改|改写|改寫|更新|关闭|關閉|禁用).{0,20}(?:你自己的|自己的|系统|系統|内置|內置)"
        r"(?:代码|代碼|技能|工具)"
    )),
)

_PROMPT_TAMPER_PATTERNS = (
    ("soul_tamper_en", re.compile(
        r"(?i)(?:\b(?:add|append|insert|edit|modify|update|write|overwrite|rewrite|delete|remove|erase|clear|reset|replace|patch|change|inject|save)\b"
        r".{0,80}\b(?:soul\.md|soul\s+(?:file|doc|document|markdown|prompt|persona|rules?|truths?)|your\s+soul|persona\s+file)\b|"
        r"\bsoul\.md\b.{0,50}\b(?:edit|modify|update|overwrite|rewrite|append|delete|remove|reset|replace|patch|change)\b)"
    )),
    ("directive_tamper_en", re.compile(
        r"(?i)(?:\b(?:add|append|insert|edit|modify|update|write|overwrite|rewrite|delete|remove|erase|clear|reset|replace|patch|change|override|disable|relax)\b"
        r".{0,80}\b(?:(?:general|module|system|sealed|internal|base|core|orders|dispatch|invoice-review|warehouse-insights|approvals|mail-outbox|calendar-meetings)\s+)?"
        r"(?:directives?|guardrails?|guardrail\s+rules?|system\s+prompts?|prompt\s+polic(?:y|ies)|system\s+instructions?|sealed\s+polic(?:y|ies)|"
        r"your\s+(?:prompts?|instructions?|rules?|directives?|persona))\b|"
        r"\b(?:general|module|system|sealed)\s+(?:directives?|guardrails?|system\s+prompts?|prompt\s+polic(?:y|ies))\b"
        r".{0,45}\b(?:edit|modify|update|overwrite|rewrite|append|delete|remove|reset|replace|patch|change)\b)"
    )),
    ("prompt_tamper_zh", re.compile(
        r"(?:新增|添加|追加|插入|修改|编辑|編輯|更改|改动|改動|重写|重寫|覆盖|覆蓋|删除|刪除|清空|清除|重置|替换|替換|调整|調整|改写|改寫|更新|写入|寫入|关闭|關閉|禁用|放宽|放寬)"
        r".{0,45}(?:SOUL\.md|soul\.md|灵魂文件|靈魂檔案|灵魂设定|靈魂設定|人格设定|人格設定|"
        r"(?:通用|模块|模組|系统|系統|内置|內置|密封|核心)?(?:提示词|提示詞|指令|护栏|護欄|防护规则|防護規則|策略指令|提示词策略|提示詞策略)|"
        r"(?:general|orders|dispatch|invoice-review|warehouse-insights|approvals|mail-outbox|calendar-meetings)\s*(?:指令|提示词|提示詞|规则|規則|策略))|"
        r"(?:SOUL\.md|soul\.md|灵魂文件|靈魂檔案|灵魂设定|靈魂設定|系统提示词|系統提示詞|通用提示词|通用提示詞|模块提示词|模組提示詞|通用指令|模块指令|模組指令|系统指令|系統指令|防护规则|防護規則)"
        r".{0,35}(?:添加|追加|写入|寫入|加入|覆盖|覆蓋|重写|重寫|改写|改寫|修改|更改|改动|改動|调整|調整|更新|改成|改为|改為|编辑|編輯|重置|替换|替換|删除|刪除|放宽|放寬)"
    )),
)

_FILESYSTEM_ESCAPE_PATTERNS = (
    ("sensitive_path", re.compile(
        r"(?i)(?:/etc/aios|/etc/passwd|/etc/shadow|/var/lib/aios|/opt/aios|/proc/self|"
        r"~/\.ssh|\bid_rsa\b|\bauthorized_keys\b|\.\./\.\.|\.\.\\\.\.|"
        r"\.reviewer-pass\.local\.json|\.(?:sqlite|sqlite3)\b|(?:^|[\s/'\"])\.env(?:\.[A-Za-z0-9_-]+)?\b|"
        r"\b(?:store|erp|ledger)\.sqlite\b)"
    )),
    ("shell_exec_en", re.compile(
        r"(?i)\b(?:run|execute|eval|invoke|open|spawn|use)\b.{0,25}"
        r"\b(?:bash|sh|zsh|shell|cmd|powershell|terminal|subprocess|os\.system|popen|curl|wget|ssh|scp|rsync|netcat|python\s+-c)\b"
    )),
    ("cli_file_probe_en", re.compile(
        r"(?i)(?:^|\s)(?:cat|head|tail|less|grep|ls|find|chmod|chown|sudo|curl|wget|ssh)\s+(?:/etc|/var|/opt|/Users|/home|~|\.)"
    )),
    ("server_file_read_en", re.compile(
        r"(?i)\b(?:read|view|open|show|cat|dump|edit|modify|write|list)\b.{0,30}"
        r"\b(?:server\s+files?|local\s+files?|filesystem|source\s+code|config\s+files?|env\s+file|sqlite\s+file|database\s+file)\b"
    )),
    ("filesystem_escape_zh", re.compile(
        r"(?:读取|讀取|查看|打开|打開|修改|编辑|編輯|写入|寫入|列出|遍历|遍歷|下载|下載|访问|訪問|导出|導出)"
        r".{0,25}(?:服务器文件|伺服器檔案|本地文件|本地檔案|文件系统|檔案系統|环境变量文件|環境變數檔案|"
        r"配置文件|設定檔|数据库文件|數據庫檔案|源码|源碼|源代码|原始碼|/etc/|/var/|/opt/|\.env|\.sqlite|\.json)"
    )),
    ("shell_exec_zh", re.compile(
        r"(?:执行|執行|运行|運行|调用|調用|打开|打開).{0,20}"
        r"(?:bash|shell|终端|終端|命令行|系统命令|系統命令|curl|wget|ssh|python脚本|python腳本)"
    )),
)

_DESTRUCTIVE_PATTERNS = (
    ("sql_ddl_dml", re.compile(
        r"(?i)(?:\b(?:drop|truncate)\s+(?:table|database|schema|index)\b|"
        r"\bdelete\s+from\s+aios_|\balter\s+table\b|;\s*(?:drop|delete|truncate|alter)\b|"
        r"\bunion\s+select\b|'\s*or\s*'1'\s*=\s*'1)"
    )),
    ("shell_destructive", re.compile(
        r"(?i)(?:\brm\s+-[a-z]*r[a-z]*f\b|\brm\s+-rf\b|\bmkfs\b|\bdd\s+if=|"
        r"\bwipe\s+(?:the\s+)?database\b|\breset\s+(?:the\s+)?(?:database|db|state|system|all\s+tables)\b)"
    )),
    ("record_purge_en", re.compile(
        r"(?i)\b(?:delete|drop|truncate|purge|wipe|erase|clear|destroy|remove|reset)\b.{0,35}"
        r"\b(?:table|tables|database|db|orders?|proposals?|intakes?|shipments?|invoices?|"
        r"audit\s*logs?|audit\s*records?|security\s*events?|all\s+records?|all\s+data|state)\b"
    )),
    ("destructive_zh", re.compile(
        r"(?:删除|刪除|清空|清除|销毁|銷毀|抹掉|抹除|擦除|重置|截断|截斷|删表|刪表|删库|刪庫|清库|清庫)"
        r".{0,25}(?:表|数据库|數據庫|数据表|資料表|库|庫|订单|訂單|提案|审批记录|審批記錄|审计日志|審計日誌|"
        r"安全事件|安全日志|安全日誌|全部记录|全部記錄|历史记录|歷史記錄|状态|狀態|所有数据|所有資料|全部数据|全部資料)"
    )),
)

_EMAIL_CRLF_TURN_RE = re.compile(
    r"(?:(?:\r|\n|%0[da]|\\r|\\n)\s*(?:bcc|cc|to|from|subject|reply-to|content-type|mime-version|x-[a-z-]+)\s*:|"
    r"\b(?:crlf|header)\s+injection\b|邮件头注入|郵件頭注入)",
    re.IGNORECASE,
)
_EMAIL_SPAM_PHISHING_RE = re.compile(
    r"(?i)(?:\b(?:phishing\s+(?:email|mail|campaign|template)|spam\s+(?:email|blast|campaign)|"
    r"mass\s+(?:phishing|spam)|email\s+bomb|spoof\s+(?:sender|email|from))\b|"
    r"\b(?:send|blast|spam|mass[- ]?mail|bulk[- ]?email)\b.{0,40}\b(?:all\s+customers|mailing\s+list|everyone\s+externally|spam|phishing)\b|"
    r"(?:群发垃圾邮件|群發垃圾郵件|批量发送垃圾邮件|钓鱼邮件|釣魚郵件|仿冒邮件|仿冒郵件|伪造发件人|偽造寄件人|邮件轰炸|郵件轟炸))"
)
_EMAIL_EXFIL_RE = re.compile(
    r"(?i)(?:(?:\b(?:email|e-mail|mail|send|forward|smtp)\b.{0,40}\b(?:api[\s_-]?key|deepseek|secret|bearer|"
    r"session\s+cookie|passcode|password|\.sqlite|\.db|\.env|\.pem|/etc/aios|database\s+dump|sql\s+dump)\b)|"
    r"(?:(?:发邮件|發郵件|发送邮件|發送郵件|邮件发送|郵件發送|寄信|寄出|转发|轉發).{0,35}"
    r"(?:密钥|密鑰|API\s*key|凭证|憑證|密码|密碼|数据库导出|數據庫導出|数据库文件|數據庫檔案|\.sqlite|\.env|\.pem)))"
)
_EMAIL_ADDR_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

_SECRET_EXFIL_PATTERNS = (
    ("env_secret_name", re.compile(
        r"\b(?:DEEPSEEK_API_KEY|AIOS_LLM_API_KEY|AIOS_DEMO_SECRET|AIOS_BROWSER_SESSION_KEY|"
        r"AIOS_ASSURANCE_KEY|AIOS_METRICS_TOKEN|AIOS_REVIEWER_PASSCODE|OPENAI_API_KEY|"
        r"CLOUDFLARE_API_TOKEN|__Host-aios_session|__Host-aios_gate|aios_demo_session|gate_secret)\b"
    )),
    ("secret_request_en", re.compile(
        r"(?i)\b(?:give|show|tell|print|reveal|export|dump|extract|leak|send|get|fetch|read|what\s+is|share)\b"
        r".{0,35}\b(?:api[\s_-]?keys?|secret[\s_-]?keys?|signing[\s_-]?keys?|private[\s_-]?keys?|"
        r"encryption[\s_-]?keys?|bearer[\s_-]?tokens?|session[\s_-]?cookies?|auth[\s_-]?tokens?|"
        r"oauth[\s_-]?secrets?|client[\s_-]?secrets?|(?:admin|root|db|database|system)\s+passwords?|"
        r"passcodes?|reviewer\s+passcodes?|credentials?|\.pem)\b"
    )),
    ("secret_direct_token", re.compile(
        r"(?i)(?:\b(?:session\s+cookie|bearer\s+token|signing\s+key|private\s+key|api\s+key|reviewer\s+passcode)\b|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)"
    )),
    ("secret_request_zh", re.compile(
        r"(?:获取|獲取|查看|显示|顯示|输出|輸出|打印|导出|導出|泄露|洩露|告诉我|告訴我|发送|發送|给我|給我|读取|讀取|窃取|竊取|提取)"
        r".{0,25}(?:API\s*密钥|API\s*密鑰|API\s*key|密钥|密鑰|私钥|私鑰|签名密钥|簽名密鑰|密码|密碼|口令|"
        r"通行码|通行碼|令牌|token|凭证|憑證|凭据|憑據|cookie|session\s*cookie|bearer|证书私钥|證書私鑰|\.pem)"
    )),
)

_PROMPT_INJECTION_PATTERNS = (
    ("jailbreak_marker", re.compile(
        r"(?:<\|im_start\|>|<\|im_end\|>|<\|system\|>|\[SYSTEM\]|###\s*(?:SYSTEM|INSTRUCTION|ADMIN|OVERRIDE)|"
        r"\bDAN\b|(?i:\bdan\s+mode\b|\bdo\s+anything\s+now\b|\bjailbreak\b|\bdeveloper\s+mode\b|\bgod\s+mode\b|\bunrestricted\s+mode\b))"
    )),
    ("ignore_instructions_en", re.compile(
        r"(?i)\b(?:ignore|disregard|forget|override|bypass|skip|drop|abandon)\b.{0,30}"
        r"\b(?:all\s+|any\s+|your\s+|the\s+)?(?:previous|prior|above|earlier|system|safety|security|policy|guardrail|built-in)\s+"
        r"(?:instructions?|rules?|prompts?|constraints?|policies|directives?|guardrails?|limits?)\b"
    )),
    ("bypass_guardrail_en", re.compile(
        r"(?i)(?:\byou\s+are\s+now\s+(?:free|unrestricted|dan|developer|root|admin)\b|"
        r"\b(?:bypass|circumvent|disable|turn\s+off)\s+(?:the\s+)?(?:guardrails?|safety|restrictions?|filters?|rules?|policy)\b)"
    )),
    ("reveal_prompt_en", re.compile(
        r"(?i)(?:\bsoul\.md\b|"
        r"\b(?:reveal|show|view|read|print|output|repeat|dump|leak|quote|paraphrase|summarize|summarise|"
        r"export|inspect|display|list|recite|share|give\s+me|copy|extract|translate|describe|explain|"
        r"tell\s+me|what\s+(?:is|are|does))\b.{0,55}"
        r"\b(?:soul\s+(?:file|doc|document|markdown|prompt|persona|rules?|truths?)|your\s+soul|persona\s+file|"
        r"(?:general|module|system|sealed|internal|hidden|base|core|compiled|orders|dispatch|invoice-review|warehouse-insights|approvals|mail-outbox|calendar-meetings)\s+"
        r"(?:directives?|guardrails?|guardrail\s+rules?|system\s+prompts?|prompts?|instructions?|polic(?:y|ies)|rules?)|"
        r"system\s+prompt|hidden\s+prompt|verbatim\s+instructions?|prompt\s+template|prompt\s+polic(?:y|ies)|"
        r"your\s+(?:prompts?|instructions?|directives?|guardrails?|rules?|persona))\b|"
        r"\b(?:general|module|system|sealed|internal|compiled)\s+(?:directives?|guardrails?|system\s+prompts?|instructions?|prompt\s+polic(?:y|ies))\b"
        r".{0,45}\b(?:quote|paraphrase|summarize|summarise|export|dump|reveal|print|show|view|read|repeat)\b)"
    )),
    ("prompt_injection_zh", re.compile(
        r"(?:(?:忽略|无视|無視|忘记|忘記|覆盖|覆蓋|绕过|繞過|突破|取消|关闭|關閉|解除).{0,20}"
        r"(?:之前|以前|前面|上方|所有|全部|一切|系统|系統|内置|內置|安全).{0,15}"
        r"(?:指令|规则|規則|限制|提示词|提示詞|约束|約束|护栏|護欄|规定|規定|策略)|"
        r"绕过限制|繞過限制|越狱模式|越獄模式|开发者模式|開發者模式|无限制模式|無限制模式|"
        r"(?:泄露|洩露|透露|输出|輸出|打印|展示|查看|读取|讀取|显示|顯示|导出|導出|引用|复述|複述|转述|轉述|概括|总结|總結|背诵|背誦|复制|複製|提取|翻译|翻譯|告诉我|告訴我|发给我|發給我)"
        r".{0,40}(?:SOUL\.md|soul\.md|灵魂文件|靈魂檔案|灵魂设定|靈魂設定|人格设定|人格設定|"
        r"(?:通用|模块|模組|系统|系統|内部|內部|隐藏|隱藏|原始|底层|底層|密封|核心|完整|全部)?(?:提示词|提示詞|指令|设定|設定|护栏|護欄|防护规则|防護規則|安全规则|安全規則|策略原文|提示词策略|提示詞策略)|"
        r"(?:general|orders|dispatch|invoice-review|warehouse-insights|approvals|mail-outbox|calendar-meetings)\s*(?:指令|提示词|提示詞|护栏|護欄|规则|規則|策略))|"
        r"(?:系统提示词|系統提示詞|通用提示词|通用提示詞|模块提示词|模組提示詞|通用指令|模块指令|模組指令|系统指令|系統指令|防护规则|防護規則|灵魂设定|靈魂設定|SOUL\.md|soul\.md)"
        r".{0,35}(?:查看|读取|讀取|导出|導出|总结|總結|概括|复述|複述|转述|轉述|引用|打印|输出|輸出|写了什么|寫了什麼|原文|全文|内容|內容))"
    )),
)

_PRIVILEGE_ESCALATION_PATTERNS = (
    ("self_elevate_en", re.compile(
        r"(?i)(?:\b(?:grant|give|assign|elevate|promote|upgrade|add|enable)\b.{0,30}\b(?:myself|me|my\s+account|my\s+role|own\s+account)\b"
        r".{0,30}\b(?:admin|manager|role|grants?|permissions?|privileges?|modules?|access|finance|approv|operations|warehouse)\b|"
        r"\b(?:make\s+me|promote\s+me\s+to|elevate\s+(?:my\s+)?role\s+to|escalate\s+(?:my\s+)?privileges?|become\s+(?:an?\s+)?admin)\b)"
    )),
    ("self_elevate_zh", re.compile(
        r"(?:(?:给我|給我|为我|為我|把自己|把我的|提升我的|升级我的|升級我的|赋予我|賦予我|授予我).{0,25}"
        r"(?:提升|升级|升級|设为|設為|变成|變成|开通|開通|赋予|賦予|授予|添加|增加|提权|提權).{0,20}"
        r"(?:管理员|管理員|admin|manager|主管|权限|權限|角色|模块|模組|访问权|訪問權)|"
        r"(?:提权|提權|权限提升|權限提升|越权|越權|给自己授权|給自己授權|给自己加权限|給自己加權限|升为管理员|升為管理員))"
    )),
    ("sod_self_approve", re.compile(
        r"(?i)(?:\b(?:self[- ]?approve|approve\s+my\s+own\s+(?:proposal|order|shipment|request)|"
        r"bypass\s+(?:sod|segregation\s+of\s+duties|two[- ]?person|independent\s+approv)|force[- ]?approve\s+my\s+own)\b|"
        r"(?:自己审批|自己審批|自我审批|自我審批|审批我自己的|審批我自己的|批准我自己提交的|批准我自己的|"
        r"绕过职责分离|繞過職責分離|绕过双人复核|繞過雙人覆核|跳过独立审批|跳過獨立審批|强制通过自己的提案|強制通過自己的提案))"
    )),
    ("suspend_admin_or_disable_audit", re.compile(
        r"(?i)(?:\b(?:suspend|ban|lock|disable|remove)\b.{0,25}\b(?:admin|administrator|access-admin|other\s+admins?)\b|"
        r"\b(?:disable|turn\s+off|bypass|stop|remove|clear)\b.{0,25}"
        r"\b(?:audit|audit\s+log|logging|rls|row[- ]level\s+security|write[- ]?pause|write\s+control|"
        r"security\s+guard|guardrail|approval\s+gate)\b|"
        r"(?:停用|暂停|暫停|封禁|冻结|凍結|踢掉|禁用).{0,15}(?:管理员|管理員|admin|审计|審計|日志记录|日誌記錄|安全护栏|安全護欄)|"
        r"(?:关闭|關閉|绕过|繞過|禁用|停止).{0,20}(?:审计|審計|审计日志|審計日誌|行级安全|行級安全|"
        r"写暂停限制|寫暫停限制|写入控制|寫入控制|写控制|寫控制|全局写保护|全局寫保護|审批控制|審批控制))"
    )),
)

_EXPLICIT_TENANT_ZH_RE = re.compile(r"(?:租户|租戶)\s*[:：]?\s*([A-Za-z0-9_-]{2,32})")
_EXPLICIT_TENANT_EN_RE = re.compile(r"(?i)\btenant\s*[:=]?\s*([A-Za-z0-9_-]{2,32})\b")
_CROSS_TENANT_PHRASE_RE = re.compile(
    r"(?i)(?:\b(?:other|another|all|cross)[- ]?tenants?\b|跨租户|跨租戶|其他租户|其他租戶|所有租户|所有租戶)"
)
_WAREHOUSE_TOKEN_RE = re.compile(r"\b(HK\d{2}|WH[-_]?\d{1,3})\b", re.IGNORECASE)
_WAREHOUSE_NAMED_EN_RE = re.compile(r"(?i)\b(?:warehouse|site)\s+([A-Z]{2,4}\d{1,3})\b")
_WAREHOUSE_NAMED_ZH_RE = re.compile(r"(?:仓库|倉庫|站点|站點)\s*[:：]?\s*([A-Za-z]{2,4}\d{1,3}|[A-Za-z0-9_-]*\d+[A-Za-z0-9_-]*)")
_CROSS_WAREHOUSE_PHRASE_RE = re.compile(
    r"(?i)(?:\b(?:other|another)\s+warehouses?\b|其他仓库|其他倉庫|别的仓库|別的倉庫|跨仓|跨倉)"
)


def _check_cross_scope(actor: Actor, compact: str) -> GuardVerdict | None:
    lower = compact.lower()
    # Strip geographical "hong kong island" before tenant name probing.
    sanitized_for_tenant = re.sub(r"(?i)\bhong\s+kong\s+island\b", " ", lower)
    current_tenant = actor.tenant.lower()

    for tenant_name in ("harbour", "island"):
        if tenant_name != current_tenant:
            if re.search(rf"(?<![a-z0-9_-]){re.escape(tenant_name)}(?![a-z0-9_-])", sanitized_for_tenant):
                return _deny(
                    category="CROSS_SCOPE_ACCESS_ATTEMPT",
                    severity="high",
                    decision="denied",
                    matched_rule=f"cross_tenant:{tenant_name}",
                    refusal_zh=f"安全边界已拦截跨租户访问请求：当前会话仅限租户 {actor.tenant}，无法访问 {tenant_name} 租户的数据。",
                    refusal_hk=f"安全邊界已攔截跨租戶訪問請求：目前會話僅限租戶 {actor.tenant}，無法訪問 {tenant_name} 租戶的資料。",
                    refusal_en=f"Cross-tenant access denied: your session is strictly scoped to tenant '{actor.tenant}' and cannot access '{tenant_name}'.",
                )

    for pattern in (_EXPLICIT_TENANT_EN_RE, _EXPLICIT_TENANT_ZH_RE):
        for match in pattern.finditer(compact):
            candidate = match.group(1).lower()
            if candidate not in {current_tenant, "my", "this", "current", "id"}:
                return _deny(
                    category="CROSS_SCOPE_ACCESS_ATTEMPT",
                    severity="high",
                    decision="denied",
                    matched_rule=f"cross_tenant:{candidate}",
                    refusal_zh=f"安全边界已拦截跨租户访问请求：当前账号仅可访问租户 {actor.tenant} 的资源。",
                    refusal_hk=f"安全邊界已攔截跨租戶訪問請求：目前帳號僅可訪問租戶 {actor.tenant} 的資源。",
                    refusal_en=f"Cross-tenant access denied: your account is restricted to tenant '{actor.tenant}'.",
                )

    if _CROSS_TENANT_PHRASE_RE.search(compact):
        return _deny(
            category="CROSS_SCOPE_ACCESS_ATTEMPT",
            severity="high",
            decision="denied",
            matched_rule="cross_tenant_phrase",
            refusal_zh=f"安全边界已拦截跨租户查询：当前会话严格隔离在租户 {actor.tenant} 内。",
            refusal_hk=f"安全邊界已攔截跨租戶查詢：目前會話嚴格隔離在租戶 {actor.tenant} 內。",
            refusal_en=f"Cross-tenant query denied: data isolation is enforced strictly within tenant '{actor.tenant}'.",
        )

    actor_sites = {w.upper() for w in actor.warehouses}
    referenced_sites: set[str] = set()
    for match in _WAREHOUSE_TOKEN_RE.finditer(compact):
        referenced_sites.add(match.group(1).upper())
    for match in _WAREHOUSE_NAMED_EN_RE.finditer(compact):
        referenced_sites.add(match.group(1).upper())
    for match in _WAREHOUSE_NAMED_ZH_RE.finditer(compact):
        referenced_sites.add(match.group(1).upper())

    outside = sorted(site for site in referenced_sites if site not in actor_sites)
    if outside:
        target = ", ".join(outside)
        held = ", ".join(sorted(actor_sites)) or "none"
        return _deny(
            category="CROSS_SCOPE_ACCESS_ATTEMPT",
            severity="high",
            decision="denied",
            matched_rule=f"cross_warehouse:{target}",
            refusal_zh=f"权限范围限制：您仅获授权访问仓库 [{held}]，无法查询或操作仓库 [{target}]。",
            refusal_hk=f"權限範圍限制：您僅獲授權訪問倉庫 [{held}]，無法查詢或操作倉庫 [{target}]。",
            refusal_en=f"Warehouse scope denied: your account is only authorized for [{held}], not [{target}].",
        )

    if _CROSS_WAREHOUSE_PHRASE_RE.search(compact):
        held = ", ".join(sorted(actor_sites)) or "none"
        return _deny(
            category="CROSS_SCOPE_ACCESS_ATTEMPT",
            severity="high",
            decision="denied",
            matched_rule="cross_warehouse_phrase",
            refusal_zh=f"权限范围限制：当前账号仅能访问已授权仓库 [{held}]，不支持跨仓查询。",
            refusal_hk=f"權限範圍限制：目前帳號僅能訪問已授權倉庫 [{held}]，不支援跨倉查詢。",
            refusal_en=f"Cross-warehouse access denied: queries are restricted to your authorized warehouses [{held}].",
        )

    return None


def _check_unauthorized_module(actor: Actor, compact: str, offered_tools: tuple[str, ...]) -> GuardVerdict | None:
    offered = set(offered_tools)
    has_finance = bool(actor.sites_for("finance.read")) or ("finance.invoice.read" in offered)
    has_shipment_reschedule = bool(action_sites(actor, "shipment.reschedule")) or ("shipment.reschedule" in offered)
    has_shipment_read = bool(actor.sites_for("shipment.read")) or ("shipment.read" in offered)
    has_order_work = bool(action_sites(actor, "sales_order.create_draft")) or ("order.draft.prepare" in offered)
    has_order_read = bool(order_read_sites(actor)) or has_order_work
    has_decision = bool(actor.sites_for("decision.read")) or ("decision.warehouse.summary" in offered)
    has_approvals = (
        actor.role in {"manager", "admin"}
        and (
            bool(approval_sites(actor, "sales_order.create_draft"))
            or bool(approval_sites(actor, "shipment.reschedule"))
            or "approval.preview" in offered
        )
    )
    has_operations = actor.role in {"manager", "admin"} and "operations.manage" in actor.grants
    has_access_admin = actor.role == "admin" and "workbench.access.manage" in actor.grants

    # 1. Invoice / Finance review
    if not has_finance and re.search(
        r"(?i)(?:\b(?:invoices?|billing|accounts?\s+(?:payable|receivable)|financial\s+(?:data|report|record|summary)|INV-\d+)\b|"
        r"(?:发票|發票|账单|賬單|财务|財務|应收|應收|应付|應付|结算单|結算單|付款单|付款單|对账|對賬))",
        compact,
    ):
        return _deny(
            category="UNAUTHORIZED_MODULE_QUERY",
            severity="medium",
            decision="denied",
            module="invoice-review",
            action_attempted="finance.invoice.read",
            matched_rule="missing_grant:finance.read",
            refusal_zh="您当前账号缺少「发票审阅 (invoice-review / finance.read)」模块权限，无法查询发票或财务数据。如需开通，请联系权限管理员（access-admin）。",
            refusal_hk="您目前的帳號缺少「發票審閱 (invoice-review / finance.read)」模組權限，無法查詢發票或財務資料。如需開通，請聯絡權限管理員（access-admin）。",
            refusal_en="Your account lacks the 'invoice-review' (finance.read) permission required to access invoices or financial records. Please contact your access administrator.",
        )

    # 2. Shipment rescheduling (check before generic shipment read)
    if not has_shipment_reschedule and re.search(
        r"(?i)(?:\b(?:reschedule|postpone|delay|move|change|modify|update)\b.{0,25}\b(?:shipment|delivery\s+date|freight|SHP-\d+)\b|"
        r"\bchange\s+delivery\s+date\b|"
        r"(?:改期|延期|修改交期|更改交期|调整交期|調整交期|变更交期|變更交期|改到|调整运单|調整運單|修改运单|修改運單|改运单|改運單).{0,20}(?:运单|運單|交期|发货|發貨|SHP-\d+)?|"
        r"(?:运单|運單|SHP-\d+).{0,20}(?:改期|延期|改到|修改交期|更改交期))",
        compact,
    ):
        return _deny(
            category="UNAUTHORIZED_MODULE_QUERY",
            severity="medium",
            decision="denied",
            module="dispatch",
            action_attempted="shipment.reschedule",
            matched_rule="missing_grant:shipment.reschedule",
            refusal_zh="您当前账号缺少「运单改期 (dispatch / shipment.reschedule)」操作权限（需 operator 及以上角色及对应仓库授权），无法提交运单改期提案。",
            refusal_hk="您目前的帳號缺少「運單改期 (dispatch / shipment.reschedule)」操作權限（需 operator 及以上角色及對應倉庫授權），無法提交運單改期提案。",
            refusal_en="Your account lacks the 'dispatch' (shipment.reschedule) permission and required operator role/warehouse scope to reschedule shipments.",
        )

    # 3. Shipment read
    if not has_shipment_read and re.search(
        r"(?i)(?:\b(?:shipments?|SHP-\d+)\b|(?:运单|運單|物流单|物流單))",
        compact,
    ):
        return _deny(
            category="UNAUTHORIZED_MODULE_QUERY",
            severity="medium",
            decision="denied",
            module="dispatch",
            action_attempted="shipment.read",
            matched_rule="missing_grant:shipment.read",
            refusal_zh="您当前账号未获授「运单调度 (dispatch / shipment.read)」模块权限，无法查询运单状态。",
            refusal_hk="您目前的帳號未獲授「運單調度 (dispatch / shipment.read)」模組權限，無法查詢運單狀態。",
            refusal_en="Your account does not have the 'dispatch' (shipment.read) permission to view shipments.",
        )

    # 4. Order creation / work
    if not has_order_work and re.search(
        r"(?i)(?:\b(?:create|draft|prepare|submit|make|generate|new)\b.{0,25}\b(?:sales\s+order|order\s+draft|purchase\s+order|po\s+draft|intake)\b|"
        r"(?:创建|創建|起草|生成|制作|製作|提交|录入|錄入|开立|開立|新建).{0,20}(?:销售订单|銷售訂單|订单草稿|訂單草稿|销售草稿|銷售草稿|采购单|採購單|订单|訂單|接单|接單))",
        compact,
    ):
        return _deny(
            category="UNAUTHORIZED_MODULE_QUERY",
            severity="medium",
            decision="denied",
            module="orders",
            action_attempted="order.draft.prepare",
            matched_rule="missing_grant:order.work",
            refusal_zh="您当前账号缺少「销售订单录入 (orders / order.work)」权限，无法创建订单草稿或提交接单提案。",
            refusal_hk="您目前的帳號缺少「銷售訂單錄入 (orders / order.work)」權限，無法建立訂單草稿或提交接單提案。",
            refusal_en="Your account lacks the 'orders' (order.work) permission required to prepare or create sales order drafts.",
        )

    if not has_order_read and re.search(
        r"(?i)(?:(?:check|show|view|read|query|list)\b.{0,20}\b(?:sales\s+orders?|order\s+intakes?|purchase\s+orders?)\b|"
        r"(?:查看|查询|查詢|看下).{0,15}(?:销售订单|銷售訂單|订单|訂單|PO单|採購單))",
        compact,
    ):
        return _deny(
            category="UNAUTHORIZED_MODULE_QUERY",
            severity="medium",
            decision="denied",
            module="orders",
            action_attempted="order.read",
            matched_rule="missing_grant:order.read",
            refusal_zh="您当前账号缺少「订单查看 (orders / order.read)」权限，无法查阅订单记录。",
            refusal_hk="您目前的帳號缺少「訂單查看 (orders / order.read)」權限，無法查閱訂單記錄。",
            refusal_en="Your account lacks the 'orders' (order.read) permission required to inspect order records.",
        )

    # 5. Warehouse insights / decision summary
    if not has_decision and re.search(
        r"(?i)(?:\b(?:warehouse\s+(?:summary|analytics|insights?|kpi|metrics?|stats|statistics|report|overview)|"
        r"operational\s+analytics|decision\s+summary|open\s+shipments?\s+(?:count|summary|report))\b|"
        r"(?:仓库汇总|倉庫匯總|仓库统计|倉庫統計|仓库分析|倉庫分析|仓储洞察|倉儲洞察|仓储分析|倉儲分析|"
        r"运营指标|運營指標|运营报表|運營報表|仓库概况|倉庫概況|仓库数据汇总|倉庫數據匯總|决策汇总|決策匯總))",
        compact,
    ):
        return _deny(
            category="UNAUTHORIZED_MODULE_QUERY",
            severity="medium",
            decision="denied",
            module="warehouse-insights",
            action_attempted="decision.warehouse.summary",
            matched_rule="missing_grant:decision.read",
            refusal_zh="您当前账号缺少「仓储决策分析 (warehouse-insights / decision.read)」权限，无法查看仓库统计汇总。",
            refusal_hk="您目前的帳號缺少「倉儲決策分析 (warehouse-insights / decision.read)」權限，無法查看倉庫統計匯總。",
            refusal_en="Your account lacks the 'warehouse-insights' (decision.read) permission required to view warehouse summaries and analytics.",
        )

    # 6. Approvals (requires manager/admin role + approval sites)
    if not has_approvals and re.search(
        r"(?i)(?:\b(?:approve|reject|return|sign\s+off|review\s+and\s+approve)\b.{0,25}"
        r"\b(?:proposal|proposals|PROP-|request|order\s+draft|reschedule)\b|"
        r"\b(?:show|open|list|check|view)\b.{0,20}\b(?:approval\s+queue|approvals\s+to\s+review|pending\s+approvals)\b|"
        r"(?:批准|审批|審批|批复|批覆|驳回|駁回|退回|审核|審核).{0,20}(?:提案|审批单|審批單|申请|申請|草稿|改期)|"
        r"(?:查看|打开|打開|处理|處理|进入|進入).{0,15}(?:审批队列|審批隊列|待审批|待審批|审批中心|審批中心))",
        compact,
    ):
        return _deny(
            category="UNAUTHORIZED_MODULE_QUERY",
            severity="medium",
            decision="denied",
            module="approvals",
            action_attempted="proposal.approve",
            matched_rule="missing_role_or_grant:approvals",
            refusal_zh="审批与驳回提案需要「主管或管理员角色 (manager/admin)」及「独立审批 (approvals)」权限，您当前账号无法执行或代理审批操作。",
            refusal_hk="審批與駁回提案需要「主管或管理員角色 (manager/admin)」及「獨立審批 (approvals)」權限，您目前的帳號無法執行或代理審批操作。",
            refusal_en="Proposal approval and review require a 'manager' or 'admin' role with the 'approvals' module permission.",
        )

    # 7. Operations management (exceptions, suspension, write-pause, governance, security alerts)
    if not has_operations and re.search(
        r"(?i)(?:\b(?:exception\s+queue|operational\s+exceptions?|worker\s+exceptions?|reconcile\s+proposal|"
        r"suspend\s+(?:user|employee|subject|account)|write[- ]?pause|pause\s+writes|resume\s+writes|"
        r"write\s+control|security\s+(?:events?|incidents?|alerts?)|prompt\s+polic(?:y|ies))\b|"
        r"(?:异常队列|異常隊列|异常处理|異常處理|人工复核异常|人工覆核異常|暂停写入|暫停寫入|恢复写入|恢復寫入|"
        r"全局写控制|全局寫控制|停用账号|停用帳號|冻结员工|凍結員工|恢复账号|恢復帳號|安全事件|安全告警|提示词治理|提示詞治理|治理策略))",
        compact,
    ):
        return _deny(
            category="UNAUTHORIZED_MODULE_QUERY",
            severity="medium",
            decision="denied",
            module="operations",
            action_attempted="operations.manage",
            matched_rule="missing_grant:operations.manage",
            refusal_zh="此运维治理功能 (operations) 需要「运维管理 (operations.manage)」权限及主管/管理员角色，您当前账号无权访问。",
            refusal_hk="此運維治理功能 (operations) 需要「運維管理 (operations.manage)」權限及主管/管理員角色，您目前的帳號無權訪問。",
            refusal_en="Operational controls, exceptions, and security governance ('operations') require the 'operations.manage' permission and manager/admin role.",
        )

    # 8. People / module access administration
    if not has_access_admin and re.search(
        r"(?i)(?:\b(?:manage\s+(?:employee|people|user)\s+(?:access|permissions?|modules?|grants?)|"
        r"assign\s+module\s+(?:access|grants?)|revoke\s+(?:employee|module)\s+access|"
        r"access\s+admin(?:istration)?|people\s+permissions?)\b|"
        r"(?:管理员工权限|管理員工權限|员工模块授权|員工模組授權|分配模块权限|分配模組權限|撤销模块权限|撤銷模組權限|"
        r"权限分配|權限分配|人员权限管理|人員權限管理|成员授权|成員授權))",
        compact,
    ):
        return _deny(
            category="UNAUTHORIZED_MODULE_QUERY",
            severity="medium",
            decision="denied",
            module="access-admin",
            action_attempted="workbench.access.manage",
            matched_rule="missing_grant:workbench.access.manage",
            refusal_zh="人员模块授权管理 (access-admin) 需要「管理员角色 (admin)」及「权限治理 (workbench.access.manage)」授权。",
            refusal_hk="人員模組授權管理 (access-admin) 需要「管理員角色 (admin)」及「權限治理 (workbench.access.manage)」授權。",
            refusal_en="Employee module access administration ('access-admin') requires the 'admin' role and 'workbench.access.manage' permission.",
        )

    return None


def evaluate_user_turn(actor: Actor, text: str, offered_tools: tuple[str, ...] = ()) -> GuardVerdict:
    raw_clean, compact = normalize_user_text(text)
    if not compact:
        return _allow()

    # 1. Skill / plugin / self-modification attempts
    for rule_name, pattern in _SKILL_TAMPER_PATTERNS:
        if pattern.search(compact):
            return _deny(
                category="SKILL_TAMPER_ATTEMPT",
                severity="critical",
                decision="blocked",
                matched_rule=rule_name,
                refusal_zh="安全策略已拦截：对话端严禁安装、修改、注册或覆盖技能 (SKILL.md)、插件、工具定义或系统提示词配置。",
                refusal_hk="安全策略已攔截：對話端嚴禁安裝、修改、註冊或覆蓋技能 (SKILL.md)、外掛、工具定義或系統提示詞設定。",
                refusal_en="Blocked by security policy: modifying, installing, or registering skills (SKILL.md), plugins, agent tools, or system configuration from chat is prohibited.",
            )

    # 1b. Sealed SOUL.md / system & module directive modification attempts (applies to ALL roles including admin)
    for rule_name, pattern in _PROMPT_TAMPER_PATTERNS:
        if pattern.search(compact):
            return _deny(
                category="PROMPT_TAMPER_ATTEMPT",
                severity="high",
                decision="blocked",
                matched_rule=rule_name,
                refusal_zh="安全策略已拦截：SOUL.md 及通用/模块系统指令已密封锁定，任何用户或管理员均不可通过对话修改、覆盖、追加或重置。",
                refusal_hk="安全策略已攔截：SOUL.md 及通用/模組系統指令已密封鎖定，任何用戶或管理員均不可透過對話修改、覆蓋、追加或重置。",
                refusal_en="Blocked by security policy: SOUL.md and system/module directives are sealed by the Theodic core team and cannot be edited, overwritten, appended to, or reset.",
            )

    # 2. Destructive SQL / shell / record-wipe attempts
    for rule_name, pattern in _DESTRUCTIVE_PATTERNS:
        if pattern.search(compact):
            return _deny(
                category="DESTRUCTIVE_ACTION_ATTEMPT",
                severity="critical",
                decision="blocked",
                matched_rule=rule_name,
                refusal_zh="安全策略已拦截：严禁删除、清空、截断或破坏数据库表、订单、提案或不可变审计日志。",
                refusal_hk="安全策略已攔截：嚴禁刪除、清空、截斷或破壞數據庫表、訂單、提案或不可變審計日誌。",
                refusal_en="Blocked by security policy: dropping, deleting, truncating, or wiping database tables, business records, or immutable audit logs is prohibited.",
            )

    # 3. Email policy violations in chat turn (CRLF, spam/phishing, external secret/dump emailing)
    if _EMAIL_CRLF_TURN_RE.search(raw_clean) or _EMAIL_CRLF_TURN_RE.search(compact):
        return _deny(
            category="EMAIL_POLICY_VIOLATION",
            severity="high",
            decision="blocked",
            module="mail-outbox",
            action_attempted="email.send",
            matched_rule="email_crlf_injection",
            refusal_zh="邮件安全策略已拦截：检测到邮件头换行符 (CRLF) 或伪造邮件头注入风险。",
            refusal_hk="郵件安全策略已攔截：偵測到郵件頭換行符 (CRLF) 或偽造郵件頭注入風險。",
            refusal_en="Blocked by email policy: CRLF or email header injection sequences are not permitted.",
        )
    if _EMAIL_SPAM_PHISHING_RE.search(compact) or len(_EMAIL_ADDR_RE.findall(compact)) > 10:
        return _deny(
            category="EMAIL_POLICY_VIOLATION",
            severity="high",
            decision="blocked",
            module="mail-outbox",
            action_attempted="email.send",
            matched_rule="email_bulk_or_phishing",
            refusal_zh="邮件安全策略已拦截：禁止群发垃圾邮件、钓鱼仿冒或单次向超过 10 个收件人批量发信。",
            refusal_hk="郵件安全策略已攔截：禁止群發垃圾郵件、釣魚仿冒或單次向超過 10 個收件人批量發信。",
            refusal_en="Blocked by email policy: bulk spam, phishing content, or exceeding 10 total recipients is prohibited.",
        )
    if _EMAIL_EXFIL_RE.search(compact):
        return _deny(
            category="EMAIL_POLICY_VIOLATION",
            severity="high",
            decision="blocked",
            module="mail-outbox",
            action_attempted="email.send",
            matched_rule="email_secret_or_dump_exfil",
            refusal_zh="邮件安全策略已拦截：严禁通过邮件外发 API 密钥、访问凭据、环境变量或数据库导出文件。",
            refusal_hk="郵件安全策略已攔截：嚴禁透過郵件外發 API 密鑰、訪問憑證、環境變數或數據庫導出檔案。",
            refusal_en="Blocked by email policy: sending API keys, credentials, or raw database dumps via email is strictly prohibited.",
        )

    # 4. Filesystem escape & server command execution attempts
    for rule_name, pattern in _FILESYSTEM_ESCAPE_PATTERNS:
        if pattern.search(compact):
            return _deny(
                category="FILESYSTEM_ESCAPE_ATTEMPT",
                severity="critical",
                decision="blocked",
                matched_rule=rule_name,
                refusal_zh="安全策略已拦截：严禁访问服务器文件系统（如 /etc/aios、.env、.sqlite 或密钥文件）或执行终端/网络命令。",
                refusal_hk="安全策略已攔截：嚴禁訪問伺服器檔案系統（如 /etc/aios、.env、.sqlite 或密鑰檔案）或執行終端/網路命令。",
                refusal_en="Blocked by security policy: reading server files (/etc/aios, .env, .sqlite, pass files) or executing shell/network commands is prohibited.",
            )

    # 5. Secret / credential exfiltration attempts
    for rule_name, pattern in _SECRET_EXFIL_PATTERNS:
        if pattern.search(compact):
            return _deny(
                category="SECRET_EXFILTRATION_ATTEMPT",
                severity="critical",
                decision="blocked",
                matched_rule=rule_name,
                refusal_zh="安全策略已拦截：严禁索取、导出或泄露 API 密钥、签名私钥、会话 Cookie、Bearer 令牌或密码。",
                refusal_hk="安全策略已攔截：嚴禁索取、導出或洩露 API 密鑰、簽名私鑰、會話 Cookie、Bearer 令牌或密碼。",
                refusal_en="Blocked by security policy: requesting, exporting, or revealing API keys, session cookies, bearer tokens, signing keys, or passwords is prohibited.",
            )

    # 6. Prompt injection & jailbreak attempts
    for rule_name, pattern in _PROMPT_INJECTION_PATTERNS:
        if pattern.search(compact):
            return _deny(
                category="PROMPT_INJECTION_ATTEMPT",
                severity="high",
                decision="blocked",
                matched_rule=rule_name,
                refusal_zh="安全策略已拦截：检测到越狱或提示词注入尝试，系统内置安全约束与权限边界不可被覆盖或泄露。",
                refusal_hk="安全策略已攔截：偵測到越獄或提示詞注入嘗試，系統內置安全約束與權限邊界不可被覆蓋或洩露。",
                refusal_en="Blocked by security policy: prompt injection or jailbreak instructions cannot override platform guardrails or reveal internal instructions.",
            )

    # 7. Privilege escalation & SoD / audit bypass attempts
    for rule_name, pattern in _PRIVILEGE_ESCALATION_PATTERNS:
        if pattern.search(compact):
            return _deny(
                category="PRIVILEGE_ESCALATION_ATTEMPT",
                severity="high",
                decision="blocked",
                matched_rule=rule_name,
                refusal_zh="安全策略已拦截：严禁通过对话提权、绕过职责分离 (SoD) 审批自己的提案、停用管理员或关闭审计/写入保护。",
                refusal_hk="安全策略已攔截：嚴禁透過對話提權、繞過職責分離 (SoD) 審批自己的提案、停用管理員或關閉審計/寫入保護。",
                refusal_en="Blocked by security policy: self-elevation, self-approval (SoD bypass), suspending admins, or disabling audit/write controls is prohibited.",
            )

    # 8. Cross-tenant & cross-warehouse access attempts
    cross_scope = _check_cross_scope(actor, compact)
    if cross_scope is not None:
        return cross_scope

    # 9. Natural-language queries to modules/roles outside actor's current permissions
    unauth = _check_unauthorized_module(actor, compact, offered_tools)
    if unauth is not None:
        return unauth

    return _allow()


def evaluate_email_payload(
    actor: Actor,
    recipients: list[str],
    cc: list[str],
    subject_line: str,
    body: str,
) -> GuardVerdict:
    header_fields = [*recipients, *cc, subject_line]
    for value in header_fields:
        nfkc = unicodedata.normalize("NFKC", value)
        if re.search(r"[\r\n\x00]|%0[da]", nfkc, re.IGNORECASE):
            return _deny(
                category="EMAIL_POLICY_VIOLATION",
                severity="high",
                decision="blocked",
                module="mail-outbox",
                action_attempted="email.send",
                matched_rule="email_header_crlf",
                refusal_zh="邮件被拦截：收件人或主题中包含非法的换行/控制字符（防 CRLF 邮件头注入）。",
                refusal_hk="郵件被攔截：收件人或主題中包含非法的換行/控制字元（防 CRLF 郵件頭注入）。",
                refusal_en="Email blocked: recipient and subject headers must not contain CR/LF or control characters.",
            )

    total_recipients = len(recipients) + len(cc)
    if total_recipients == 0 or total_recipients > 10:
        return _deny(
            category="EMAIL_POLICY_VIOLATION",
            severity="high",
            decision="blocked",
            module="mail-outbox",
            action_attempted="email.send",
            matched_rule="email_recipient_limit",
            refusal_zh="邮件被拦截：单封邮件收件人与抄送人总数需在 1 至 10 人之间。",
            refusal_hk="郵件被攔截：單封郵件收件人與副本收件人總數需在 1 至 10 人之間。",
            refusal_en="Email blocked: total recipients plus CC must be between 1 and 10.",
        )

    combined = f"{subject_line}\n{body}"
    nfkc_combined, _ = normalize_user_text(combined)
    if (
        scrub_secrets(nfkc_combined) != nfkc_combined
        or re.search(
            r"\b(?:DEEPSEEK_API_KEY|AIOS_LLM_API_KEY|AIOS_DEMO_SECRET|AIOS_BROWSER_SESSION_KEY|"
            r"__Host-aios_session|__Host-aios_gate)\b",
            nfkc_combined,
        )
    ):
        return _deny(
            category="EMAIL_POLICY_VIOLATION",
            severity="high",
            decision="blocked",
            module="mail-outbox",
            action_attempted="email.send",
            matched_rule="email_secret_leakage",
            refusal_zh="邮件被拦截：正文或主题检测到疑似密钥、令牌或内部凭据，已阻止外发。",
            refusal_hk="郵件被攔截：內文或主題偵測到疑似密鑰、令牌或內部憑證，已阻止外發。",
            refusal_en="Email blocked: potential API key, token, passcode, or credential detected in email content.",
        )

    return _allow()


_FS_PATH_LEAK_RE = re.compile(
    r"(?:(?:/etc/aios|/var/lib/aios|/opt/aios|/Users/|/home/|/root/|/proc/)[A-Za-z0-9._/\-]*|"
    r"[A-Za-z0-9._/\-]*\.reviewer-pass\.local\.json|"
    r"[A-Za-z0-9._/\-]*\.(?:sqlite|sqlite3)\b|"
    r"(?<![A-Za-z0-9_-])\.env(?:\.[A-Za-z0-9_-]+)?\b)"
)

_SOUL_ANCHOR_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)you['’\u2019]re\s+not\s+a\s+chatbot\.?"),
    re.compile(r"(?i)becoming\s+someone\.?"),
    re.compile(r"(?i)this\s+is\s+your\s+persona,?\s+yours\s+to\s+grow\s+into(?:\s+and\s+edit\s+over\s+time)?\.?"),
    re.compile(r"(?i)some\s+starting\s+truths\s*:?"),
    re.compile(r"(?i)be\s+genuinely\s+helpful,?\s+not\s+performatively\s+helpful\.?"),
    re.compile(r"(?i)performatively\s+helpful"),
    re.compile(r"(?i)skip\s+[\"“']?great\s+question!?[\"”']?\s+and\s+[\"“']?i['’\u2019]d\s+be\s+happy\s+to\s+help!?[\"”']?"),
    re.compile(r"(?i)personality\s+beats\s+a\s+search\s+engine(?:\s+with\s+extra\s+steps)?\.?"),
    re.compile(r"(?i)be\s+resourceful\s+before\s+asking\.?"),
    re.compile(r"(?i)come\s+back\s+with\s+answers,?\s+not\s+questions(?:,?\s+then\s+ask\s+if\s+you['’\u2019]re\s+truly\s+stuck)?\.?"),
    re.compile(r"(?i)(?:you['’\u2019]re\s+a\s+)?guest\s+in\s+someone['’\u2019]s\s+life\.?"),
    re.compile(r"(?i)treat\s+that\s+access\s+with\s+care,?\s+and\s+never\s+be\s+preachy\.?"),
    re.compile(r"(?i)\[sealed\s+persona\s+soul\]"),
    re.compile(r"(?i)\bsoul\.md\b"),
    re.compile(r"(?i)denied\s+modules\s*\(strictly\s+inaccessible\)"),
    re.compile(r"(?i)live\s+pendingworksnapshot"),
)


def _soul_line_patterns() -> tuple[re.Pattern[str], ...]:
    soul_file = Path(__file__).with_name("SOUL.md")
    if not soul_file.is_file():
        return ()
    patterns: list[re.Pattern[str]] = []
    for raw_line in soul_file.read_text(encoding="utf-8").splitlines():
        line = re.sub(r"\s+", " ", raw_line).strip()
        if len(line) < 20:
            continue
        escaped = re.escape(line).replace(r"\ ", r"\s+").replace("'", r"['’\u2019]")
        patterns.append(re.compile(escaped, re.IGNORECASE))
    return tuple(patterns)


def _compile_flexible_phrase_pattern(phrase: str) -> re.Pattern[str]:
    escaped = re.escape(phrase).replace(r"\ ", r"\s+").replace("'", r"['’\u2019]")
    return re.compile(escaped, re.IGNORECASE)


def check_output_leakage(reply: str, directives: list[str]) -> str:
    if not reply:
        return ""
    sanitized = scrub_secrets(reply)
    sanitized = _FS_PATH_LEAK_RE.sub("[REDACTED_PATH]", sanitized)

    for pattern in (*_SOUL_ANCHOR_PATTERNS, *_soul_line_patterns()):
        sanitized = pattern.sub("[REDACTED_POLICY]", sanitized)

    for raw_directive in directives:
        if not raw_directive:
            continue
        candidate = raw_directive.strip()
        if len(candidate) >= 24 and candidate in sanitized:
            sanitized = sanitized.replace(candidate, "[REDACTED_POLICY]")
        compact_candidate = re.sub(r"\s+", " ", candidate)
        if len(compact_candidate) >= 24:
            sanitized = _compile_flexible_phrase_pattern(compact_candidate).sub("[REDACTED_POLICY]", sanitized)
        for line in candidate.splitlines():
            clean_line = re.sub(r"\s+", " ", line).strip()
            if len(clean_line) >= 24:
                sanitized = _compile_flexible_phrase_pattern(clean_line).sub("[REDACTED_POLICY]", sanitized)
            for clause in re.split(r"(?<=[.!?])\s+|;\s+", clean_line):
                clean_clause = clause.strip()
                if len(clean_clause) >= 28:
                    sanitized = _compile_flexible_phrase_pattern(clean_clause).sub("[REDACTED_POLICY]", sanitized)

    return sanitized
