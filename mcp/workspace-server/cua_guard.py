"""Controlled cross-platform CUA gate, three-tier classifier, PII scrubber, and prompt-injection sanitizer."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import hmac
import importlib.util
import re
import secrets
import time
from typing import Any
import unicodedata


class ActionTier(str, Enum):
    GREEN = "GREEN"
    YELLOW = "YELLOW"
    RED = "RED"


class CuaPolicyViolation(PermissionError):
    """Raised when a CUA request violates work-app allowlist, window-only capture, or confirmation policy."""

    def __init__(self, code: str, message: str, *, tier: ActionTier | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.tier = tier


class ConfirmationRequiredError(CuaPolicyViolation):
    """Raised when a RED-tier CUA action is attempted without explicit human confirmation."""

    def __init__(self, message: str, *, action: str, tier: ActionTier = ActionTier.RED) -> None:
        super().__init__("CONFIRMATION_REQUIRED", message, tier=tier)
        self.action = action
        self.requires_confirmation = True


@dataclass(frozen=True)
class WindowTarget:
    """Explicit single-window target for macOS AX or Windows UIA automation."""

    app_id: str
    title: str
    pid: int
    os_platform: str = "auto"

    def __post_init__(self) -> None:
        if not self.app_id or not self.app_id.strip():
            raise ValueError("WindowTarget.app_id is required.")
        if not self.title or not self.title.strip():
            raise ValueError("WindowTarget.title is required.")
        if not isinstance(self.pid, int) or isinstance(self.pid, bool) or self.pid <= 0:
            raise ValueError("WindowTarget.pid must be a positive integer.")


MACOS_WORK_APP_ALLOWLIST = frozenset({
    "com.microsoft.word",
    "com.microsoft.excel",
    "com.microsoft.powerpoint",
    "com.microsoft.outlook",
    "com.apple.safari",
    "com.google.chrome",
    "com.microsoft.edgemac",
    "com.kingsoft.wpsoffice",
    "com.kingsoft.wpsoffice.mac",
    "com.apple.iwork.pages",
    "com.apple.iwork.numbers",
    "com.apple.iwork.keynote",
    "com.apple.preview",
    "com.apple.textedit",
    "com.tencent.weworkmac",
    "com.electron.lark",
    "com.alibaba.dingtalkmac",
    "com.theodic.aios.desktop",
})

WINDOWS_WORK_APP_ALLOWLIST = frozenset({
    "winword.exe",
    "excel.exe",
    "powerpnt.exe",
    "outlook.exe",
    "chrome.exe",
    "msedge.exe",
    "wps.exe",
    "et.exe",
    "wpp.exe",
    "wxwork.exe",
    "feishu.exe",
    "lark.exe",
    "dingtalk.exe",
    "acrobat.exe",
    "notepad.exe",
    "theodic_aios_desktop.exe",
})

_NON_WORK_APP_DENYLIST = frozenset({
    "com.valvesoftware.steam",
    "steam.exe",
    "com.spotify.client",
    "spotify.exe",
    "com.hnc.discord",
    "discord.exe",
    "com.zhiliaoapp.musically",
    "douyin.exe",
    "com.ss.iphone.ugc.aweme",
    "tv.danmaku.bili",
    "bilibili.exe",
    "com.netflix.netflix",
    "com.epicgames.epicgameslauncher",
    "epicgameslauncher.exe",
    "com.roblox.robloxplayer",
    "robloxplayerbeta.exe",
    "tv.twitch.studio",
})

_NON_WORK_TITLE_KEYWORDS = (
    "steam store",
    "spotify",
    "netflix",
    "tiktok",
    "douyin",
    "bilibili",
    "twitch",
    "valorant",
    "genshin",
    "league of legends",
)

_GREEN_ACTIONS = frozenset({
    "read_window_tree",
    "capture_window_snapshot",
    "inspect_window",
    "inspect_document",
    "read_workspace_file",
    "list_files",
    "scroll",
    "focus_window",
    "extract_table",
    "get_status",
})

_YELLOW_ACTIONS = frozenset({
    "write_workspace_draft",
    "build_docx_draft",
    "build_pptx_draft",
    "build_xlsx_draft",
    "render_preview",
    "type_draft_text",
    "fill_local_form_draft",
    "click_local_ui",
    "select_tab",
})

_RED_ACTIONS = frozenset({
    "send_email",
    "send_message",
    "outbound_send",
    "submit_external_form",
    "submit_form",
    "payment_transfer",
    "approve_payment",
    "wire_transfer",
    "checkout",
    "delete_file",
    "delete_record",
    "execute_shell",
    "run_command",
    "grant_permission",
    "upload_external",
})

_RED_TARGET_LABEL_RE = re.compile(
    r"(?i)(?:\b(?:send|submit|pay|payment|transfer|wire|checkout|delete|erase|drop|"
    r"publish|post\s+publicly|confirm\s+order|execute\s+shell|run\s+command|upload\s+external)\b|"
    r"发送|發送|提交|付款|支付|转账|轉帳|删除|刪除|确认下单|確認下單|外发|外發)"
)


def classify_action(
    action: str,
    *,
    target_label: str = "",
    args: dict[str, Any] | None = None,
) -> ActionTier:
    """Classify a CUA/workspace action into GREEN (read-only), YELLOW (local draft), or RED (confirmed)."""
    norm = action.strip().lower()
    if norm in _RED_ACTIONS:
        return ActionTier.RED
    if _RED_TARGET_LABEL_RE.search(target_label or ""):
        return ActionTier.RED
    if args:
        arg_summary = " ".join(str(v) for v in args.values() if isinstance(v, (str, int, float)))
        if _RED_TARGET_LABEL_RE.search(arg_summary):
            return ActionTier.RED
    if norm in _GREEN_ACTIONS:
        return ActionTier.GREEN
    if norm in _YELLOW_ACTIONS:
        return ActionTier.YELLOW
    # Fail-closed: unknown CUA verbs escalate to RED confirmation.
    return ActionTier.RED


def check_window_target(
    target: WindowTarget,
    *,
    full_screen_capture: bool = False,
) -> None:
    """Enforce single-window capture and dual-OS work-app allowlisting."""
    if full_screen_capture:
        raise CuaPolicyViolation(
            "FULL_SCREEN_CAPTURE_FORBIDDEN",
            "Full-screen capture is strictly prohibited; CUA must target a single allowlisted window.",
        )

    app_norm = target.app_id.strip().lower()
    title_norm = target.title.strip().lower()

    if app_norm in _NON_WORK_APP_DENYLIST or any(
        bad in app_norm for bad in ("steam", "spotify", "netflix", "tiktok", "douyin", "bilibili", "discord", "roblox")
    ):
        raise CuaPolicyViolation(
            "NON_WORK_APP_BLOCKED",
            f"Non-work application is blocked from CUA automation: {target.app_id}",
        )

    if app_norm not in MACOS_WORK_APP_ALLOWLIST and app_norm not in WINDOWS_WORK_APP_ALLOWLIST:
        raise CuaPolicyViolation(
            "APP_NOT_ALLOWLISTED",
            f"Application is not in the macOS AX / Windows UIA work allowlist: {target.app_id}",
        )

    if any(kw in title_norm for kw in _NON_WORK_TITLE_KEYWORDS):
        raise CuaPolicyViolation(
            "NON_WORK_WINDOW_TITLE_BLOCKED",
            f"Window title matches non-work entertainment/gaming content: {target.title}",
        )


@dataclass
class ConfirmationChallenge:
    challenge_id: str
    action: str
    app_id: str
    pid: int
    summary: str
    expires_at: float
    approved: bool = False
    approver: str | None = None
    confirm_token: str | None = None
    consumed: bool = False


@dataclass(frozen=True)
class CuaAuthorizationResult:
    allowed: bool
    tier: ActionTier
    action: str
    target: WindowTarget
    requires_confirmation: bool
    confirmed_by: str | None = None


class CuaPolicyEngine:
    """Policy engine enforcing work-app allowlist, window-only capture, 3-tier gating, and human confirmation."""

    def __init__(self, *, signing_secret: bytes | None = None) -> None:
        self._signing_secret = signing_secret or secrets.token_bytes(32)
        self._challenges: dict[str, ConfirmationChallenge] = {}
        self._tokens: dict[str, ConfirmationChallenge] = {}

    def _compute_token(self, challenge_id: str, action: str, app_id: str, pid: int) -> str:
        msg = f"{challenge_id}|{action.lower()}|{app_id.lower()}|{pid}".encode("utf-8")
        digest = hmac.new(self._signing_secret, msg, hashlib.sha256).hexdigest()
        return f"cua_ok_{challenge_id}_{digest[:24]}"

    def request_confirmation(
        self,
        action: str,
        target: WindowTarget,
        *,
        summary: str = "",
        ttl_seconds: int = 300,
    ) -> ConfirmationChallenge:
        check_window_target(target, full_screen_capture=False)
        cid = f"chg-{secrets.token_hex(8)}"
        challenge = ConfirmationChallenge(
            challenge_id=cid,
            action=action.strip().lower(),
            app_id=target.app_id.strip().lower(),
            pid=target.pid,
            summary=summary.strip()[:280] or f"Confirm {action} on {target.title}",
            expires_at=time.monotonic() + max(10, min(ttl_seconds, 900)),
        )
        self._challenges[cid] = challenge
        return challenge

    def approve_confirmation(
        self,
        challenge_id: str,
        *,
        approver: str = "human-operator",
    ) -> str:
        challenge = self._challenges.get(challenge_id)
        if challenge is None:
            raise CuaPolicyViolation("CONFIRMATION_NOT_FOUND", f"Unknown confirmation challenge: {challenge_id}")
        if time.monotonic() > challenge.expires_at:
            raise CuaPolicyViolation("CONFIRMATION_EXPIRED", "Confirmation challenge has expired.")
        if challenge.consumed:
            raise CuaPolicyViolation("CONFIRMATION_REUSED", "Confirmation challenge already consumed.")
        token = self._compute_token(
            challenge.challenge_id,
            challenge.action,
            challenge.app_id,
            challenge.pid,
        )
        challenge.approved = True
        challenge.approver = approver.strip() or "human-operator"
        challenge.confirm_token = token
        self._tokens[token] = challenge
        return token

    def issue_confirmation_token(
        self,
        action: str,
        target: WindowTarget,
        *,
        approver: str = "human-operator",
        summary: str = "",
        ttl_seconds: int = 300,
    ) -> str:
        challenge = self.request_confirmation(
            action,
            target,
            summary=summary,
            ttl_seconds=ttl_seconds,
        )
        return self.approve_confirmation(challenge.challenge_id, approver=approver)

    def authorize_action(
        self,
        action: str,
        target: WindowTarget,
        *,
        full_screen_capture: bool = False,
        target_label: str = "",
        args: dict[str, Any] | None = None,
        confirm_token: str | None = None,
    ) -> CuaAuthorizationResult:
        check_window_target(target, full_screen_capture=full_screen_capture)
        tier = classify_action(action, target_label=target_label, args=args)

        if tier in (ActionTier.GREEN, ActionTier.YELLOW):
            return CuaAuthorizationResult(
                allowed=True,
                tier=tier,
                action=action,
                target=target,
                requires_confirmation=False,
            )

        # RED-tier enforcement: require single-use valid human confirmation token.
        token = (confirm_token or "").strip()
        if not token:
            raise ConfirmationRequiredError(
                f"RED-tier action '{action}' on '{target.title}' requires explicit human confirm_token.",
                action=action,
                tier=tier,
            )

        challenge = self._tokens.get(token)
        if challenge is None or not challenge.approved or not challenge.confirm_token:
            raise ConfirmationRequiredError(
                f"Invalid or unrecognized confirm_token for RED-tier action '{action}'.",
                action=action,
                tier=tier,
            )
        if challenge.consumed:
            raise ConfirmationRequiredError(
                "Confirmation token has already been consumed (single-use enforced).",
                action=action,
                tier=tier,
            )
        if time.monotonic() > challenge.expires_at:
            raise ConfirmationRequiredError(
                "Confirmation token has expired; request fresh human confirmation.",
                action=action,
                tier=tier,
            )
        if (
            challenge.action != action.strip().lower()
            or challenge.app_id != target.app_id.strip().lower()
            or challenge.pid != target.pid
            or not hmac.compare_digest(challenge.confirm_token, token)
        ):
            raise ConfirmationRequiredError(
                "Confirmation token does not match this action or target window.",
                action=action,
                tier=tier,
            )

        challenge.consumed = True
        return CuaAuthorizationResult(
            allowed=True,
            tier=tier,
            action=action,
            target=target,
            requires_confirmation=True,
            confirmed_by=challenge.approver,
        )


# --- Pre-Redaction PII & Secret Scrubber ---

_PEM_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.IGNORECASE,
)
_COOKIE_RE = re.compile(
    r"(?i)\b(?:__Host-aios_session|__Host-aios_gate|aios_demo_session|sessionid|"
    r"Cookie|Set-Cookie)\s*[:=]\s*[^\s;,'\"]+(?:;\s*[^\r\n]*)?"
)
_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
_API_KEY_RE = re.compile(
    r"(?<![A-Za-z0-9_-])(?:sk-(?:ant-|proj-)?[A-Za-z0-9._-]{10,}|"
    r"AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|"
    r"xox[baprs]-[A-Za-z0-9-]{10,})(?![A-Za-z0-9_-])"
)
_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}")
_KV_SECRET_RE = re.compile(
    r"(?i)(\b(?:password|passwd|pwd|api[_-]?key|secret[_-]?key|secret|"
    r"access[_-]?token|refresh[_-]?token|private[_-]?key)\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"
)
_ZH_SECRET_RE = re.compile(r"((?:密码|密碼|密钥|密鑰|口令)\s*[:：=]\s*)([^\s,;，；]+)")
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_SSN_RE = re.compile(r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b")
_CN_ID_RE = re.compile(
    r"\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b"
)
_HKID_RE = re.compile(r"\b[A-Z]{1,2}\d{6}\([0-9A]\)(?![A-Za-z0-9])")
_CARD_RE = re.compile(r"\b(?:4\d{3}|5[1-5]\d{2}|6011|62\d{2}|3[47]\d{2})(?:[-\s]?\d{4}){2,3}\b")
_PHONE_RE = re.compile(
    r"(?:\+\d{1,3}[-\s]?(?:\(?\d{2,4}\)?[-\s]?){1,3}\d{4}|"
    r"\(\d{3}\)\s?\d{3}[-\s]?\d{4}|"
    r"(?<!\d)1[3-9]\d{9}(?!\d)|"
    r"\b\d{3}-\d{3}-\d{4}\b)"
)

_PRESIDIO_CACHE: Any = None


def _try_presidio_analyzer():
    global _PRESIDIO_CACHE
    if _PRESIDIO_CACHE is not None:
        return _PRESIDIO_CACHE or None
    if importlib.util.find_spec("presidio_analyzer") is None:
        _PRESIDIO_CACHE = False
        return None
    try:
        from presidio_analyzer import AnalyzerEngine  # type: ignore[import-not-found]

        _PRESIDIO_CACHE = AnalyzerEngine()
        return _PRESIDIO_CACHE
    except Exception:
        _PRESIDIO_CACHE = False
        return None


def redact_screen_text_detailed(text: str) -> dict[str, Any]:
    """Scrub PII and secret material before captured screen/DOM text leaves the local workstation."""
    if not text:
        return {"redacted_text": "", "redactions": {}, "presidio_active": False}

    redactions: dict[str, int] = {}

    def _sub(pattern: re.Pattern[str], repl: str | Any, label: str, buf: str) -> str:
        count = 0

        def _count_repl(match: re.Match[str]) -> str:
            nonlocal count
            count += 1
            return repl(match) if callable(repl) else repl

        out = pattern.sub(_count_repl, buf)
        if count:
            redactions[label] = redactions.get(label, 0) + count
        return out

    cleaned = text
    cleaned = _sub(_PEM_RE, "[REDACTED_PRIVATE_KEY]", "private_key", cleaned)
    cleaned = _sub(_COOKIE_RE, "[REDACTED_COOKIE]", "cookie", cleaned)
    cleaned = _sub(_JWT_RE, "[REDACTED_JWT]", "jwt", cleaned)
    cleaned = _sub(_API_KEY_RE, "[REDACTED_API_KEY]", "api_key", cleaned)
    cleaned = _sub(_BEARER_RE, "Bearer [REDACTED_TOKEN]", "bearer", cleaned)
    cleaned = _sub(_KV_SECRET_RE, lambda m: f"{m.group(1)}[REDACTED_SECRET]", "secret_assignment", cleaned)
    cleaned = _sub(_ZH_SECRET_RE, lambda m: f"{m.group(1)}[REDACTED_SECRET]", "secret_assignment_zh", cleaned)
    cleaned = _sub(_SSN_RE, "[REDACTED_SSN]", "ssn", cleaned)
    cleaned = _sub(_CN_ID_RE, "[REDACTED_CN_ID]", "cn_id", cleaned)
    cleaned = _sub(_HKID_RE, "[REDACTED_HKID]", "hkid", cleaned)
    cleaned = _sub(_CARD_RE, "[REDACTED_CARD]", "payment_card", cleaned)
    cleaned = _sub(_EMAIL_RE, "[REDACTED_EMAIL]", "email", cleaned)
    cleaned = _sub(_PHONE_RE, "[REDACTED_PHONE]", "phone", cleaned)

    presidio = _try_presidio_analyzer()
    presidio_active = presidio is not None
    if presidio is not None:
        try:
            hits = sorted(
                presidio.analyze(text=cleaned, language="en", entities=["PERSON", "US_PASSPORT", "IBAN_CODE"]),
                key=lambda r: r.start,
                reverse=True,
            )
            for hit in hits:
                snippet = cleaned[hit.start:hit.end]
                if "[REDACTED_" in snippet:
                    continue
                cleaned = f"{cleaned[:hit.start]}[REDACTED_{hit.entity_type}]{cleaned[hit.end:]}"
                redactions[hit.entity_type.lower()] = redactions.get(hit.entity_type.lower(), 0) + 1
        except Exception:
            presidio_active = False

    return {
        "redacted_text": cleaned,
        "redactions": redactions,
        "presidio_active": presidio_active,
    }


def redact_screen_text(text: str) -> str:
    """Return PII- and secret-redacted text suitable for cloud control-plane inspection."""
    return str(redact_screen_text_detailed(text)["redacted_text"])


# --- Indirect Prompt-Injection Sanitizer ---

_INJECTION_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "role_tag_injection",
        re.compile(
            r"(?is)</?\s*(?:system|developer|assistant|tool_call|instructions?)\s*>|"
            r"<\|(?:system|im_start|im_end|assistant)\|>"
        ),
    ),
    (
        "system_banner_injection",
        re.compile(r"(?im)(?:\[(?:SYSTEM|ADMIN OVERRIDE|PROMPT)\]|###\s*(?:SYSTEM|INSTRUCTION|OVERRIDE)\b)"),
    ),
    (
        "ignore_instructions",
        re.compile(
            r"(?i)\b(?:ignore|disregard|forget|override|bypass|skip)\b.{0,35}"
            r"\b(?:all\s+|any\s+|your\s+|the\s+)?(?:previous|prior|above|earlier|system|safety|security)\s+"
            r"(?:instructions?|rules?|prompts?|constraints?|policies|directives?|guardrails?)\b"
        ),
    ),
    (
        "indirect_shell_or_exfil",
        re.compile(
            r"(?i)(?:\b(?:execute|run|spawn|invoke)\s+(?:shell|bash|sh|zsh|powershell|cmd|curl|wget)\b|"
            r"\b(?:exfiltrate|dump|send|upload)\b.{0,30}\b(?:\.env|id_rsa|api[_\s-]?key|soul\.md|secrets?|cookies?)\b|"
            r"\b(?:reveal|print|output|dump)\b.{0,25}\b(?:soul\.md|system\s+prompt|hidden\s+instructions?)\b)"
        ),
    ),
    (
        "injection_zh",
        re.compile(
            r"(?:忽略|无视|無視|绕过|繞過|覆盖|覆蓋).{0,20}(?:之前|以前|所有|系统|系統).{0,15}"
            r"(?:指令|规则|規則|提示词|提示詞|限制)|"
            r"(?:执行|執行|运行|運行).{0,15}(?:shell|bash|系统命令|系統命令|终端命令|終端命令)"
        ),
    ),
)


def inspect_untrusted_screen_text(text: str) -> dict[str, Any]:
    """Strip hidden invisible chars and neutralize indirect prompt injections captured from screen/DOM."""
    if not text:
        return {
            "sanitized_text": "",
            "injection_detected": False,
            "matched_rules": [],
            "stripped_invisible_chars": 0,
        }

    normalized = unicodedata.normalize("NFKC", text)
    kept_chars: list[str] = []
    stripped_invisible = 0
    for ch in normalized:
        codepoint = ord(ch)
        if unicodedata.category(ch) == "Cf" or 0xE0000 <= codepoint <= 0xE007F:
            stripped_invisible += 1
            continue
        if codepoint < 32 and ch not in ("\n", "\r", "\t"):
            stripped_invisible += 1
            continue
        kept_chars.append(ch)

    cleaned = "".join(kept_chars)
    matched_rules: list[str] = []

    for rule_name, pattern in _INJECTION_RULES:
        if pattern.search(cleaned):
            matched_rules.append(rule_name)
            cleaned = pattern.sub("[NEUTRALIZED_UNTRUSTED_DIRECTIVE]", cleaned)

    return {
        "sanitized_text": cleaned,
        "injection_detected": bool(matched_rules) or stripped_invisible > 0,
        "matched_rules": matched_rules,
        "stripped_invisible_chars": stripped_invisible,
    }


def sanitize_untrusted_screen_text(text: str) -> str:
    """Return screen/DOM text with indirect prompt-injection payloads neutralized."""
    return str(inspect_untrusted_screen_text(text)["sanitized_text"])
