"""Workspace Sandbox, Document Tools, and Controlled CUA Policy Engine for Theodic AIOS."""
from __future__ import annotations

from .cua_guard import (
    ActionTier,
    ConfirmationChallenge,
    ConfirmationRequiredError,
    CuaAuthorizationResult,
    CuaPolicyEngine,
    CuaPolicyViolation,
    MACOS_WORK_APP_ALLOWLIST,
    WINDOWS_WORK_APP_ALLOWLIST,
    WindowTarget,
    classify_action,
    inspect_untrusted_screen_text,
    redact_screen_text,
    redact_screen_text_detailed,
    sanitize_untrusted_screen_text,
)
from .document_tools import (
    build_docx_draft,
    build_pptx_draft,
    build_xlsx_draft,
    inspect_capabilities,
    parse_document,
    render_libreoffice_preview,
)
from .sandbox import SandboxViolationError, SensitivePathError, WorkspaceSandbox
from .server import EmergencyStopController, EmergencyStopError, WorkspaceMcpServer

__all__ = [
    "ActionTier",
    "ConfirmationChallenge",
    "ConfirmationRequiredError",
    "CuaAuthorizationResult",
    "CuaPolicyEngine",
    "CuaPolicyViolation",
    "EmergencyStopController",
    "EmergencyStopError",
    "MACOS_WORK_APP_ALLOWLIST",
    "SandboxViolationError",
    "SensitivePathError",
    "WINDOWS_WORK_APP_ALLOWLIST",
    "WindowTarget",
    "WorkspaceMcpServer",
    "WorkspaceSandbox",
    "build_docx_draft",
    "build_pptx_draft",
    "build_xlsx_draft",
    "classify_action",
    "inspect_capabilities",
    "inspect_untrusted_screen_text",
    "parse_document",
    "redact_screen_text",
    "redact_screen_text_detailed",
    "render_libreoffice_preview",
    "sanitize_untrusted_screen_text",
]
