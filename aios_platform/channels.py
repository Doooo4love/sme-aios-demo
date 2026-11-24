"""Enterprise messaging channels catalog, employee bindings, outbound relay, and signed webhook ingress."""
from __future__ import annotations

import base64
from collections.abc import Iterable
from dataclasses import dataclass
from hashlib import sha1, sha256
import hmac
import json
import os
from pathlib import Path
import re
import time
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit
from uuid import uuid4
import xml.etree.ElementTree as ET

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
import httpx
import jwt
from pydantic import Field

from .collaboration import subject_tx
from .contracts import Actor, Identifier, Strict
from .http_pool import get_http_client
from .module_access import Subject
from .providers import https_base
from .security_guard import check_output_leakage, normalize_user_text, scrub_secrets
from .workflow import Conflict, Workflow

MAX_WEBHOOK_BYTES = 262_144
MAX_CHANNEL_RESPONSE_BYTES = 65_536
SLACK_REPLAY_WINDOW_SECONDS = 300
DINGTALK_REPLAY_WINDOW_SECONDS = 3600
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_HEADER_CRLF_RE = re.compile(
    r"(?:^|[\r\n]|%0[da]|\\r|\\n)\s*(?:bcc|cc|to|from|subject|reply-to|authorization|content-type|x-[a-z-]+)\s*:",
    re.IGNORECASE,
)
_HANDLE_CTRL_RE = re.compile(r"[\r\n\x00-\x1f\x7f]|%0[da]", re.IGNORECASE)
_SENSITIVE_ENV_RE = re.compile(
    r"\b(?:DEEPSEEK_API_KEY|AIOS_LLM_API_KEY|AIOS_DEMO_SECRET|AIOS_BROWSER_SESSION_KEY|"
    r"AIOS_ASSURANCE_KEY|AIOS_METRICS_TOKEN|AIOS_REVIEWER_PASSCODE|__Host-aios_session|"
    r"__Host-aios_gate|AIOS_CHANNEL_[A-Z0-9_]+_SECRET|AIOS_MCP_CHANNEL_[A-Z0-9_]+_TOKEN)\b"
)
_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass(frozen=True)
class ChannelSpec:
    channel_id: str
    name: str
    name_zh: str
    name_hk: str
    region: str
    protocol: str
    signature_scheme: str
    capabilities: tuple[str, ...]
    extra_env_keys: tuple[str, ...] = ()

    @property
    def env_prefix(self) -> str:
        return self.channel_id.upper()

    @property
    def setup_env_keys(self) -> tuple[str, ...]:
        cid = self.env_prefix
        return (
            f"AIOS_MCP_CHANNEL_{cid}_URL",
            f"AIOS_MCP_CHANNEL_{cid}_TOKEN",
            f"AIOS_CHANNEL_{cid}_WEBHOOK_URL",
            f"AIOS_CHANNEL_{cid}_WEBHOOK_SECRET",
            *self.extra_env_keys,
        )


CHANNEL_CATALOG: tuple[ChannelSpec, ...] = (
    ChannelSpec(
        channel_id="whatsapp",
        name="WhatsApp Business",
        name_zh="WhatsApp Business",
        name_hk="WhatsApp Business",
        region="Global",
        protocol="Meta Cloud API / Webhook",
        signature_scheme="webhook_hmac_sha256",
        capabilities=("inbound_webhook", "outbound_relay", "challenge_verification", "identity_binding"),
        extra_env_keys=("AIOS_CHANNEL_WHATSAPP_VERIFY_TOKEN",),
    ),
    ChannelSpec(
        channel_id="wecom",
        name="WeCom",
        name_zh="企业微信 WeCom",
        name_hk="企業微信 WeCom",
        region="APAC / China",
        protocol="WeCom Callback / Corp API",
        signature_scheme="wecom_sha1_aes",
        capabilities=("inbound_webhook", "outbound_relay", "challenge_verification", "identity_binding"),
        extra_env_keys=("AIOS_CHANNEL_WECOM_ENCODING_AES_KEY",),
    ),
    ChannelSpec(
        channel_id="feishu",
        name="Feishu / Lark",
        name_zh="飞书 / Lark",
        name_hk="飛書 / Lark",
        region="Global / APAC",
        protocol="Lark Open Platform Event v2",
        signature_scheme="feishu_sha256_challenge",
        capabilities=("inbound_webhook", "outbound_relay", "challenge_verification", "identity_binding"),
        extra_env_keys=("AIOS_CHANNEL_FEISHU_VERIFICATION_TOKEN",),
    ),
    ChannelSpec(
        channel_id="dingtalk",
        name="DingTalk",
        name_zh="钉钉 DingTalk",
        name_hk="釘釘 DingTalk",
        region="China / APAC",
        protocol="DingTalk Stream / Robot Callback",
        signature_scheme="dingtalk_hmac_sha256",
        capabilities=("inbound_webhook", "outbound_relay", "timestamp_hmac", "identity_binding"),
    ),
    ChannelSpec(
        channel_id="slack",
        name="Slack Enterprise",
        name_zh="Slack 企业协作",
        name_hk="Slack 企業協作",
        region="Global",
        protocol="Slack Events API / Block Kit",
        signature_scheme="slack_v0_hmac_sha256",
        capabilities=("inbound_webhook", "outbound_relay", "challenge_verification", "replay_guard", "identity_binding"),
    ),
    ChannelSpec(
        channel_id="teams",
        name="Microsoft Teams",
        name_zh="Microsoft Teams",
        name_hk="Microsoft Teams",
        region="Global",
        protocol="Bot Framework / Adaptive Cards",
        signature_scheme="hmac_bearer_jwt",
        capabilities=("inbound_webhook", "outbound_relay", "adaptive_cards", "identity_binding"),
    ),
    ChannelSpec(
        channel_id="telegram",
        name="Telegram Business",
        name_zh="Telegram 商务机器人",
        name_hk="Telegram 商務機器人",
        region="Global",
        protocol="Telegram Bot API Webhook",
        signature_scheme="telegram_secret_token",
        capabilities=("inbound_webhook", "outbound_relay", "secret_token_auth", "identity_binding"),
    ),
    ChannelSpec(
        channel_id="line",
        name="LINE Official / WORKS",
        name_zh="LINE Official / WORKS",
        name_hk="LINE Official / WORKS",
        region="APAC",
        protocol="LINE Messaging API",
        signature_scheme="line_hmac_sha256",
        capabilities=("inbound_webhook", "outbound_relay", "hmac_verification", "identity_binding"),
    ),
)

CHANNEL_MAP: dict[str, ChannelSpec] = {spec.channel_id: spec for spec in CHANNEL_CATALOG}


class ChannelBindingUpdate(Strict):
    external_user_id: Annotated[str, Field(min_length=1, max_length=160)]
    display_handle: Annotated[str, Field(min_length=1, max_length=160)]
    subject: Subject | None = None
    verified: bool = False


class ChannelOutboundRequest(Strict):
    channel_id: Identifier
    target_handle: Annotated[str, Field(min_length=1, max_length=200)]
    text: Annotated[str, Field(min_length=1, max_length=4000)]
    client_id: Identifier | None = None


class UnifiedChannelEnvelope(Strict):
    channel_id: Identifier
    tenant: Identifier
    external_event_id: Annotated[str, Field(min_length=1, max_length=160)]
    sender_handle: Annotated[str, Field(min_length=1, max_length=160)]
    text_preview: Annotated[str, Field(max_length=240)]
    received_at: float
    deduplicated: bool


class ChannelPolicyViolation(PermissionError):
    def __init__(self, category: str, message: str, incident_id: str | None = None):
        super().__init__(message)
        self.category = category
        self.message = message
        self.incident_id = incident_id


def _optional_setting(name: str) -> str | None:
    file_path = (os.getenv(name + "_FILE") or "").strip()
    if file_path:
        path = Path(file_path)
        if path.is_file():
            val = path.read_text().strip()
            return val or None
    val = (os.getenv(name) or "").strip()
    return val or None


def _validate_mcp_url(raw_url: str) -> str:
    trimmed = raw_url.strip()
    parsed = urlsplit(trimmed)
    host = (parsed.hostname or "").lower()
    if (
        not host
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or host == "169.254.169.254"
        or host.startswith("169.254.")
        or host == "metadata.google.internal"
        or host == "0.0.0.0"
        or host.startswith("fd")
    ):
        raise ValueError("Invalid MCP channel URL")
    if parsed.scheme == "https":
        return trimmed.rstrip("/")
    if parsed.scheme == "http" and host in _LOOPBACK_HOSTS:
        return trimmed.rstrip("/")
    raise ValueError("MCP channel URL must use HTTPS or loopback HTTP")


def _clean_handle_field(value: str, label: str) -> str:
    if _HANDLE_CTRL_RE.search(value):
        raise ValueError(f"Invalid {label}")
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"Invalid {label}")
    if scrub_secrets(cleaned) != cleaned:
        raise ValueError(f"{label} cannot contain credentials or secrets")
    return cleaned


def _read_bounded_json(response: httpx.Response) -> dict[str, Any]:
    chunks = bytearray()
    for chunk in response.iter_bytes(8192):
        chunks.extend(chunk)
        if len(chunks) > MAX_CHANNEL_RESPONSE_BYTES:
            raise ValueError("Channel response exceeded size limit")
    if not chunks:
        return {}
    raw_text = chunks.decode("utf-8", errors="replace").strip()
    if not raw_text:
        return {}
    content_type = (response.headers.get("content-type") or "").lower()
    if "text/event-stream" in content_type:
        for line in raw_text.splitlines():
            if line.startswith("data:"):
                candidate = line[5:].strip()
                if candidate and candidate != "[DONE]":
                    try:
                        parsed = json.loads(candidate)
                        if isinstance(parsed, dict):
                            return parsed
                    except ValueError:
                        continue
        return {}
    parsed = json.loads(raw_text)
    return parsed if isinstance(parsed, dict) else {}


def _extract_mcp_message_id(rpc_payload: dict[str, Any]) -> str | None:
    if "error" in rpc_payload:
        raise ValueError("MCP channel tool returned JSON-RPC error")
    result = rpc_payload.get("result")
    if not isinstance(result, dict):
        return None
    if result.get("isError"):
        raise ValueError("MCP channel tool reported execution error")
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        for key in ("external_message_id", "message_id", "id", "ts"):
            val = structured.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()[:120]
    for key in ("external_message_id", "message_id", "id"):
        val = result.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()[:120]
    return None


def _parse_json_object(raw_body: bytes) -> dict[str, Any] | None:
    if not raw_body:
        return None
    try:
        parsed = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _parse_wecom_xml(raw_body: bytes) -> dict[str, str] | None:
    lowered = raw_body.lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        raise HTTPException(422, "Invalid XML entity declaration")
    stripped = raw_body.lstrip()
    if not stripped.startswith(b"<"):
        return None
    try:
        root = ET.fromstring(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, ET.ParseError) as error:
        raise HTTPException(422, "Malformed XML webhook payload") from error
    result: dict[str, str] = {}
    for child in root:
        if isinstance(child.tag, str) and child.text is not None:
            result[child.tag] = child.text
    return result


class ChannelService:
    """Enterprise messaging channel hub supporting 8 verified connectors."""

    def __init__(
        self,
        workflow: Workflow,
        governance=None,
        *,
        known_subject=None,
        allowed_tenants: Iterable[str] | None = None,
    ):
        self.workflow = workflow
        self.governance = governance
        self.known_subject = known_subject
        self.allowed_tenants = frozenset(allowed_tenants) if allowed_tenants is not None else None

    @staticmethod
    def _spec(channel_id: str) -> ChannelSpec:
        spec = CHANNEL_MAP.get(channel_id)
        if spec is None:
            raise KeyError(channel_id)
        return spec

    @staticmethod
    def _channel_transport_state(spec: ChannelSpec) -> tuple[str, bool]:
        mcp_url = _optional_setting(f"AIOS_MCP_CHANNEL_{spec.env_prefix}_URL")
        if mcp_url:
            try:
                _validate_mcp_url(mcp_url)
                return "connected_mcp", True
            except ValueError:
                pass
        webhook_url = _optional_setting(f"AIOS_CHANNEL_{spec.env_prefix}_WEBHOOK_URL")
        if webhook_url:
            try:
                https_base(webhook_url)
                return "connected_api", True
            except ValueError:
                pass
        return "ready_to_bind", False

    def catalog(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for spec in CHANNEL_CATALOG:
            transport_mode, configured = self._channel_transport_state(spec)
            items.append(
                {
                    "channel_id": spec.channel_id,
                    "name": spec.name,
                    "name_zh": spec.name_zh,
                    "name_hk": spec.name_hk,
                    "region": spec.region,
                    "protocol": spec.protocol,
                    "signature_scheme": spec.signature_scheme,
                    "transport_mode": transport_mode,
                    "configured": configured,
                    "webhook_path": f"/v1/channels/webhooks/{spec.channel_id}",
                    "capabilities": list(spec.capabilities),
                    "setup_env_keys": list(spec.setup_env_keys),
                }
            )
        return items

    @staticmethod
    def _format_binding(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "channel_id": row["channel_id"],
            "subject": row["subject"],
            "external_user_id": row["external_user_id"],
            "display_handle": row["display_handle"],
            "verified": bool(row["verified"]),
            "updated_at": float(row["updated_at"]),
        }

    def list_bindings(
        self,
        actor: Actor,
        *,
        scope: Literal["mine", "tenant"] = "mine",
        subject: str | None = None,
    ) -> list[dict[str, Any]]:
        is_ops_admin = actor.role == "admin" and "operations.manage" in actor.grants
        if scope == "tenant" or (subject is not None and subject != actor.subject):
            if not is_ops_admin:
                raise PermissionError("Tenant administrator operations permission required")
        with subject_tx(self.workflow, actor, write=False) as run:
            if scope == "tenant" and subject is None:
                rows = run(
                    """SELECT channel_id, subject, external_user_id, display_handle, verified, updated_at
                       FROM aios_channel_binding
                       WHERE tenant = ?
                       ORDER BY channel_id, subject""",
                    (actor.tenant,),
                ).fetchall()
            else:
                target_subject = subject or actor.subject
                rows = run(
                    """SELECT channel_id, subject, external_user_id, display_handle, verified, updated_at
                       FROM aios_channel_binding
                       WHERE tenant = ? AND subject = ?
                       ORDER BY channel_id""",
                    (actor.tenant, target_subject),
                ).fetchall()
        return [self._format_binding(dict(row)) for row in rows]

    def upsert_binding(self, actor: Actor, channel_id: str, body: ChannelBindingUpdate) -> dict[str, Any]:
        self._spec(channel_id)
        is_ops_admin = actor.role == "admin" and "operations.manage" in actor.grants
        target_subject = body.subject or actor.subject
        if target_subject != actor.subject and not is_ops_admin:
            raise PermissionError("Administrator permission required to bind another employee")
        if (
            target_subject != actor.subject
            and self.known_subject is not None
            and not self.known_subject(actor.tenant, target_subject)
        ):
            raise KeyError(target_subject)

        ext_id = _clean_handle_field(body.external_user_id, "external_user_id")
        handle = _clean_handle_field(body.display_handle, "display_handle")
        verified = int(bool(body.verified)) if is_ops_admin else 0
        now = time.time()

        with subject_tx(self.workflow, actor, write=True) as run:
            if target_subject != actor.subject and self.workflow._suspended(run, actor.tenant, target_subject):
                raise PermissionError("Target account access is suspended")
            run(
                """INSERT INTO aios_channel_binding
                   (tenant, subject, channel_id, external_user_id, display_handle, verified, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (tenant, subject, channel_id) DO UPDATE SET
                       external_user_id = excluded.external_user_id,
                       display_handle = excluded.display_handle,
                       verified = excluded.verified,
                       updated_at = excluded.updated_at""",
                (actor.tenant, target_subject, channel_id, ext_id, handle, verified, now),
            )
            self.workflow._audit(
                run,
                actor.tenant,
                actor.subject,
                f"{channel_id}:{target_subject}",
                "CHANNEL_BINDING_UPDATED",
            )
            stored = run(
                """SELECT channel_id, subject, external_user_id, display_handle, verified, updated_at
                   FROM aios_channel_binding
                   WHERE tenant = ? AND subject = ? AND channel_id = ?""",
                (actor.tenant, target_subject, channel_id),
            ).fetchone()
        return self._format_binding(dict(stored))

    @staticmethod
    def _format_outbound(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row["id"],
            "client_id": row["client_id"],
            "channel_id": row["channel_id"],
            "sender_subject": row["sender_subject"],
            "target_handle": row["target_handle"],
            "body_preview": row["body_preview"],
            "body_sha256": row["body_sha256"],
            "transport_mode": row["transport_mode"],
            "delivery_status": row["delivery_status"],
            "external_message_id": row["external_message_id"],
            "created_at": float(row["created_at"]),
        }

    def list_outbound(
        self,
        actor: Actor,
        *,
        limit: int = 30,
        channel_id: str | None = None,
        scope: Literal["mine", "tenant"] = "mine",
    ) -> list[dict[str, Any]]:
        if channel_id is not None:
            self._spec(channel_id)
        if scope == "tenant" and not (actor.role == "admin" and "operations.manage" in actor.grants):
            raise PermissionError("Administrator operations permission required")
        capped = max(1, min(limit, 100))
        clauses = ["tenant = ?"]
        params: list[Any] = [actor.tenant]
        if scope != "tenant":
            clauses.append("sender_subject = ?")
            params.append(actor.subject)
        if channel_id is not None:
            clauses.append("channel_id = ?")
            params.append(channel_id)
        where_sql = " AND ".join(clauses)
        with subject_tx(self.workflow, actor, write=False) as run:
            rows = run(
                f"""SELECT * FROM aios_channel_outbound_log
                    WHERE {where_sql}
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?""",
                (*params, capped),
            ).fetchall()
        return [self._format_outbound(dict(row)) for row in rows]

    def _validate_outbound_safety(self, actor: Actor, channel_id: str, target_handle: str, text: str) -> None:
        nfkc_handle, _ = normalize_user_text(target_handle)
        nfkc_text, _ = normalize_user_text(text)

        violation: tuple[str, str, str] | None = None
        if _HANDLE_CTRL_RE.search(target_handle) or _HANDLE_CTRL_RE.search(nfkc_handle):
            violation = (
                "CHANNEL_POLICY_VIOLATION",
                "channel_handle_crlf",
                "Channel target handle contains disallowed CR/LF or control characters.",
            )
        elif _HEADER_CRLF_RE.search(text) or _HEADER_CRLF_RE.search(nfkc_text):
            violation = (
                "CHANNEL_POLICY_VIOLATION",
                "channel_header_crlf",
                "Channel outbound payload blocked due to CR/LF header injection pattern.",
            )
        elif (
            scrub_secrets(nfkc_text) != nfkc_text
            or check_output_leakage(nfkc_text, []) != nfkc_text
            or _SENSITIVE_ENV_RE.search(nfkc_text)
        ):
            violation = (
                "SECRET_EXFILTRATION_ATTEMPT",
                "channel_secret_or_path_exfil",
                "Channel outbound payload blocked due to detected secret, credential, or sensitive file path.",
            )

        if violation is not None:
            category, matched_rule, msg = violation
            incident_id = None
            if self.governance is not None:
                event = self.governance.record_security_event(
                    actor,
                    category=category,
                    severity="high",
                    decision="blocked",
                    module="channels",
                    action_attempted=f"channel.outbound.{channel_id}",
                    summary=msg,
                    raw_input=f"{channel_id}:{target_handle}\n{text}",
                    matched_rule=matched_rule,
                    metadata={"channel_id": channel_id},
                )
                incident_id = event["id"]
            raise ChannelPolicyViolation(category, msg, incident_id)

    def _dispatch_outbound_transport(
        self,
        actor: Actor,
        spec: ChannelSpec,
        target_handle: str,
        text: str,
        client_id: str,
    ) -> tuple[str, str, str]:
        fallback_attempted = False

        # Priority 1: Streamable HTTP MCP Server
        mcp_raw = _optional_setting(f"AIOS_MCP_CHANNEL_{spec.env_prefix}_URL")
        if mcp_raw:
            mcp_url = _validate_mcp_url(mcp_raw)
            mcp_token = _optional_setting(f"AIOS_MCP_CHANNEL_{spec.env_prefix}_TOKEN")
            tool_name = _optional_setting(f"AIOS_MCP_CHANNEL_{spec.env_prefix}_TOOL") or "send_message"
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            }
            if mcp_token:
                headers["Authorization"] = f"Bearer {mcp_token}"
            rpc_body = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": tool_name,
                    "arguments": {
                        "channel_id": spec.channel_id,
                        "target_handle": target_handle,
                        "text": text,
                        "client_id": client_id,
                        "tenant": actor.tenant,
                        "sender_subject": actor.subject,
                    },
                },
            }
            try:
                client = get_http_client("channels-mcp", timeout=8.0)
                with client.stream("POST", mcp_url, json=rpc_body, headers=headers) as response:
                    response.raise_for_status()
                    rpc_data = _read_bounded_json(response)
                ext_id = _extract_mcp_message_id(rpc_data) or f"mcp-{spec.channel_id}-{uuid4().hex[:12]}"
                return "connected_mcp", "sent_mcp", ext_id
            except (httpx.HTTPError, OSError, ValueError):
                fallback_attempted = True

        # Priority 2: Official HTTPS Webhook
        webhook_raw = _optional_setting(f"AIOS_CHANNEL_{spec.env_prefix}_WEBHOOK_URL")
        if webhook_raw:
            webhook_url = https_base(webhook_raw)
            bearer = _optional_setting(f"AIOS_CHANNEL_{spec.env_prefix}_WEBHOOK_BEARER")
            headers = {"Content-Type": "application/json", "Accept": "application/json"}
            if bearer:
                headers["Authorization"] = f"Bearer {bearer}"
            payload = {
                "channel_id": spec.channel_id,
                "target_handle": target_handle,
                "text": text,
                "client_id": client_id,
                "tenant": actor.tenant,
                "sender_subject": actor.subject,
            }
            try:
                client = get_http_client("channels-webhook", timeout=8.0)
                with client.stream("POST", webhook_url, json=payload, headers=headers) as response:
                    response.raise_for_status()
                    resp_data = _read_bounded_json(response)
                ext_id = None
                for key in ("external_message_id", "message_id", "id", "ts"):
                    val = resp_data.get(key)
                    if isinstance(val, str) and val.strip():
                        ext_id = val.strip()[:120]
                        break
                return "connected_api", "sent_api", ext_id or f"api-{spec.channel_id}-{uuid4().hex[:12]}"
            except (httpx.HTTPError, OSError, ValueError):
                fallback_attempted = True

        # Priority 3: Governed Relay Outbox
        status = "queued_fallback" if fallback_attempted else "queued_governed"
        return "governed_relay", status, f"relay-{spec.channel_id}-{uuid4().hex[:16]}"

    def send_outbound(self, actor: Actor, body: ChannelOutboundRequest) -> dict[str, Any]:
        spec = self._spec(body.channel_id)
        clean_target = body.target_handle.strip()
        if not clean_target:
            raise ValueError("Target handle is required")
        if not body.text.strip():
            raise ValueError("Message text is required")

        self._validate_outbound_safety(actor, spec.channel_id, body.target_handle, body.text)

        resolved_client_id = body.client_id or uuid4().hex
        body_sha256 = sha256(body.text.encode("utf-8")).hexdigest()
        safe_preview = re.sub(r"\s+", " ", scrub_secrets(body.text)).strip()[:240]

        with subject_tx(self.workflow, actor, write=False) as run:
            prior = run(
                """SELECT * FROM aios_channel_outbound_log
                   WHERE tenant = ? AND sender_subject = ? AND client_id = ?""",
                (actor.tenant, actor.subject, resolved_client_id),
            ).fetchone()
            if prior is not None:
                if (
                    prior["channel_id"] != spec.channel_id
                    or prior["target_handle"] != clean_target
                    or prior["body_sha256"] != body_sha256
                ):
                    raise Conflict("Channel client_id is already bound to a different message")
                return self._format_outbound(dict(prior))

        transport_mode, delivery_status, external_message_id = self._dispatch_outbound_transport(
            actor, spec, clean_target, body.text, resolved_client_id
        )

        out_id = uuid4().hex
        now = time.time()
        with subject_tx(self.workflow, actor, write=True) as run:
            inserted = run(
                """INSERT INTO aios_channel_outbound_log
                   (tenant, id, client_id, channel_id, sender_subject, target_handle,
                    body_preview, body_sha256, transport_mode, delivery_status,
                    external_message_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (tenant, sender_subject, client_id) DO NOTHING""",
                (
                    actor.tenant,
                    out_id,
                    resolved_client_id,
                    spec.channel_id,
                    actor.subject,
                    clean_target,
                    safe_preview,
                    body_sha256,
                    transport_mode,
                    delivery_status,
                    external_message_id,
                    now,
                ),
            )
            if inserted.rowcount != 1:
                existing = run(
                    """SELECT * FROM aios_channel_outbound_log
                       WHERE tenant = ? AND sender_subject = ? AND client_id = ?""",
                    (actor.tenant, actor.subject, resolved_client_id),
                ).fetchone()
                if existing is None or (
                    existing["channel_id"] != spec.channel_id
                    or existing["target_handle"] != clean_target
                    or existing["body_sha256"] != body_sha256
                ):
                    raise Conflict("Channel client_id is already bound to a different message")
                return self._format_outbound(dict(existing))

            self.workflow._audit(
                run,
                actor.tenant,
                actor.subject,
                out_id,
                "CHANNEL_OUTBOUND_RECORDED",
            )
            stored = run(
                "SELECT * FROM aios_channel_outbound_log WHERE tenant = ? AND id = ?",
                (actor.tenant, out_id),
            ).fetchone()
        return self._format_outbound(dict(stored))

    def _resolve_webhook_tenant(self, request: Request) -> str:
        configured = _optional_setting("AIOS_CONNECTOR_TENANT")
        raw_tenant = (
            request.query_params.get("tenant")
            or request.headers.get("x-aios-tenant")
            or configured
            or "harbour"
        ).strip()
        if not _IDENTIFIER_RE.fullmatch(raw_tenant):
            raise HTTPException(422, "Invalid tenant identifier")
        if configured and raw_tenant != configured:
            raise HTTPException(403, "Cross-tenant webhook rejected")
        if self.allowed_tenants is not None and raw_tenant not in self.allowed_tenants:
            raise HTTPException(404, "Tenant not found")
        return raw_tenant

    @staticmethod
    def _webhook_secret(spec: ChannelSpec) -> str:
        secret = _optional_setting(f"AIOS_CHANNEL_{spec.env_prefix}_WEBHOOK_SECRET")
        if not secret:
            raise HTTPException(
                503,
                {"code": "CHANNEL_WEBHOOK_UNCONFIGURED", "message": "Channel webhook secret is not configured"},
            )
        return secret

    def verify_get_challenge(self, channel_id: str, request: Request) -> PlainTextResponse:
        spec = self._spec(channel_id)
        if spec.channel_id == "whatsapp":
            expected_token = (
                _optional_setting("AIOS_CHANNEL_WHATSAPP_VERIFY_TOKEN")
                or _optional_setting("AIOS_CHANNEL_WHATSAPP_WEBHOOK_SECRET")
            )
            if not expected_token:
                raise HTTPException(
                    503,
                    {"code": "CHANNEL_WEBHOOK_UNCONFIGURED", "message": "Channel webhook secret is not configured"},
                )
            mode = (request.query_params.get("hub.mode") or "").strip()
            token = (request.query_params.get("hub.verify_token") or "").strip()
            challenge = request.query_params.get("hub.challenge")
            if mode != "subscribe" or not challenge:
                raise HTTPException(422, "Missing WhatsApp hub challenge parameters")
            if not hmac.compare_digest(token, expected_token):
                raise HTTPException(403, "Invalid WhatsApp verify token")
            return PlainTextResponse(challenge, status_code=200)

        if spec.channel_id == "wecom":
            secret = self._webhook_secret(spec)
            sig = (request.query_params.get("msg_signature") or "").strip().lower()
            ts = (request.query_params.get("timestamp") or "").strip()
            nonce = (request.query_params.get("nonce") or "").strip()
            echostr = request.query_params.get("echostr") or ""
            if not sig or not ts or not nonce or not echostr:
                raise HTTPException(401, "Missing WeCom verification signature parameters")
            expected = sha1("".join(sorted([secret, ts, nonce, echostr])).encode("utf-8")).hexdigest()
            if not hmac.compare_digest(expected, sig):
                raise HTTPException(401, "Invalid WeCom webhook signature")
            return PlainTextResponse(echostr, status_code=200)

        raise HTTPException(405, "GET challenge handshake is not supported for this channel")

    @staticmethod
    def _verify_post_signature(
        spec: ChannelSpec,
        secret: str,
        request: Request,
        raw_body: bytes,
        json_payload: dict[str, Any] | None,
    ) -> None:
        cid = spec.channel_id
        if cid == "whatsapp":
            header = (request.headers.get("x-hub-signature-256") or "").strip().lower()
            if not header.startswith("sha256="):
                raise HTTPException(401, "Missing WhatsApp webhook signature")
            expected = "sha256=" + hmac.new(secret.encode("utf-8"), raw_body, sha256).hexdigest()
            if not hmac.compare_digest(expected, header):
                raise HTTPException(401, "Invalid WhatsApp webhook signature")
            return

        if cid == "slack":
            ts_str = (request.headers.get("x-slack-request-timestamp") or "").strip()
            sig = (request.headers.get("x-slack-signature") or "").strip().lower()
            if not ts_str or not sig:
                raise HTTPException(401, "Missing Slack webhook signature")
            try:
                ts_val = int(ts_str)
            except ValueError as error:
                raise HTTPException(401, "Invalid Slack timestamp") from error
            if abs(time.time() - ts_val) > SLACK_REPLAY_WINDOW_SECONDS:
                raise HTTPException(401, "Stale Slack request timestamp")
            try:
                body_str = raw_body.decode("utf-8", errors="strict")
            except UnicodeDecodeError as error:
                raise HTTPException(400, "Webhook body must be UTF-8") from error
            basestring = f"v0:{ts_str}:{body_str}"
            expected = "v0=" + hmac.new(secret.encode("utf-8"), basestring.encode("utf-8"), sha256).hexdigest()
            if not hmac.compare_digest(expected, sig):
                raise HTTPException(401, "Invalid Slack webhook signature")
            return

        if cid == "feishu":
            sig = (request.headers.get("x-lark-signature") or "").strip().lower()
            ts = (request.headers.get("x-lark-request-timestamp") or "").strip()
            nonce = (request.headers.get("x-lark-request-nonce") or "").strip()
            if sig:
                if not ts or not nonce:
                    raise HTTPException(401, "Missing Feishu timestamp or nonce headers")
                try:
                    body_str = raw_body.decode("utf-8", errors="strict")
                except UnicodeDecodeError as error:
                    raise HTTPException(400, "Webhook body must be UTF-8") from error
                expected = sha256((ts + nonce + secret + body_str).encode("utf-8")).hexdigest()
                if not hmac.compare_digest(expected, sig):
                    raise HTTPException(401, "Invalid Feishu webhook signature")
                return
            if json_payload and json_payload.get("type") == "url_verification":
                verify_token = _optional_setting("AIOS_CHANNEL_FEISHU_VERIFICATION_TOKEN") or secret
                presented = str(json_payload.get("token") or "")
                if presented and hmac.compare_digest(presented, verify_token):
                    return
            raise HTTPException(401, "Missing Feishu webhook signature")

        if cid == "wecom":
            sig = (request.query_params.get("msg_signature") or request.headers.get("x-wecom-signature") or "").strip().lower()
            ts = (request.query_params.get("timestamp") or request.headers.get("x-wecom-timestamp") or "").strip()
            nonce = (request.query_params.get("nonce") or request.headers.get("x-wecom-nonce") or "").strip()
            if not sig or not ts or not nonce:
                raise HTTPException(401, "Missing WeCom webhook signature parameters")
            msg_encrypt: str | None = None
            if json_payload is not None:
                raw_enc = json_payload.get("encrypt") or json_payload.get("Encrypt")
                if isinstance(raw_enc, str) and raw_enc:
                    msg_encrypt = raw_enc
            if msg_encrypt is None:
                xml_fields = _parse_wecom_xml(raw_body)
                if xml_fields and xml_fields.get("Encrypt"):
                    msg_encrypt = xml_fields["Encrypt"]
            if msg_encrypt is None:
                try:
                    msg_encrypt = raw_body.decode("utf-8", errors="strict")
                except UnicodeDecodeError as error:
                    raise HTTPException(400, "Webhook body must be UTF-8") from error
            expected = sha1("".join(sorted([secret, ts, nonce, msg_encrypt])).encode("utf-8")).hexdigest()
            if not hmac.compare_digest(expected, sig):
                raise HTTPException(401, "Invalid WeCom webhook signature")
            return

        if cid == "dingtalk":
            ts_str = (request.headers.get("timestamp") or request.headers.get("x-dingtalk-timestamp") or "").strip()
            sign = (request.headers.get("sign") or request.headers.get("x-dingtalk-sign") or "").strip()
            if not ts_str or not sign:
                raise HTTPException(401, "Missing DingTalk webhook signature")
            try:
                ts_val = int(ts_str)
            except ValueError as error:
                raise HTTPException(401, "Invalid DingTalk timestamp") from error
            now_sec = time.time()
            age_sec = abs(now_sec - (ts_val / 1000.0 if ts_val > 10_000_000_000 else float(ts_val)))
            if age_sec > DINGTALK_REPLAY_WINDOW_SECONDS:
                raise HTTPException(401, "Stale DingTalk webhook timestamp")
            string_to_sign = f"{ts_str}\n{secret}"
            digest = hmac.new(secret.encode("utf-8"), string_to_sign.encode("utf-8"), sha256).digest()
            expected = base64.b64encode(digest).decode("utf-8")
            if not hmac.compare_digest(expected, sign):
                raise HTTPException(401, "Invalid DingTalk webhook signature")
            return

        if cid == "teams":
            auth = (request.headers.get("authorization") or "").strip()
            if auth.lower().startswith("hmac "):
                presented = auth[5:].strip()
                digest = hmac.new(secret.encode("utf-8"), raw_body, sha256).digest()
                expected = base64.b64encode(digest).decode("utf-8")
                if not hmac.compare_digest(expected, presented):
                    raise HTTPException(401, "Invalid Teams HMAC signature")
                return
            if auth.lower().startswith("bearer "):
                token = auth[7:].strip()
                try:
                    jwt.decode(token, secret, algorithms=["HS256"], options={"require": ["exp"]})
                except jwt.PyJWTError as error:
                    raise HTTPException(401, "Invalid Teams bearer token") from error
                return
            raise HTTPException(401, "Missing Teams authorization header")

        if cid == "telegram":
            token = (request.headers.get("x-telegram-bot-api-secret-token") or "").strip()
            if not token or not hmac.compare_digest(token, secret):
                raise HTTPException(401, "Invalid Telegram secret token")
            return

        if cid == "line":
            sig = (request.headers.get("x-line-signature") or "").strip()
            digest = hmac.new(secret.encode("utf-8"), raw_body, sha256).digest()
            expected = base64.b64encode(digest).decode("utf-8")
            if not sig or not hmac.compare_digest(expected, sig):
                raise HTTPException(401, "Invalid LINE webhook signature")
            return

        raise HTTPException(401, "Unsupported webhook verification scheme")

    @staticmethod
    def _extract_envelope_fields(
        channel_id: str,
        raw_body: bytes,
        json_payload: dict[str, Any] | None,
    ) -> tuple[str, str, str]:
        data = json_payload or {}
        if not json_payload and channel_id == "wecom":
            xml_fields = _parse_wecom_xml(raw_body)
            if xml_fields:
                data = xml_fields

        event_id: str | None = None
        sender: str | None = None
        text: str = ""

        if channel_id == "whatsapp":
            entries = data.get("entry")
            if isinstance(entries, list) and entries and isinstance(entries[0], dict):
                changes = entries[0].get("changes")
                if isinstance(changes, list) and changes and isinstance(changes[0], dict):
                    value = changes[0].get("value")
                    if isinstance(value, dict):
                        msgs = value.get("messages")
                        if isinstance(msgs, list) and msgs and isinstance(msgs[0], dict):
                            msg = msgs[0]
                            event_id = str(msg.get("id") or "") or None
                            sender = str(msg.get("from") or "") or None
                            txt_obj = msg.get("text")
                            if isinstance(txt_obj, dict):
                                text = str(txt_obj.get("body") or "")
        elif channel_id == "wecom":
            event_id = str(data.get("MsgId") or data.get("msg_id") or "") or None
            sender = str(data.get("FromUserName") or data.get("from_user") or "") or None
            text = str(data.get("Content") or data.get("content") or "")
        elif channel_id == "feishu":
            header = data.get("header") if isinstance(data.get("header"), dict) else {}
            event = data.get("event") if isinstance(data.get("event"), dict) else {}
            sender_obj = event.get("sender") if isinstance(event.get("sender"), dict) else {}
            sender_ids = sender_obj.get("sender_id") if isinstance(sender_obj.get("sender_id"), dict) else {}
            msg_obj = event.get("message") if isinstance(event.get("message"), dict) else {}
            event_id = str(header.get("event_id") or data.get("event_id") or "") or None
            sender = str(sender_ids.get("open_id") or sender_ids.get("user_id") or "") or None
            raw_content = msg_obj.get("content")
            if isinstance(raw_content, str):
                try:
                    parsed_c = json.loads(raw_content)
                    if isinstance(parsed_c, dict) and "text" in parsed_c:
                        text = str(parsed_c.get("text") or "")
                    else:
                        text = raw_content
                except ValueError:
                    text = raw_content
        elif channel_id == "dingtalk":
            header = data.get("header") if isinstance(data.get("header"), dict) else {}
            txt_obj = data.get("text")
            event_id = str(data.get("msgId") or header.get("eventId") or "") or None
            sender = str(data.get("senderStaffId") or data.get("senderNick") or data.get("senderId") or "") or None
            if isinstance(txt_obj, dict):
                text = str(txt_obj.get("content") or "")
            elif isinstance(txt_obj, str):
                text = txt_obj
        elif channel_id == "slack":
            event = data.get("event") if isinstance(data.get("event"), dict) else {}
            event_id = str(data.get("event_id") or event.get("client_msg_id") or event.get("ts") or "") or None
            sender = str(event.get("user") or data.get("user_id") or "") or None
            text = str(event.get("text") or data.get("text") or "")
        elif channel_id == "teams":
            from_obj = data.get("from") if isinstance(data.get("from"), dict) else {}
            event_id = str(data.get("id") or "") or None
            sender = str(from_obj.get("id") or from_obj.get("name") or "") or None
            text = str(data.get("text") or "")
        elif channel_id == "telegram":
            msg = data.get("message") or data.get("edited_message") or {}
            if not isinstance(msg, dict):
                msg = {}
            from_obj = msg.get("from") if isinstance(msg.get("from"), dict) else {}
            uid = data.get("update_id")
            mid = msg.get("message_id")
            event_id = str(uid if uid is not None else (mid if mid is not None else "")) or None
            sender = str(from_obj.get("username") or from_obj.get("id") or "") or None
            text = str(msg.get("text") or "")
        elif channel_id == "line":
            events = data.get("events")
            if isinstance(events, list) and events and isinstance(events[0], dict):
                ev = events[0]
                src = ev.get("source") if isinstance(ev.get("source"), dict) else {}
                msg = ev.get("message") if isinstance(ev.get("message"), dict) else {}
                event_id = str(ev.get("webhookEventId") or msg.get("id") or "") or None
                sender = str(src.get("userId") or "") or None
                text = str(msg.get("text") or "")

        if not event_id:
            for key in ("external_event_id", "event_id", "message_id", "id"):
                val = data.get(key)
                if isinstance(val, (str, int)) and str(val).strip():
                    event_id = str(val).strip()
                    break
        if not sender:
            for key in ("sender_handle", "sender", "from", "user_id", "user"):
                val = data.get(key)
                if isinstance(val, str) and val.strip():
                    sender = val.strip()
                    break
        if not text:
            for key in ("text", "message", "content", "body"):
                val = data.get(key)
                if isinstance(val, str) and val.strip():
                    text = val
                    break

        resolved_event_id = (event_id or ("sha256:" + sha256(raw_body).hexdigest()[:32]))[:160]
        resolved_sender = re.sub(r"[\r\n\x00-\x1f\x7f]+", "", (sender or "external")).strip()[:160] or "external"
        safe_preview = re.sub(r"\s+", " ", scrub_secrets(str(text or ""))).strip()[:240]
        return resolved_event_id, resolved_sender, safe_preview

    async def handle_post_webhook(self, channel_id: str, request: Request) -> dict[str, Any]:
        spec = self._spec(channel_id)
        secret = self._webhook_secret(spec)

        raw_chunks = bytearray()
        async for chunk in request.stream():
            if len(raw_chunks) + len(chunk) > MAX_WEBHOOK_BYTES:
                raise HTTPException(413, "Webhook payload exceeds 256 KiB limit")
            raw_chunks.extend(chunk)
        raw_body = bytes(raw_chunks)

        json_payload = _parse_json_object(raw_body)
        self._verify_post_signature(spec, secret, request, raw_body, json_payload)

        if spec.channel_id in {"slack", "feishu"} and json_payload and json_payload.get("type") == "url_verification":
            challenge = json_payload.get("challenge")
            if not isinstance(challenge, str) or not challenge:
                raise HTTPException(422, "Missing challenge string")
            return {"challenge": challenge}

        tenant = self._resolve_webhook_tenant(request)
        external_event_id, sender_handle, text_preview = self._extract_envelope_fields(
            spec.channel_id, raw_body, json_payload
        )
        now = time.time()

        with self.workflow.tx(tenant, write=True, bounded=True) as run:
            inserted = run(
                """INSERT INTO aios_channel_event_dedup (tenant, channel_id, external_event_id, received_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT (tenant, channel_id, external_event_id) DO NOTHING""",
                (tenant, spec.channel_id, external_event_id, now),
            )
            deduplicated = inserted.rowcount != 1
            if not deduplicated:
                received_at = now
                self.workflow._audit(
                    run,
                    tenant,
                    f"channel:{spec.channel_id}",
                    external_event_id,
                    "CHANNEL_WEBHOOK_RECEIVED",
                )
            else:
                prior = run(
                    """SELECT received_at FROM aios_channel_event_dedup
                       WHERE tenant = ? AND channel_id = ? AND external_event_id = ?""",
                    (tenant, spec.channel_id, external_event_id),
                ).fetchone()
                received_at = float(prior["received_at"]) if prior is not None else now

        return UnifiedChannelEnvelope(
            channel_id=spec.channel_id,
            tenant=tenant,
            external_event_id=external_event_id,
            sender_handle=sender_handle,
            text_preview=text_preview,
            received_at=received_at,
            deduplicated=deduplicated,
        ).model_dump(mode="json")


def channel_routes(
    workflow: Workflow,
    authenticate,
    refresh_actor,
    governance=None,
    *,
    known_subject=None,
    allowed_tenants: Iterable[str] | None = None,
) -> APIRouter:
    service = ChannelService(
        workflow,
        governance=governance,
        known_subject=known_subject,
        allowed_tenants=allowed_tenants,
    )
    router = APIRouter(prefix="/v1/channels", tags=["Enterprise messaging channels"])

    def call(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except KeyError as error:
            raise HTTPException(404, "Channel or target not found") from error
        except PermissionError as error:
            if isinstance(error, ChannelPolicyViolation):
                raise HTTPException(
                    403,
                    {
                        "code": "CHANNEL_POLICY_VIOLATION",
                        "category": error.category,
                        "incident_id": error.incident_id,
                        "message": error.message,
                    },
                ) from error
            raise HTTPException(403, str(error)) from error
        except Conflict as error:
            raise HTTPException(409, str(error)) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    @router.get("/catalog")
    def get_catalog(actor: Actor = Depends(authenticate)):
        refresh_actor(actor)
        return {"items": service.catalog()}

    @router.get("/bindings")
    def get_bindings(
        actor: Actor = Depends(authenticate),
        scope: Literal["mine", "tenant"] = "mine",
        subject: Subject | None = None,
    ):
        current = refresh_actor(actor)
        return {"items": call(service.list_bindings, current, scope=scope, subject=subject)}

    @router.put("/bindings/{channel_id}")
    def put_binding(
        channel_id: Identifier,
        body: ChannelBindingUpdate,
        actor: Actor = Depends(authenticate),
    ):
        current = refresh_actor(actor)
        return call(service.upsert_binding, current, channel_id, body)

    @router.get("/outbound")
    def get_outbound(
        actor: Actor = Depends(authenticate),
        limit: Annotated[int, Query(ge=1, le=100)] = 30,
        channel_id: Identifier | None = None,
        scope: Literal["mine", "tenant"] = "mine",
    ):
        current = refresh_actor(actor)
        return {"items": call(service.list_outbound, current, limit=limit, channel_id=channel_id, scope=scope)}

    @router.post("/outbound", status_code=201)
    def post_outbound(body: ChannelOutboundRequest, actor: Actor = Depends(authenticate)):
        current = refresh_actor(actor)
        return call(service.send_outbound, current, body)

    @router.get("/webhooks/{channel_id}")
    def webhook_challenge(channel_id: Identifier, request: Request):
        try:
            return service.verify_get_challenge(channel_id, request)
        except KeyError as error:
            raise HTTPException(404, "Channel not found") from error

    @router.post("/webhooks/{channel_id}")
    async def webhook_ingress(channel_id: Identifier, request: Request):
        try:
            return await service.handle_post_webhook(channel_id, request)
        except KeyError as error:
            raise HTTPException(404, "Channel not found") from error

    return router
